/**
 * Kazanime backend — sources/samehadaku.js
 * Adapter Samehadaku (https://v2.samehadaku.how — domain sering berganti, atur lewat SAMEHADAKU_BASE_URL).
 * Pengganti Kuramanime (diblokir Cloudflare untuk bot ini): anime Jepang, Hardsub Indonesia.
 *
 * Diverifikasi langsung 2026-10-22 (fixture asli di server/test/fixtures/samehadaku-*.html):
 *   - robots.txt : "User-agent: * / Disallow: /wp-admin/ / Allow: /wp-admin/admin-ajax.php" → halaman
 *                  yang dipakai di sini diizinkan. Tidak ada halaman ToS/DMCA yang tertaut → verdict
 *                  "unknown": dulu diakses HANYA bila robots.txt terbaca & mengizinkan; sejak 23 Okt 2026
 *                  gerbang robots mengikuti SCRAPER_ROBOTS_MODE (default 'off').
 *   - Snapshot/fixture ini membuktikan halaman pernah berhasil diambil, bukan akses yang selalu tersedia.
 *     README mencatat Cloudflare dapat men-challenge request dari IP pusat data secara intermiten; status live
 *     harus dianggap belum pasti tanpa pemeriksaan baru. Backend tidak mengulang halaman konten yang di-challenge
 *     dan membuka circuit 30 menit agar fallback lain dipakai.
 *   - Server video publik pada snapshot ini ada di .east_player_option[data-embed]. Upstream juga
 *     menyediakan fallback `#server > ul > li > div` → POST `action=player_ajax` dengan tiga atribut
 *     data-post/data-nume/data-type yang memang hadir di markup. Fallback hanya dipakai bila embed
 *     publik tidak tersedia; nilai opaque tidak ditebak dan tidak ada halaman hoster yang di-fetch.
 *     Opsi "VIP" (berbayar, disabled) dilewati.
 *   - Gambar /wp-content/uploads bisa ditampilkan dari situs lain (200 tanpa/dengan Referer asing).
 *   - Jam di /jadwal-rilis/ = jam rilis Sub Indo di Samehadaku (WIB), bukan jam tayang Jepang
 *     (mis. Kikansha S2 terjadwal Kamis 03:15, episode 3 terbit Kamis 01:38 WIB).
 *
 * Path yang dipakai:
 *   /anime-terbaru/          → episode terbaru (latest)
 *   /?s=<q>                  → pencarian (kartu article.animepost)
 *   /anime/<slug>/           → detail + daftar episode
 *   <url episode dari detail>→ server embed + link download (URL episode TIDAK ditebak dari slug)
 *   /jadwal-rilis/           → jadwal rilis per hari (schedule)
 */
import { load } from 'cheerio';
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { applySubtitleEvidence, textShowsIndonesianSubtitle } from '../lib/subtitle-evidence.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import {
    absoluteUrl, cleanText, firstInt, fixStatus, normalizeQuality, parseDurationMinutes,
    parseFormat, parseScore10, parseStatus, parseYear, titleKey,
} from '../lib/text.js';

export const ID = 'samehadaku';
export const NAME = 'Samehadaku';

export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'allowed',
    tos: Object.freeze({
        url: null,
        reviewedAt: '2026-10-22',
        verdict: 'unknown',
        note: 'Tidak ada halaman ToS/DMCA yang tertaut dari situs. robots.txt hanya melarang /wp-admin/. '
            + 'Kebijakan: ToS "unknown" tidak melarang akses; gerbang robots mengikuti SCRAPER_ROBOTS_MODE. '
            + 'Klaim Sub Indo tetap butuh bukti per episode.',
    }),
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,118}$/;
const ANIME_PATH_RE = /^\/anime\/([a-z0-9][a-z0-9-]{0,118})\/?$/i;
const EPISODE_PATH_RE = /^\/([a-z0-9][a-z0-9-]*?)-episode-(\d{1,4})(?:-end|-tamat)?\/?$/i;
const DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const SEASON_WORDS = { winter: 'WINTER', spring: 'SPRING', summer: 'SUMMER', fall: 'FALL', autumn: 'FALL' };

/** "/anime/sasaki-to-pii-chan-season-2/" → "sasaki-to-pii-chan-season-2" */
export function animeSlugFromUrl(url, base) {
    try {
        const u = new URL(url, base);
        const m = ANIME_PATH_RE.exec(u.pathname);
        return m ? m[1].toLowerCase() : null;
    } catch {
        return null;
    }
}

/** URL episode → { slug, number } (slug episode bisa berbeda dari slug anime). */
export function episodeFromUrl(url, base) {
    try {
        const u = new URL(url, base);
        const m = EPISODE_PATH_RE.exec(u.pathname);
        return m ? { slug: m[1].toLowerCase(), number: Number.parseInt(m[2], 10) } : null;
    } catch {
        return null;
    }
}

/** Judul tanpa akhiran "Sub Indo" / "Subtitle Indonesia". */
function stripSubLabel(text) {
    return cleanText(String(text || '').replace(/\s*(?:sub(?:title)?\s*indo(?:nesia)?)\s*$/i, ''));
}

function imgSrc($img, base) {
    for (const attr of ['data-src', 'data-lazy-src', 'src']) {
        const v = $img.attr(attr);
        if (v && !v.startsWith('data:')) return absoluteUrl(v, base) || null;
    }
    return null;
}

/**
 * Kartu pencarian (article.animepost) → anime. Hanya tautan /anime/<slug>/ yang dipakai.
 * @param {import('cheerio').CheerioAPI} $
 */
export function parseSearchCards($, base) {
    const out = [];
    const seen = new Set();
    $('article.animepost').each((_, el) => {
        const card = $(el);
        const a = card.find('.animposx > a[href], a[href*="/anime/"]').first();
        const url = absoluteUrl(a.attr('href'), base);
        const slug = url ? animeSlugFromUrl(url, base) : null;
        if (!slug || seen.has(slug)) return;
        seen.add(slug);
        out.push({
            slug,
            url,
            title: cleanText(a.attr('title')) || cleanText(card.find('.data .title h2').first().text()),
            image: imgSrc(card.find('img').first(), base),
            format: parseFormat(card.find('.content-thumb .type').first().text()),
            status: parseStatus(card.find('.data .type').first().text()),
            score: parseScore10(card.find('.content-thumb .score').first().text()),
        });
    });
    return out;
}

/**
 * /anime-terbaru/ : daftar episode terbaru (.post-show li).
 * @param {import('cheerio').CheerioAPI} $
 */
export function parseLatestList($, base) {
    const out = [];
    const seen = new Set();
    $('.post-show li').each((_, el) => {
        const li = $(el);
        const titleLink = li.find('h2 a[href*="/anime/"]').first();
        const url = absoluteUrl(titleLink.attr('href'), base);
        const slug = url ? animeSlugFromUrl(url, base) : null;
        if (!slug || seen.has(slug)) return;
        seen.add(slug);
        const epLink = li.find('.thumb a[href]').first();
        const ep = episodeFromUrl(absoluteUrl(epLink.attr('href'), base), base);
        const epText = li.find('span').filter((__, s) => /episode/i.test($(s).text())).first().text();
        out.push({
            slug,
            url,
            title: cleanText(titleLink.text()) || cleanText(titleLink.attr('title')),
            image: imgSrc(li.find('.thumb img').first(), base),
            latestEpisode: firstInt(epText.replace(/^.*?episode/i, '')) || ep?.number || null,
            episodeUrl: epLink.attr('href') ? absoluteUrl(epLink.attr('href'), base) : null,
        });
    });
    return out;
}

/** Baris info "Label → Nilai" di halaman detail (span label lebar tetap + span nilai). */
function parseInfoRows($) {
    /** @type {Record<string, string>} */
    const info = {};
    $('main span').each((_, el) => {
        const label = $(el);
        if (!/\bw-28\b/.test(label.attr('class') || '')) return;
        const key = cleanText(label.text()).replace(/:\s*$/, '').toLowerCase();
        const value = cleanText(label.next('span').text());
        if (key && value && info[key] === undefined) info[key] = value;
    });
    return info;
}

/**
 * Daftar episode dari halaman detail: judul episode di <h4><a href=".../...-episode-N/">.
 * Hanya episode milik anime ini (judul atau slug episode cocok) — tautan anime lain di halaman diabaikan.
 */
function parseEpisodeRows($, base, { title, slug }) {
    const titleK = titleKey(title).slice(0, 14);
    const slugHead = slug.split('-').slice(0, 2).join('-');
    const byNumber = new Map();
    $('main h4 a[href]').each((_, el) => {
        const a = $(el);
        const url = absoluteUrl(a.attr('href'), base);
        const ep = url ? episodeFromUrl(url, base) : null;
        if (!ep || byNumber.has(ep.number)) return;
        const text = cleanText(a.text());
        const mine = (titleK && titleKey(text).startsWith(titleK)) || ep.slug.startsWith(slugHead);
        if (!mine) return;
        const released = cleanText(a.closest('h4').next('span').text());
        byNumber.set(ep.number, { number: ep.number, title: text || `${title} Episode ${ep.number}`, url, released });
    });
    return [...byNumber.values()].sort((x, y) => x.number - y.number);
}

/**
 * Halaman detail /anime/<slug>/. null bila markup tidak dikenali.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} base
 * @param {{slug: string}} ref
 */
export function parseAnimePage($, base, ref) {
    const title = stripSubLabel($('main h1').first().text());
    if (!title) return null;
    const info = parseInfoRows($);
    const episodes = parseEpisodeRows($, base, { title, slug: ref.slug });
    const latestEpisode = episodes.length ? episodes[episodes.length - 1].number : null;
    const status = fixStatus(parseStatus(info.status), latestEpisode);
    const seasonMatch = /\b(winter|spring|summer|fall|autumn)\b\s*(\d{4})?/i.exec(info.season || '');
    const synopsisBox = $('.entry-content-single').first().clone();
    synopsisBox.find('p').each((_, el) => {
        // Bukan sinopsis: "Tonton Juga : <tautan>", baris judul alternatif "[…] / […]", paragraf kosong
        const p = $(el);
        const t = cleanText(p.text());
        if (!t || /^(tonton|lihat|nonton) juga\b/i.test(t) || /^\[[^\]]*\](\s*\/\s*\[[^\]]*\])*$/.test(t)) p.remove();
    });
    const description = cleanText(synopsisBox.text());
    const genres = $('.entry-content-single').first().nextAll('div').first().find('a[href*="/genre/"]')
        .map((_, a) => cleanText($(a).text())).get().filter(Boolean);
    const scoreHtml = $('main').html() || '';
    const scoreMatch = /<span class="[^"]*font-extrabold[^"]*">\s*(\d+(?:\.\d+)?)\s*<\/span>/.exec(scoreHtml);
    const declared = firstInt(info['total episode'] || info.episodes || info.episode || '');
    const animeUrl = `${base}/anime/${ref.slug}/`;

    const anime = makeAnime({
        title,
        titleAlt: info.english || (info.synonyms || '').split(',')[0] || '',
        image: absoluteUrl($('meta[property="og:image"]').attr('content'), base) || imgSrc($('main img.anmsa').first(), base),
        description,
        episodes: declared || (status === 'COMPLETED' ? latestEpisode : null),
        latestEpisode,
        genres,
        score: scoreMatch ? parseScore10(scoreMatch[1]) : null,
        status,
        format: parseFormat(info.type || ''),
        year: parseYear(info.season || '') || parseYear(info.released || ''),
        season: seasonMatch ? SEASON_WORDS[seasonMatch[1].toLowerCase()] : null,
        country: 'JP',
        studios: (info.studio || '').split(',').map(cleanText).filter(Boolean),
        duration: parseDurationMinutes(info.duration || ''),
        slug: encodeSlug(ID, ref.slug),
        source: ID,
        url: animeUrl,
    });
    const episodeList = makeEpisodeList(episodes);
    return { anime, episodeList, japanese: info.japanese || '' };
}

/** Nilai data-embed (HTML iframe ter-escape) → URL src. */
function embedSrc(snippet, base) {
    const m = /<iframe[^>]+src=["']([^"']+)["']/i.exec(String(snippet || ''));
    return m ? absoluteUrl(m[1], base) : '';
}

/** Explicit AJAX values rendered by Samehadaku; do not infer or synthesize these IDs. */
export function parseAjaxServerOptions($) {
    const out = [];
    $('#server > ul > li > div').each((_, el) => {
        const item = $(el);
        if (item.hasClass('disabled') || item.closest('li').hasClass('disabled') || item.attr('aria-disabled') === 'true') return;
        const post = cleanText(item.attr('data-post'));
        const nume = cleanText(item.attr('data-nume'));
        const type = cleanText(item.attr('data-type'));
        if (!post || !nume || !type) return;
        out.push({ post, nume, type, label: cleanText(item.find('span').first().text()) });
    });
    return out;
}

/** Response dari player_ajax berupa HTML iframe; parse src saja, tanpa membuka link embed. */
export function parseAjaxEmbedResponse(body, base) {
    const raw = String(body || '');
    if (!raw) return '';
    const candidates = [raw];
    if (/&lt;\s*(?:iframe|video|source)\b/i.test(raw)) {
        candidates.push(load(`<textarea>${raw}</textarea>`)('textarea').text());
    }
    for (const html of candidates) {
        const $ = load(html);
        const src = $('iframe[src], video[src], video source[src], source[src]').first().attr('src')
            || /<iframe\b[^>]*\s+src\s*=\s*(["'])(.*?)\1/i.exec(html)?.[2]
            || /<source\b[^>]*\s+src\s*=\s*(["'])(.*?)\1/i.exec(html)?.[2]
            || '';
        const url = absoluteUrl(src, base);
        if (url) return url;
    }
    return '';
}

/**
 * Episode HTML: prefer public .east_player_option[data-embed]; retain explicit player_ajax metadata as fallback.
 * @param {import('cheerio').CheerioAPI} $
 */
export function parseEpisodePage($, base) {
    const servers = [];
    const seen = new Set();
    $('.east_player_option').each((_, el) => {
        const opt = $(el);
        if (opt.hasClass('disabled')) return;
        const url = embedSrc(opt.attr('data-embed'), base) || absoluteUrl(opt.attr('data-url'), base);
        if (!url || seen.has(url)) return;
        seen.add(url);
        // Bukti bahasa ditempel setelah halaman episode selesai di-parse (lihat akhir fungsi).
        servers.push({ name: cleanText(opt.find('span').first().text()) || `Server ${servers.length + 1}`, url, subtitleType: 'hard' });
    });
    const ajaxServers = parseAjaxServerOptions($);

    const downloads = [];
    $('.download-eps').each((_, box) => {
        let format = '';
        $(box).children().each((__, child) => {
            const node = $(child);
            const tag = String(child.name || '').toLowerCase();
            if (tag === 'p') format = (/(MKV|MP4|X265|HEVC)/i.exec(node.text()) || [])[1]?.toUpperCase() || format;
            if (tag !== 'ul') return;
            node.children('li').each((___, li) => {
                const row = $(li);
                const quality = normalizeQuality(row.find('strong').first().text());
                const links = row.find('a[href]').map((____, a) => ({
                    provider: cleanText($(a).text()) || 'Link',
                    url: absoluteUrl($(a).attr('href'), base),
                })).get().filter((l) => l.url);
                // Label diambil dari teks blok download; jangan mengarang "Sub Indo".
                const blockText = cleanText($(box).text());
                if (links.length) downloads.push({
                    quality, size: '', format, subtitle: textShowsIndonesianSubtitle(blockText) ? 'Sub Indo' : '', links,
                });
            });
        });
    });

    const rawTitle = $('main h1').first().text();
    const title = stripSubLabel(rawTitle);
    const animeLink = $('main a[href*="/anime/"]').filter((_, a) => Boolean(animeSlugFromUrl($(a).attr('href'), base))).first().attr('href');
    // Bukti Sub Indo dari halaman episode: judul, deskripsi episode, label server, atau label download.
    const evidence = applySubtitleEvidence(servers, {
        title: rawTitle,
        pageText: $('article .entry-content, article .entry-content-single').first().text(),
        labels: servers.map((server) => server.name),
        downloads,
    });
    return {
        title,
        servers: evidence.servers,
        subtitleEvidence: evidence.evidence,
        subtitleEvidenceDetail: evidence.detail,
        ajaxServers,
        downloads,
        animeUrl: animeLink ? absoluteUrl(animeLink, base) : null,
    };
}

/**
 * /jadwal-rilis/ : satu blok per hari (x-show="activeDay === 'monday'") berisi kartu anime + jam rilis.
 * @param {string} html  HTML mentah (blok hari ditandai lewat atribut Alpine.js, lebih andal dari selector)
 * @param {string} base
 * @returns {Record<number, {title: string, slug: string, url: string, image: string|null, time: string|null}[]>}
 */
export function parseSchedulePage(html, base) {
    const out = {};
    const text = String(html || '');
    const marks = [...text.matchAll(/x-show="activeDay === '([a-z]+)'"/g)];
    marks.forEach((m, i) => {
        const day = DAYS[m[1]];
        if (day === undefined) return;
        const chunk = text.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : m.index + 120000);
        const $ = load(`<div>${chunk.slice(chunk.indexOf('>') + 1)}</div>`);
        const items = [];
        const seen = new Set();
        $('.animepost').each((_, el) => {
            const card = $(el);
            const a = card.find('a[href*="/anime/"]').first();
            const url = absoluteUrl(a.attr('href'), base);
            const slug = url ? animeSlugFromUrl(url, base) : null;
            if (!slug || seen.has(slug)) return;
            seen.add(slug);
            const clock = /(\d{1,2})[:.](\d{2})/.exec(card.find('.ltseps').first().text());
            items.push({
                title: cleanText(a.attr('title')) || cleanText(card.find('h2').first().text()),
                slug,
                url,
                image: imgSrc(card.find('img').first(), base),
                time: clock && Number(clock[1]) < 24 && Number(clock[2]) < 60 ? `${clock[1].padStart(2, '0')}:${clock[2]}` : null,
            });
        });
        out[day] = items;
    });
    return out;
}

/**
 * @param {{network: any, createClient: Function, baseUrl: string}} deps
 */
export function createSamehadaku({ network, createClient, baseUrl, sourceConfig = {} }) {
    const base = String(baseUrl || 'https://v2.samehadaku.how').replace(/\/+$/, '');
    const host = new URL(base).hostname;
    const client = createClient(network, {
        source: ID,
        allowedHosts: [host],
        // ToS belum bisa ditinjau → dulu robots.txt wajib terbaca; kini mengikuti SCRAPER_ROBOTS_MODE.
        requireExplicitRobots: POLICY.tos.verdict !== 'allowed',
        // Baseline GitHub Actions (2026-10-22): homepage challenged. Don't repeat content requests;
        // back off 30 minutes and use other permitted sources as fallback.
        cookies: sourceConfig.cookiesEnabled ?? true,
        renderJavaScript: Boolean(sourceConfig.renderJavaScript),
        blockedMs: 30 * 60 * 1000,
    });

    const toAnime = (c, extra = {}) => makeAnime({
        title: c.title,
        image: c.image,
        latestEpisode: c.latestEpisode,
        status: c.status || (c.latestEpisode ? 'ONGOING' : 'UNKNOWN'),
        format: c.format,
        score: c.score,
        country: 'JP',
        slug: encodeSlug(ID, c.slug),
        source: ID,
        url: c.url,
        ...extra,
    });

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        country: 'JP',
        policy: POLICY,

        /** Bagian slug setelah "samehadaku~" → ref. */
        parseRef(parts) {
            const s = String(parts[0] || '').toLowerCase();
            return parts.length === 1 && SLUG_RE.test(s) ? { slug: s } : null;
        },

        titleHint(ref) {
            return ref.slug.replace(/-/g, ' ');
        },

        async latest(ctx = {}) {
            const page = await client.html(`${base}/anime-terbaru/`, ctx);
            const items = parseLatestList(page.$, base);
            if (!items.length) throw new SourceError('Struktur halaman Anime Terbaru Samehadaku berubah.', { kind: 'parse', source: ID });
            return items.map((c) => toAnime(c, { status: 'ONGOING' }));
        },

        async search(q, ctx = {}) {
            const url = new URL(`${base}/`);
            url.searchParams.set('s', q);
            const page = await client.html(url.href, ctx);
            return parseSearchCards(page.$, base).map((c) => toAnime(c));
        },

        async getAnime(ref, ctx = {}) {
            const page = await client.html(`${base}/anime/${ref.slug}/`, ctx);
            const parsed = parseAnimePage(page.$, base, ref);
            if (!parsed) throw new SourceError('Struktur halaman detail Samehadaku tidak dikenali.', { kind: 'parse', source: ID });
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
            let servers = parsed.servers;

            // Versi upstream tertentu merender server hanya sebagai atribut #server. Pakai POST
            // hanya bila embed publik tidak ditemukan; kirim tepat nilai yang ditulis markup, batasi
            // jumlah mirror, dan jangan fetch halaman hoster atau mengulang request yang diblokir.
            if (!servers.length && parsed.ajaxServers.length) {
                const ajaxUrl = new URL('/wp-admin/admin-ajax.php', base).href;
                for (const item of parsed.ajaxServers.slice(0, 6)) {
                    const body = new URLSearchParams({
                        action: 'player_ajax',
                        post: item.post,
                        nume: item.nume,
                        type: item.type,
                    }).toString();
                    const response = await client.request(ajaxUrl, {
                        ...ctx,
                        method: 'POST',
                        body,
                        accept: 'text/html,application/json,*/*;q=0.8',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            Origin: new URL(base).origin,
                            Referer: entry.url,
                        },
                    });
                    const url = parseAjaxEmbedResponse(response.text, base);
                    if (!url || servers.some((server) => server.url === url)) continue;
                    servers.push({
                        name: item.label || `Server ${servers.length + 1}`,
                        url,
                        // Bahasa hanya diklaim bila halaman episode memberi bukti (lihat parseEpisodePage).
                        ...(parsed.subtitleEvidence
                            ? { lang: 'id', subtitleType: 'hard', subtitleEvidence: parsed.subtitleEvidence }
                            : { subtitleType: 'hard' }),
                    });
                }
            }

            return makeEpisode({
                episode: ep,
                title: parsed.title || entry.title,
                released: entry.released,
                url: page.url,
                servers,
                downloads: parsed.downloads,
            });
        },

        /** Jadwal rilis Sub Indo per hari (0 = Minggu), jam WIB. */
        async schedule(ctx = {}) {
            const res = await client.request(`${base}/jadwal-rilis/`, ctx);
            const days = parseSchedulePage(res.text, base);
            const total = Object.values(days).reduce((n, d) => n + d.length, 0);
            if (!total) throw new SourceError('Struktur halaman Jadwal Rilis Samehadaku berubah.', { kind: 'parse', source: ID });
            const out = {};
            for (const [day, items] of Object.entries(days)) {
                out[day] = items.map((it) => ({
                    title: it.title,
                    time: it.time,
                    slug: encodeSlug(ID, it.slug),
                    url: it.url,
                    image: it.image,
                    country: 'JP',
                    source: ID,
                }));
            }
            return out;
        },
    };
}
