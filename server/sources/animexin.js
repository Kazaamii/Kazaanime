/**
 * Kazanime backend — sources/animexin.js
 * Adapter AnimeXin (https://animexin.dev) — situs donghua, tema WordPress "AnimeStream".
 * Diverifikasi langsung 2026-10-21 (fixture di server/test/fixtures/animexin-*.html).
 *
 * Halaman yang dipakai (semua diizinkan robots.txt: "User-agent: * / Disallow:" kosong):
 *   /                              → blok "Latest Release" (judul seri + episode terbaru)
 *   /anime/?order=update           → kartu seri (slug asli + status), digabung lewat rel=ID seri
 *   /?s=<kata kunci>               → pencarian seri
 *   /<slug-seri>/                  → detail + daftar SEMUA episode (.eplister)
 *   /<slug-episode>/               → server (select.mirror → iframe base64) + link download (.soraddlx)
 *   /schedule/                     → jadwal rilis donghua per hari (tanpa jam; dicek 2026-10-22)
 *   Poster pengganti: judul Mandarin dari halaman seri dipakai mencari poster di Bangumi (lihat metadata.js).
 *
 * Catatan gambar: file di /wp-content/uploads membalas 403 untuk akses langsung dan
 * mengirim "Cross-Origin-Resource-Policy: same-origin" → browser tidak akan menampilkan
 * gambar ini di situs lain. Karena itu `imagePolicy: 'blocked'`: aggregator mengganti
 * gambar dengan poster dari API metadata publik (Kitsu). TIDAK ada proxy/spoof Referer.
 */
import { load } from 'cheerio';
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { applySubtitleEvidence, textShowsIndonesianSubtitle } from '../lib/subtitle-evidence.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import {
    absoluteUrl, cleanText, clip, decodeBase64, firstInt, fixStatus, isDonationUrl, normalizeQuality,
    parseCountry, parseDurationMinutes, parseEpisodeNumber, parseFormat, parseScore10, parseStatus, parseYear,
} from '../lib/text.js';

export const ID = 'animexin';
export const NAME = 'AnimeXin';

/** Hasil peninjauan kebijakan situs (lihat juga `npm run check:sources`). */
export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'blocked',
    tos: Object.freeze({
        url: 'https://animexin.dev/dmca/',
        reviewedAt: '2026-10-21',
        verdict: 'allowed',
        note: 'Tidak ada halaman Terms of Service (/terms & /terms-of-service = 404). Halaman DMCA dan Privacy Policy '
            + 'tidak memuat larangan akses otomatis. robots.txt: "User-agent: * / Disallow:" (semua path diizinkan).',
    }),
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,118}$/;

/** URL seri "https://animexin.dev/<slug>/" → slug (null bila bukan URL satu-segmen di host yang sama). */
export function seriesSlugFromUrl(url, base) {
    try {
        const u = new URL(url, base);
        if (u.hostname.replace(/^www\./, '') !== new URL(base).hostname.replace(/^www\./, '')) return null;
        const segs = u.pathname.split('/').filter(Boolean);
        if (segs.length !== 1) return null;
        const s = decodeURIComponent(segs[0]).toLowerCase();
        return SLUG_RE.test(s) ? s : null;
    } catch {
        return null;
    }
}

/** URL di halaman jadwal: "/<slug>/" atau "/anime/<slug>/" (keduanya halaman seri yang sama) → slug. */
export function scheduleSlugFromUrl(url, base) {
    try {
        const u = new URL(url, base);
        if (u.hostname.replace(/^www\./, '') !== new URL(base).hostname.replace(/^www\./, '')) return null;
        const segs = u.pathname.split('/').filter(Boolean);
        const s = segs.length === 1 ? segs[0] : segs.length === 2 && segs[0] === 'anime' ? segs[1] : '';
        const slug = decodeURIComponent(s).toLowerCase();
        return SLUG_RE.test(slug) ? slug : null;
    } catch {
        return null;
    }
}

const SCHEDULE_DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/**
 * /schedule/ : blok .listSchh per hari (h2 "Monday" …) berisi tautan seri. Tanpa jam rilis.
 * @param {import('cheerio').CheerioAPI} $
 * @returns {Record<number, {title: string, slug: string, url: string}[]>}
 */
export function parseSchedulePage($, base) {
    const out = {};
    $('.listSchh').each((_, el) => {
        const box = $(el);
        const day = SCHEDULE_DAYS[cleanText(box.find('h2').first().text()).toLowerCase()];
        if (day === undefined) return;
        const seen = new Set();
        const items = [];
        box.find('.subSchh a[href]').each((__, a) => {
            const url = absoluteUrl($(a).attr('href'), base);
            const slug = url ? scheduleSlugFromUrl(url, base) : null;
            if (!slug || seen.has(slug)) return;
            seen.add(slug);
            items.push({ title: cleanText($(a).text()), slug, url });
        });
        out[day] = items;
    });
    return out;
}

/** Slug seri ditebak dari URL episode: "...-season-10-episode-34-466-indonesia-english-sub/" → "...-season-10". */
export function deriveSeriesSlug(episodeUrl, base) {
    const s = seriesSlugFromUrl(episodeUrl, base);
    if (!s) return null;
    const d = s.replace(/-episode-\d+.*$/, '');
    return d && d !== s && SLUG_RE.test(d) ? d : null;
}

function imgSrc($img, base) {
    for (const attr of ['data-src', 'data-lazy-src', 'src']) {
        const v = $img.attr(attr);
        if (v && !v.startsWith('data:')) {
            const u = absoluteUrl(v, base);
            if (u) return u;
        }
    }
    return null;
}

/**
 * Blok "Latest Release" di beranda.
 * @returns {{seriesId: string|null, title: string, latestEpisode: number|null, format: string, image: string|null, episodeUrl: string}[]}
 */
export function parseLatestHome($, base) {
    let scope = $('.releases.latesthome').first().closest('.bixbox');
    if (!scope.length) scope = $.root();
    const out = [];
    scope.find('article.bs').each((_, el) => {
        const card = $(el);
        const a = card.find('.bsx > a, a').first();
        const episodeUrl = absoluteUrl(a.attr('href'), base);
        if (!episodeUrl) return;
        const headline = cleanText(card.find('.tt h2').first().text()) || cleanText(a.attr('title'));
        const title = cleanText(card.find('.eggtitle').first().text()) || headline.replace(/\s+Episode\s+\d+.*$/i, '');
        const epLabel = cleanText(card.find('.eggepisode').first().text()) || headline;
        if (!title) return;
        out.push({
            seriesId: cleanText(a.attr('rel')) || null,
            title,
            latestEpisode: parseEpisodeNumber(epLabel),
            format: parseFormat(card.find('.eggtype, .typez').first().text()),
            image: imgSrc(card.find('img').first(), base),
            episodeUrl,
        });
    });
    return out;
}

/**
 * Kartu seri di halaman daftar (/anime/) & hasil pencarian (/?s=).
 * @returns {{seriesId: string|null, slug: string, url: string, title: string, statusText: string, latestEpisode: number|null, format: string, image: string|null}[]}
 */
export function parseSeriesCards($, base) {
    const out = [];
    $('.listupd article.bs').each((_, el) => {
        const card = $(el);
        const a = card.find('.bsx > a, a').first();
        const url = absoluteUrl(a.attr('href'), base);
        const slug = url ? seriesSlugFromUrl(url, base) : null;
        if (!slug) return;
        const epx = cleanText(card.find('.epx').first().text());
        out.push({
            seriesId: cleanText(a.attr('rel')) || null,
            slug,
            url,
            title: cleanText(card.find('.tt h2').first().text()) || cleanText(a.attr('title')),
            statusText: epx || cleanText(card.find('.status').first().text()),
            latestEpisode: /\bep/i.test(epx) ? parseEpisodeNumber(epx) : null,
            format: parseFormat(card.find('.typez').first().text()),
            image: imgSrc(card.find('img').first(), base),
        });
    });
    return out;
}

/** Banyak seri hanya berisi kalimat SEO ("Judul Subtitle Indonesia, English, Portuguese, ...") → bukan sinopsis. */
function cleanSynopsis(text) {
    const t = cleanText(text);
    if (!t) return '';
    const boiler = /subtitle\s+indonesia\s*,\s*english/i.test(t) || /^watch streaming\b/i.test(t);
    return boiler && t.length < 400 ? '' : t;
}

/**
 * Halaman seri. null bila halaman ini BUKAN halaman seri (mis. halaman episode).
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} base
 * @param {string} seriesSlug slug situs (tanpa prefix sumber)
 */
export function parseSeriesPage($, base, seriesSlug) {
    const root = $('.bigcontent').first();
    if (!root.length && !$('.eplister').length) return null;
    const scope = root.length ? root : $.root();
    const title = cleanText(scope.find('h1.entry-title').first().text());
    if (!title) return null;

    /** @type {Record<string, string>} */
    const spe = {};
    /** @type {Record<string, string[]>} */
    const speLinks = {};
    scope.find('.spe > span').each((_, s) => {
        const span = $(s);
        const label = cleanText(span.find('b').first().text()).replace(/:\s*$/, '').toLowerCase();
        if (!label || spe[label] !== undefined) return;
        const clone = span.clone();
        clone.find('b').first().remove();
        spe[label] = cleanText(clone.text());
        const links = span.find('a').map((__, x) => cleanText($(x).text())).get().filter(Boolean);
        if (links.length) speLinks[label] = links;
    });

    const rawEpisodes = [];
    $('.eplister ul li a').each((_, el) => {
        const a = $(el);
        const number = parseEpisodeNumber(a.find('.epl-num').first().text());
        const url = absoluteUrl(a.attr('href'), base);
        if (!number || !url) return;
        rawEpisodes.push({
            number,
            title: cleanText(a.find('.epl-title').first().text()),
            released: cleanText(a.find('.epl-date').first().text()),
            url,
        });
    });
    const episodeList = makeEpisodeList(rawEpisodes);
    const latestEpisode = episodeList.length ? episodeList[episodeList.length - 1].number : null;
    const status = fixStatus(parseStatus(spe.status), latestEpisode);
    const declared = firstInt(spe.episodes || spe.episode || '');
    const slug = encodeSlug(ID, seriesSlug);

    const anime = makeAnime({
        title,
        titleAlt: cleanText(scope.find('.alter').first().text()),
        image: imgSrc(scope.find('.thumb img').first(), base) || $('meta[property="og:image"]').attr('content'),
        description: cleanSynopsis($('.bixbox.synp .entry-content, .entry-content[itemprop="description"]').first().text()),
        episodes: declared || (status === 'COMPLETED' ? latestEpisode : null),
        latestEpisode,
        genres: scope.find('.genxed a').map((_, x) => cleanText($(x).text())).get(),
        score: parseScore10(scope.find('.rating strong').first().text()),
        status,
        format: parseFormat(spe.type),
        year: parseYear(spe.released || spe['released on'] || ''),
        country: parseCountry(spe.country) || 'CN',
        studios: speLinks.studio || (spe.studio ? spe.studio.split(',') : []),
        duration: parseDurationMinutes(spe.duration),
        slug,
        source: ID,
        url: `${base}/${seriesSlug}/`,
    });
    return { anime, episodeList };
}

const HOSTS = [
    [/dailymotion\.com$|dai\.ly$/, 'Dailymotion'],
    [/ok\.ru$/, 'OK.ru'],
    [/odysee\.com$/, 'Odysee'],
    [/rumble\.com$/, 'Rumble'],
    [/mega\.nz$/, 'Mega'],
    [/d\.tube$/, 'DTube'],
    [/streamwish|seekplayer|wishembed/, 'Streamwish'],
    [/dood|playmogo|ds2play/, 'Doodstream'],
    [/youtube\.com$|youtu\.be$/, 'YouTube'],
    [/drive\.google\.com$/, 'Google Drive'],
    [/filemoon/, 'Filemoon'],
    [/streamtape/, 'Streamtape'],
    [/vidhide|filelions/, 'Vidhide'],
];
const LANG_TAG = { id: 'Sub Indo', en: 'Sub English', multi: 'Multi Sub' };
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Label opsi mirror → nama server yang rapi + bahasa dan jenis subtitle bila tertulis eksplisit.
 * "Hardsub Indonesia Dailymotion AX" → { name: "Dailymotion (Sub Indo)", lang: "id", subtitleType: "hard" }
 */
export function describeServer(label, url) {
    const lang = /indo/i.test(label) ? 'id' : /\beng(lish)?\b/i.test(label) ? 'en' : /all\s*sub|multi/i.test(label) ? 'multi' : null;
    const subtitleType = /\bhard[\s-]*sub\b/i.test(label) ? 'hard' : /\bsoft[\s-]*sub\b/i.test(label) ? 'soft' : null;
    let host = '';
    try { host = new URL(url).hostname.replace(/^(www|geo|play)\./, ''); } catch { /* biarkan kosong */ }
    const known = HOSTS.find(([re]) => re.test(host))?.[1] || '';
    let provider = cleanText(String(label || '').replace(/\b(hard[\s-]*sub|soft[\s-]*sub|player|server|ax|indonesia|indo|english|eng|all[\s-]*sub|sub|hd)\b/gi, ' '));
    if (!provider || provider.length > 24) provider = known || host || 'Server';
    else if (known && squash(provider) === squash(known)) provider = known;
    return {
        name: LANG_TAG[lang] ? `${provider} (${LANG_TAG[lang]})` : provider,
        lang,
        ...(subtitleType ? { subtitleType } : {}),
    };
}

function iframeSrc(snippet) {
    const $f = load(snippet);
    return $f('iframe[src]').first().attr('src')
        || $f('source[src]').first().attr('src')
        || $f('meta[itemprop="embedUrl"][content]').first().attr('content')
        || '';
}

/**
 * Nilai mirror bisa berupa HTML Base64 (iframe/source/meta) atau URL HTTP(S) langsung.
 * URL eksternal tidak di-fetch atau di-resolve di sini; pemutar menerima link yang
 * memang tercantum di markup AnimeXin dan tidak membuka request tambahan ke hoster.
 */
function mirrorUrl(value, base) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const decoded = decodeBase64(raw);
    const payload = decoded || raw;
    const direct = /^(?:https?:)?\/\//i.test(payload) ? absoluteUrl(payload, base) : '';
    if (direct && !/[<>]/.test(payload)) return direct;
    if (!/<(?:iframe|source|meta)\b/i.test(payload)) return '';
    return absoluteUrl(iframeSrc(payload), base);
}

/**
 * Halaman episode: mirror dari select.mirror / ul.mirror + server default,
 * link download, dan tautan ke seri.
 */
export function parseEpisodePage($, base) {
    const servers = [];
    const seen = new Set();
    const addServer = (label, value) => {
        const url = mirrorUrl(value, base);
        if (!url || seen.has(url)) return;
        seen.add(url);
        servers.push({ ...describeServer(cleanText(label), url), url });
    };
    $('select.mirror > option[data-index], select.mirror > option[value]').each((_, el) => {
        const o = $(el);
        addServer(o.text(), o.attr('value'));
    });
    $('ul.mirror a[data-em]').each((_, el) => {
        const a = $(el);
        addServer(a.text(), a.attr('data-em'));
    });
    const def = absoluteUrl($('#pembed iframe, .player-embed iframe').first().attr('src'), base);
    if (def && !seen.has(def)) {
        seen.add(def);
        servers.unshift({ ...describeServer('', def), url: def });
    }

    const downloads = [];
    $('.soraddlx').each((_, g) => {
        const group = $(g);
        const head = cleanText(group.find('.sorattlx').first().text());
        if (/vip|member|donat|premium|support/i.test(head)) return; // bukan link download
        const subtitle = /indo/i.test(head) ? 'Sub Indo' : /eng/i.test(head) ? 'Sub English' : clip(head.replace(/^subtitle\s+/i, 'Sub '), 20);
        group.find('.soraurlx').each((__, row) => {
            const r = $(row);
            const links = r.find('a[href]')
                .map((___, a) => ({ provider: cleanText($(a).text()), url: absoluteUrl($(a).attr('href'), base) }))
                .get()
                .filter((l) => l.url && !isDonationUrl(l.url));
            if (!links.length) return;
            const format = links.some((l) => /\.mkv\b/i.test(l.url)) ? 'MKV' : links.some((l) => /\.mp4\b/i.test(l.url)) ? 'MP4' : '';
            downloads.push({ quality: normalizeQuality(r.find('strong').first().text()), size: '', format, subtitle, links });
        });
    });
    // Untuk grup unduhan, Sub Indo didahulukan bila tersedia (urutan stabil).
    downloads.sort((a, b) => (a.subtitle === 'Sub Indo' ? 0 : 1) - (b.subtitle === 'Sub Indo' ? 0 : 1));

    const title = cleanText($('h1.entry-title').first().text());
    // Label mirror ("Hardsub Indonesia") sudah jadi bukti per server; sisanya memakai bukti halaman.
    const labeled = servers.map((server) => (server.lang === 'id' ? { ...server, subtitleEvidence: 'server-label' } : server));
    // Label mirror sudah per server; bukti halaman memakai judul + label download (tanpa nama server,
    // supaya server Sub English tidak ikut dianggap bukti).
    const evidence = applySubtitleEvidence(labeled, { title, downloads });
    return {
        title,
        servers: evidence.servers,
        subtitleEvidence: evidence.evidence,
        subtitleEvidenceDetail: evidence.detail,
        downloads,
        seriesUrl: absoluteUrl($('.naveps .nvsc a').first().attr('href'), base),
    };
}

/**
 * @param {{network: any, createClient: Function, baseUrl: string}} deps
 */
export function createAnimexin({ network, createClient, baseUrl }) {
    const base = String(baseUrl || 'https://animexin.dev').replace(/\/+$/, '');
    const host = new URL(base).hostname.replace(/^www\./, '');
    // Challenge/access restriction selalu fail-fast; cooldown memberi ruang untuk fallback tanpa melewati WAF.
    const client = createClient(network, { source: ID, allowedHosts: [host, `www.${host}`], blockedMs: 5 * 60 * 1000 });

    async function loadSeries(seriesSlug, ctx) {
        const page = await client.html(`${base}/${seriesSlug}/`, ctx);
        return { page, parsed: parseSeriesPage(page.$, base, seriesSlug) };
    }

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        country: 'CN',
        policy: POLICY,

        /** Bagian slug setelah "animexin~" → ref. */
        parseRef(parts) {
            const s = String(parts[0] || '').toLowerCase();
            return parts.length === 1 && SLUG_RE.test(s) ? { slug: s } : null;
        },

        /** Judul perkiraan dari slug (untuk fallback metadata bila situs gagal). */
        titleHint(ref) {
            return ref.slug.replace(/-episode-\d+.*$/, '').replace(/-/g, ' ');
        },

        async latest(ctx = {}) {
            const [home, list] = await Promise.allSettled([
                client.html(`${base}/`, ctx),
                client.html(`${base}/anime/?status=&type=&order=update`, ctx),
            ]);
            if (home.status === 'rejected') throw home.reason;
            const latest = parseLatestHome(home.value.$, base);
            if (!latest.length) throw new SourceError('Struktur beranda AnimeXin berubah (blok Latest Release kosong).', { kind: 'parse', source: ID });
            const cards = list.status === 'fulfilled' ? parseSeriesCards(list.value.$, base) : [];
            const byId = new Map(cards.filter((c) => c.seriesId).map((c) => [c.seriesId, c]));

            const seen = new Set();
            const items = [];
            for (const it of latest) {
                const card = it.seriesId ? byId.get(it.seriesId) : null;
                const slug = card?.slug || deriveSeriesSlug(it.episodeUrl, base);
                if (!slug || seen.has(slug)) continue;
                seen.add(slug);
                items.push(makeAnime({
                    title: it.title || card?.title,
                    image: it.image || card?.image,
                    latestEpisode: it.latestEpisode,
                    format: it.format || card?.format,
                    status: fixStatus(card ? parseStatus(card.statusText) : 'ONGOING', it.latestEpisode),
                    country: 'CN',
                    slug: encodeSlug(ID, slug),
                    source: ID,
                    url: card?.url || `${base}/${slug}/`,
                }));
            }
            return items;
        },

        async search(q, ctx = {}) {
            const url = new URL(`${base}/`);
            url.searchParams.set('s', q);
            const page = await client.html(url.href, ctx);
            return parseSeriesCards(page.$, base).map((c) => makeAnime({
                title: c.title,
                image: c.image,
                latestEpisode: c.latestEpisode,
                status: parseStatus(c.statusText),
                format: c.format,
                country: 'CN',
                slug: encodeSlug(ID, c.slug),
                source: ID,
                url: c.url,
            }));
        },

        async getAnime(ref, ctx = {}) {
            let { page, parsed } = await loadSeries(ref.slug, ctx);
            if (!parsed) {
                // Slug ternyata halaman episode → ikuti tautan "All Episodes" ke halaman seri.
                const ep = parseEpisodePage(page.$, base);
                const seriesSlug = ep.seriesUrl ? seriesSlugFromUrl(ep.seriesUrl, base) : null;
                if (seriesSlug && seriesSlug !== ref.slug) ({ parsed } = await loadSeries(seriesSlug, ctx));
            }
            if (!parsed) throw new SourceError('Struktur halaman seri AnimeXin tidak dikenali.', { kind: 'parse', source: ID });
            return { ...parsed.anime, episodeList: parsed.episodeList };
        },

        /**
         * @param {{slug: string}} ref
         * @param {number} ep
         * @param {{anime?: {episodeList?: {number: number, url: string|null, title: string, released: string}[]}}} ctx
         */
        async getEpisode(ref, ep, ctx = {}) {
            const entry = (ctx.anime?.episodeList || []).find((e) => e.number === ep);
            if (!entry?.url) throw notFound(`Episode ${ep} belum tersedia di ${NAME}.`, ID);
            const page = await client.html(entry.url, ctx);
            const parsed = parseEpisodePage(page.$, base);
            return makeEpisode({
                episode: ep,
                title: parsed.title || entry.title,
                released: entry.released,
                url: page.url,
                servers: parsed.servers,
                downloads: parsed.downloads,
            });
        },

        /** Jadwal rilis donghua per hari (0 = Minggu). AnimeXin tidak mencantumkan jam → time: null. */
        async schedule(ctx = {}) {
            const page = await client.html(`${base}/schedule/`, ctx);
            const days = parseSchedulePage(page.$, base);
            const total = Object.values(days).reduce((n, d) => n + d.length, 0);
            if (!total) throw new SourceError('Struktur halaman Schedule AnimeXin berubah.', { kind: 'parse', source: ID });
            const out = {};
            for (const [day, items] of Object.entries(days)) {
                out[day] = items.map((it) => ({
                    title: it.title,
                    time: null,
                    slug: encodeSlug(ID, it.slug),
                    url: it.url,
                    image: null,
                    country: 'CN',
                    source: ID,
                }));
            }
            return out;
        },
    };
}
