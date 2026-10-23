/**
 * Kazanime backend — sources/kuramanime.js
 * Adapter Kuramanime (default https://v9.kuramanime.work; pilih domain per deployment lewat KURAMANIME_BASE_URL).
 * Server streaming berlabel Indonesia diklasifikasikan Hardsub; label Hardsub/Softsub pada unduhan
 * tetap dibaca per grup, karena sumber dapat menawarkan kedua format unduhan.
 *
 * STATUS 2026-10-21/22: baseline v20 TIDAK BISA DIVERIFIKASI LANGSUNG.
 *   Baseline v20 lama: URL termasuk /robots.txt membalas Cloudflare 403 untuk bot ini
 *   ("Sorry, you have been blocked" / "Attention Required!"); status mencerminkan blokir IP/WAF.
 *   Pengguna memilih v9.kuramanime.work sebagai domain yang ingin diuji. robots.txt/ToS masih harus
 *   lolos pemeriksaan saat runtime. Pilih tepat satu domain lewat KURAMANIME_BASE_URL; tidak ada
 *   failover/rotasi domain dan blokir tetap dihormati.
 *   Scraper open-source lain mencatat situs ini memeriksa header Sec-Fetch-*, fingerprint TLS,
 *   dan memakai token anti-bot berlapis untuk player. Semua itu adalah proteksi akses →
 *   adapter ini TIDAK mencoba melewatinya. Hasilnya: robots.txt tidak terbaca → sumber
 *   ditandai "blocked" → otomatis dilewati, aggregator memakai sumber lain / metadata.
 *
 *   Parser di bawah mengikuti markup publik Kuramanime yang terdokumentasi (tema "anime__details",
 *   "product__item", #episodeLists, #animeDownloadLink) dan diuji dengan fixture SINTETIS
 *   (server/test/fixtures/kuramanime-*.html). Bila suatu saat bot diizinkan (mis. pemilik situs
 *   meng-allowlist User-Agent ini), adapter langsung bekerja tanpa perubahan frontend.
 *
 * Path yang dipakai:
 *   /anime?order_by=updated&page=1          → update terbaru
 *   /anime?order_by=latest&search=<q>       → pencarian
 *   /anime/<id>/<slug>                      → detail + daftar episode (#episodeLists[data-content])
 *   /anime/<id>/<slug>/episode/<n>          → halaman episode (iframe/source publik + #animeDownloadLink)
 */
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import {
    absoluteUrl, cleanText, firstInt, fixStatus, normalizeQuality, parseCountry, parseDurationMinutes,
    parseEpisodeNumber, parseFormat, parseScore10, parseStatus, parseTotalEpisodes, parseYear,
} from '../lib/text.js';

export const ID = 'kuramanime';
export const NAME = 'Kuramanime';

export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'unknown',
    tos: Object.freeze({
        url: null,
        reviewedAt: '2026-10-21',
        verdict: 'unknown',
        note: 'Halaman ToS/robots.txt tidak bisa dibuka (Cloudflare 403 untuk bot). Kebijakan: sumber dengan ToS '
            + '"unknown" hanya diakses bila robots.txt terbaca DAN mengizinkan (requireExplicitRobots).',
    }),
});

const ID_RE = /^\d{1,9}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,118}$/;
const ANIME_PATH_RE = /\/anime\/(\d{1,9})\/([a-z0-9][a-z0-9-]{0,118})\/?$/i;

function bgImage($el, base) {
    const v = $el.attr('data-setbg') || (/url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec($el.attr('style') || '') || [])[1];
    return absoluteUrl(v, base) || null;
}

function imgSrc($img, base) {
    for (const attr of ['data-src', 'src']) {
        const v = $img.attr(attr);
        if (v && !v.startsWith('data:')) return absoluteUrl(v, base) || null;
    }
    return null;
}

/** "/anime/2468/sousou-no-frieren" → { id: "2468", slug: "sousou-no-frieren" } */
export function animeRefFromUrl(url, base) {
    try {
        const u = new URL(url, base);
        const m = ANIME_PATH_RE.exec(u.pathname);
        return m ? { id: m[1], slug: m[2].toLowerCase() } : null;
    } catch {
        return null;
    }
}

/**
 * Kartu anime (.product__item) di halaman daftar / pencarian.
 */
export function parseCards($, base) {
    const out = [];
    let items = $('#animeList .product__item');
    if (!items.length) items = $('.product__item');
    items.each((_, el) => {
        const card = $(el);
        const a = card.find('.product__item__text h5 a, h5 a').first();
        const url = absoluteUrl(a.attr('href'), base);
        const ref = url ? animeRefFromUrl(url, base) : null;
        if (!ref) return;
        const epText = cleanText(card.find('.ep').first().text()); // "Ep 5 / 12"
        const latestEpisode = parseEpisodeNumber(epText);
        const episodes = parseTotalEpisodes(epText);
        const status = episodes && latestEpisode && latestEpisode >= episodes ? 'COMPLETED' : latestEpisode ? 'ONGOING' : 'UNKNOWN';
        out.push({
            ...ref,
            url,
            title: cleanText(a.text()),
            image: bgImage(card.find('.product__item__pic').first(), base) || imgSrc(card.find('img').first(), base),
            latestEpisode,
            episodes,
            status,
            format: parseFormat(card.find('.product__item__text ul li, .type').first().text()),
        });
    });
    return out;
}

/**
 * Baris info detail. Mendukung dua varian markup:
 *   <li><div class="row"><div class="col-3"><span>Tipe:</span></div><div class="col-9">TV</div></div></li>
 *   <li><span>Tipe:</span> TV</li>
 */
function parseWidget($, box) {
    /** @type {Record<string, string>} */
    const values = {};
    /** @type {Record<string, string[]>} */
    const links = {};
    box.find('.anime__details__widget li').each((_, li) => {
        const row = $(li);
        const cols = row.find('.row > div');
        let label;
        let valueEl;
        if (cols.length >= 2) {
            label = cleanText($(cols[0]).text());
            valueEl = $(cols[1]);
        } else {
            label = cleanText(row.find('span').first().text());
            valueEl = row.clone();
            valueEl.find('span').first().remove();
        }
        label = label.replace(/:\s*$/, '').toLowerCase();
        if (!label || values[label] !== undefined) return;
        values[label] = cleanText(valueEl.text());
        const as = valueEl.find('a').map((__, x) => cleanText($(x).text()).replace(/,\s*$/, '')).get().filter(Boolean);
        if (as.length) links[label] = as;
    });
    return { values, links };
}

/** Nomor episode dari #episodeLists[data-content] (markup ter-escape) + tautan episode biasa. */
function parseEpisodeNumbers($) {
    const numbers = new Set();
    const raw = $('#episodeLists').attr('data-content') || '';
    for (const m of raw.matchAll(/\/episode\/(\d{1,4})\b/g)) numbers.add(Number.parseInt(m[1], 10));
    $('a[href*="/episode/"]').each((_, a) => {
        const m = /\/episode\/(\d{1,4})\/?(?:[?#]|$)/.exec($(a).attr('href') || '');
        if (m) numbers.add(Number.parseInt(m[1], 10));
    });
    return [...numbers].filter((n) => n >= 1).sort((a, b) => a - b);
}

/**
 * Halaman detail anime. null bila markup tidak dikenali.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} base
 * @param {{id: string, slug: string}} ref
 */
export function parseDetail($, base, ref) {
    const box = $('.anime__details__content').first();
    if (!box.length) return null;
    const title = cleanText(box.find('.anime__details__title h3').first().text());
    if (!title) return null;
    const titleAlt = box.find('.anime__details__title span').map((_, s) => cleanText($(s).text())).get().find(Boolean) || '';
    const pic = box.find('.anime__details__pic').first();
    const { values, links } = parseWidget($, box);
    const numbers = parseEpisodeNumbers($);
    const latestEpisode = numbers.length ? numbers[numbers.length - 1] : null;
    const status = fixStatus(parseStatus(values.status), latestEpisode);
    const declared = firstInt(values.episode || values['total episode'] || '');
    const animeUrl = `${base}/anime/${ref.id}/${ref.slug}`;

    const anime = makeAnime({
        title,
        titleAlt,
        image: bgImage(pic, base) || imgSrc(pic.find('img').first(), base),
        description: cleanText($('#synopsisField').first().text()) || cleanText(box.find('.anime__details__text p').first().text()),
        episodes: declared || (status === 'COMPLETED' ? latestEpisode : null),
        latestEpisode,
        genres: links.genre || (values.genre ? values.genre.split(',') : []),
        score: parseScore10(values.skor || values.score || ''),
        status,
        format: parseFormat(values.tipe || values.type || ''),
        year: parseYear(values.tayang || values.musim || ''),
        country: parseCountry(values.negara || '') || null,
        studios: links.studio || (values.studio ? values.studio.split(',') : []),
        duration: parseDurationMinutes(values.durasi || ''),
        slug: encodeSlug(ID, ref.id, ref.slug),
        source: ID,
        url: animeUrl,
    });
    const episodeList = makeEpisodeList(numbers.map((n) => ({ number: n, title: `${title} Episode ${n}`, url: `${animeUrl}/episode/${n}` })));
    return { anime, episodeList };
}

/**
 * #animeDownloadLink: deretan <h6>"MKV 480p (Softsub) — (147.85 MB)"</h6> diikuti <a> tautannya.
 * Tautan non-aktif (class link-disabled / tanpa href) dilewati.
 */
export function parseDownloads($, base) {
    const out = [];
    const box = $('#animeDownloadLink').first();
    if (!box.length) return out;
    let current = null;
    box.children().each((_, el) => {
        const node = $(el);
        const tag = String(el.name || '').toLowerCase();
        if (tag === 'h6') {
            const heading = cleanText(node.text());
            const size = (/\(\s*([\d.,]+\s*[KMG]i?B)\s*\)/i.exec(heading) || [])[1] || '';
            const format = ((/^(MKV|MP4|X265|HEVC)/i.exec(heading) || [])[1] || '').toUpperCase();
            const subtitle = /softsub/i.test(heading) ? 'Softsub Indo' : /hardsub/i.test(heading) ? 'Hardsub Indo' : 'Sub Indo';
            current = { quality: normalizeQuality(heading.replace(/\([^)]*\)/g, ' ')), size, format, subtitle, links: [] };
            out.push(current);
        } else if (tag === 'a' && current) {
            const url = absoluteUrl(node.attr('href'), base);
            if (url && !node.hasClass('link-disabled')) current.links.push({ provider: cleanText(node.text()), url });
        }
    });
    return out.filter((g) => g.links.length);
}

/**
 * Halaman episode. Player Kuramanime normalnya dimuat lewat token anti-bot (atribut data-kk);
 * yang diambil HANYA iframe/source yang sudah ada di HTML publik.
 */
export function parseEpisodePage($, base) {
    const servers = [];
    $('#player iframe, .player iframe, #animeVideoPlayer iframe').each((_, f) => {
        const url = absoluteUrl($(f).attr('src') || $(f).attr('data-src'), base);
        if (url) servers.push({ name: 'Kuramanime', url, lang: 'id', subtitleType: 'hard' });
    });
    $('#player source, video#player source').each((_, s) => {
        const url = absoluteUrl($(s).attr('src'), base);
        const size = $(s).attr('size');
        if (url && !/\.m3u8(\?|$)/i.test(url)) servers.push({ name: `Kuramadrive${size ? ` ${size}p` : ''}`, url, lang: 'id', subtitleType: 'hard' });
    });
    return {
        title: cleanText($('#episodeTitle').first().text()) || cleanText($('h1').first().text()),
        servers,
        downloads: parseDownloads($, base),
        protectedPlayer: !servers.length && $('[data-kk]').length > 0,
    };
}

/**
 * @param {{network: any, createClient: Function, baseUrl: string}} deps
 */
export function createKuramanime({ network, createClient, baseUrl, sourceConfig = {} }) {
    const base = String(baseUrl || 'https://v9.kuramanime.work').replace(/\/+$/, '');
    const host = new URL(base).hostname;
    const client = createClient(network, {
        source: ID,
        allowedHosts: [host],
        // ToS belum bisa ditinjau → robots.txt WAJIB terbaca & mengizinkan sebelum halaman apa pun diambil.
        requireExplicitRobots: POLICY.tos.verdict !== 'allowed',
        cookies: sourceConfig.cookiesEnabled ?? true,
        renderJavaScript: Boolean(sourceConfig.renderJavaScript),
    });

    const toAnime = (c) => makeAnime({
        title: c.title,
        image: c.image,
        latestEpisode: c.latestEpisode,
        episodes: c.episodes,
        status: c.status,
        format: c.format,
        slug: encodeSlug(ID, c.id, c.slug),
        source: ID,
        url: c.url,
    });

    async function list(url, ctx) {
        const page = await client.html(url, ctx);
        const cards = parseCards(page.$, base);
        if (!cards.length && !page.$('#animeList').length) {
            throw new SourceError('Struktur halaman Kuramanime tidak dikenali.', { kind: 'parse', source: ID });
        }
        return cards.map(toAnime);
    }

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        country: null,
        policy: POLICY,

        parseRef(parts) {
            if (parts.length !== 2) return null;
            const [id, slug] = parts;
            return ID_RE.test(id) && SLUG_RE.test(String(slug).toLowerCase()) ? { id, slug: String(slug).toLowerCase() } : null;
        },

        titleHint(ref) {
            return ref.slug.replace(/-/g, ' ');
        },

        latest(ctx = {}) {
            return list(`${base}/anime?order_by=updated&page=1`, ctx);
        },

        search(q, ctx = {}) {
            const url = new URL(`${base}/anime`);
            url.searchParams.set('order_by', 'latest');
            url.searchParams.set('search', q);
            url.searchParams.set('page', '1');
            return list(url.href, ctx);
        },

        async getAnime(ref, ctx = {}) {
            const page = await client.html(`${base}/anime/${ref.id}/${ref.slug}`, ctx);
            const parsed = parseDetail(page.$, base, ref);
            if (!parsed) throw new SourceError('Struktur halaman detail Kuramanime tidak dikenali.', { kind: 'parse', source: ID });
            return { ...parsed.anime, episodeList: parsed.episodeList };
        },

        async getEpisode(ref, ep, ctx = {}) {
            const known = ctx.anime?.episodeList || [];
            if (known.length && !known.some((e) => e.number === ep)) throw notFound(`Episode ${ep} belum tersedia di ${NAME}.`, ID);
            const url = `${base}/anime/${ref.id}/${ref.slug}/episode/${ep}`;
            const page = await client.html(url, ctx);
            const parsed = parseEpisodePage(page.$, base);
            return makeEpisode({
                episode: ep,
                title: parsed.title,
                url: page.url,
                servers: parsed.servers,
                downloads: parsed.downloads,
                notice: parsed.protectedPlayer
                    ? 'Player Kuramanime dilindungi token anti-bot — server streaming tidak diambil (hanya link publik).'
                    : '',
            });
        },
    };
}
