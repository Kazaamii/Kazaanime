/**
 * Kazanime backend — sources/hianime.js
 * Adapter hianime.ro (WordPress, tema "otakuthemes" tiruan HiAnime) — anime Jepang, subtitle Inggris.
 * Ditambahkan 22 Okt 2026 atas permintaan pemilik proyek (bersama Otakudesu).
 *
 * Diverifikasi langsung 22 Okt 2026 dari runner GitHub Actions (fixture: server/test/fixtures/hianime-*):
 *   robots.txt           : hanya melarang /wp-admin/ (admin-ajax diizinkan) → /wp-json/ boleh.
 *   /recently-updated/   → kartu .flw-item (judul, judul romaji/Jepang di data-jname, ID post anime)
 *   /?s=<kata kunci>     → kartu .flw-item (tautan /anime/<slug>/ + ID post anime)
 *   /anime/<slug>/       → detail (.anisc-info) + shortlink "?p=<ID post anime>"
 *   REST /wp-json/v1/otakuthemes/episode/list/<ID anime>       → daftar episode (HTML dalam JSON)
 *   REST /wp-json/v1/otakuthemes/episode/servers?episodeId=<ID> → server (data-hash = URL base64)
 * Server: "Fast" (player blogger milik hianime.ro), "mega" (megaplay.su), dan tiga embed berbasis id
 * (megaplay.buzz / tryembed.us.cc / vidnest.fun). Tiga yang terakhir SUDAH ada sebagai server cadangan
 * statis di js/config.js (MegaPlay-MAL sengaja diganti ReAnime) → tidak diulang dari sini.
 * Hanya server "sub" (subtitle Inggris) yang dipakai; dub dilewati (badge bahasa hanya untuk subtitle).
 */
import { load } from 'cheerio';
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import { mapLimit } from '../lib/concurrency.js';
import {
    absoluteUrl, cleanText, decodeBase64, parseDurationMinutes, parseEpisodeNumber, parseFormat, parseScore10,
    parseStatus, stripSeason, titleKey,
} from '../lib/text.js';

export const ID = 'hianime';
export const NAME = 'HiAnime (hianime.ro)';

export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'allowed',
    tos: Object.freeze({
        url: 'https://hianime.ro/robots.txt',
        reviewedAt: '2026-10-22',
        verdict: 'unknown',
        note: 'Tidak ada halaman Terms of Service yang tertaut. robots.txt hanya melarang /wp-admin/. '
            + 'Diakses hanya selama robots.txt mengizinkan.',
    }),
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,118}$/;

/**
 * Benih donghua untuk bagian "Donghua di HiAnime" (24 Oktober 2026).
 *
 * HiAnime tidak punya kategori "donghua" di halaman daftarnya: `?s=<judul>` adalah satu-satunya
 * jalan yang stabil. Ketujuh benih di bawah sudah dicoba ke situs aslinya lewat API produksi
 * pada 24 Okt 2026 dan SEMUANYA mengembalikan judul yang cocok:
 *   Soul Land (5), Battle Through the Heavens (3), Perfect World (2), Douluo Dalu (4),
 *   Throne of Seal (1), Renegade Immortal (2), Shaonian Ge Xing / Anhe Zhuan (1).
 * Benih hanya kueri pencarian — kartu yang judulnya tidak cocok dibuang oleh aturan `related`,
 * jadi tidak ada judul palsu dan tidak ada klaim bahasa.
 */
export const DONGHUA_SEEDS = Object.freeze([
    'Soul Land',
    'Battle Through the Heavens',
    'Perfect World',
    'Douluo Dalu',
    'Throne of Seal',
    'Renegade Immortal',
    'Shaonian Ge Xing',
]);

/** Batas kueri & hasil bagian donghua (tiap kueri = satu request ke situs, jeda ~1 dtk/host). */
const DONGHUA_QUERIES = 6;
const DONGHUA_CONCURRENCY = 3;
const DONGHUA_LIMIT = 24;
/** Host embed yang sudah disediakan server cadangan statis (dibangun dari id AniList) — tidak diulang. */
export const STATIC_EMBED_HOSTS = ['megaplay.buzz', 'tryembed.us.cc', 'vidnest.fun'];

/** "https://hianime.ro/anime/<slug>/" → slug. */
export function animeSlugFromUrl(url, base) {
    try {
        const u = new URL(url, base);
        if (u.hostname.replace(/^www\./, '') !== new URL(base).hostname.replace(/^www\./, '')) return null;
        const segs = u.pathname.split('/').filter(Boolean);
        if (segs.length !== 2 || segs[0] !== 'anime') return null;
        const s = decodeURIComponent(segs[1]).toLowerCase();
        return SLUG_RE.test(s) ? s : null;
    } catch {
        return null;
    }
}

/** "…/watch/<seri>-episode-3-english-sub-215930/" → { seriesSlug: "<seri>", episode: 3, postId: 215930 } */
export function parseWatchUrl(url) {
    try {
        const segs = new URL(url).pathname.split('/').filter(Boolean);
        if (segs.length !== 2 || segs[0] !== 'watch') return null;
        const m = /^(.+?)-episode-(\d+)(?:-[a-z-]*)?-(\d+)$/.exec(segs[1].toLowerCase());
        if (!m || !SLUG_RE.test(m[1])) return null;
        return { seriesSlug: m[1], episode: Number(m[2]), postId: Number(m[3]) };
    } catch {
        return null;
    }
}

function imgSrc($img, base) {
    for (const attr of ['data-src', 'data-lazy-src', 'src']) {
        const v = $img.attr(attr);
        if (v && !v.startsWith('data:')) {
            const u = absoluteUrl(v.replace(/&#0?38;/g, '&'), base);
            if (u) return u;
        }
    }
    return null;
}

/** data-jname "Romaji | English | 日本語" → judul alternatif pertama yang berbeda dari judul utama. */
function altTitle(jname, title) {
    const parts = cleanText(jname).split('|').map(cleanText).filter(Boolean);
    return parts.find((p) => p.toLowerCase() !== cleanText(title).toLowerCase()) || '';
}

/**
 * Kartu .flw-item (Recently Updated & hasil pencarian).
 * @returns {{slug: string|null, animeId: number|null, title: string, titleAlt: string, image: string|null,
 *            latestEpisode: number|null, format: string, duration: number|null, url: string}[]}
 */
export function parseCards($, base) {
    const out = [];
    $('.flw-item').each((_, el) => {
        const card = $(el);
        const a = card.find('.film-name a').first();
        const href = absoluteUrl(a.attr('href'), base);
        if (!href) return;
        const title = cleanText(a.text()) || cleanText(a.attr('title'));
        if (!title) return;
        const watch = parseWatchUrl(href);
        const slug = animeSlugFromUrl(href, base) || watch?.seriesSlug || null;
        const id = Number.parseInt(card.find('[data-id]').first().attr('data-id'), 10);
        const info = cleanText(card.find('.fd-infor').text());
        const eps = Number.parseInt(cleanText(card.find('.tick-sub').first().text()), 10);
        out.push({
            slug,
            animeId: Number.isInteger(id) && id > 0 ? id : null,
            title,
            titleAlt: altTitle(a.attr('data-jname'), title),
            image: imgSrc(card.find('img').first(), base),
            latestEpisode: watch?.episode || (Number.isInteger(eps) && eps > 0 ? eps : null),
            format: parseFormat(info),
            duration: parseDurationMinutes(info),
            url: slug ? `${base}/anime/${slug}/` : href,
        });
    });
    return out;
}

/** Halaman /anime/<slug>/ → detail + ID post anime (untuk REST daftar episode). */
export function parseAnimePage($, base, slug) {
    const title = cleanText($('h2.film-name').first().text());
    if (!title) return null;
    /** @type {Record<string, string>} */
    const info = {};
    /** @type {Record<string, string[]>} */
    const links = {};
    $('.anisc-info .item').each((_, el) => {
        const item = $(el);
        const label = cleanText(item.find('.item-head').first().text()).replace(/:\s*$/, '').toLowerCase();
        if (!label || info[label] !== undefined) return;
        const clone = item.clone();
        clone.find('.item-head').remove();
        info[label] = cleanText(clone.text());
        const ls = item.find('a').map((__, x) => cleanText($(x).text())).get().filter(Boolean);
        if (ls.length) links[label] = ls;
    });
    const shortlink = $('link[rel="shortlink"]').attr('href') || '';
    const animeId = Number.parseInt(/[?&]p=(\d+)/.exec(shortlink)?.[1] || '', 10);
    const description = cleanText($('.film-description .text').first().text()) || info.overview || '';
    return {
        animeId: Number.isInteger(animeId) && animeId > 0 ? animeId : null,
        anime: {
            title,
            titleAlt: altTitle($('h2.film-name').first().attr('data-jname'), title) || info.japanese || '',
            image: imgSrc($('.anisc-poster img.film-poster-img').first(), base) || absoluteUrl($('meta[property="og:image"]').attr('content')),
            description,
            genres: links.genres || [],
            studios: links.studios || (info.studios ? info.studios.split(',') : []),
            score: parseScore10(info['mal score']),
            status: parseStatus(info.status),
            duration: parseDurationMinutes(info.duration),
            format: parseFormat(cleanText($('.film-stats').first().text())),
            url: `${base}/anime/${slug}/`,
        },
    };
}

/** JSON REST episode/list → [{number, title, url}] */
export function parseEpisodeListHtml(htmlText, base) {
    const $ = load(String(htmlText || ''));
    const raw = [];
    $('a.ep-item').each((_, el) => {
        const a = $(el);
        const number = parseEpisodeNumber(a.attr('data-number')) || parseEpisodeNumber(a.attr('title'));
        const url = absoluteUrl(a.attr('href'), base);
        if (!number || !url) return;
        raw.push({ number, title: cleanText(a.find('.ep-name').first().text()) || cleanText(a.attr('title')), released: '', url });
    });
    return makeEpisodeList(raw);
}

/** JSON REST episode/servers → server embed (sub saja, tanpa host yang sudah jadi cadangan statis). */
export function parseServersHtml(htmlText) {
    const $ = load(String(htmlText || ''));
    const out = [];
    $('.server-item[data-hash]').each((_, el) => {
        const item = $(el);
        if (String(item.attr('data-type') || '').toLowerCase() !== 'sub') return;
        const url = absoluteUrl(decodeBase64(item.attr('data-hash')));
        if (!url) return;
        let host = '';
        try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return; }
        if (STATIC_EMBED_HOSTS.includes(host)) return;
        out.push({ name: cleanText(item.attr('data-server-name')) || host, url, lang: 'en' });
    });
    return out;
}

/** "…-215886/" → 215886 */
const postIdOf = (url) => parseWatchUrl(url)?.postId || null;

/**
 * @param {{network: any, createClient: Function, baseUrl: string}} deps
 */
export function createHianime({ network, createClient, baseUrl }) {
    const base = String(baseUrl || 'https://hianime.ro').replace(/\/+$/, '');
    const host = new URL(base).hostname.replace(/^www\./, '');
    const rest = `${base}/wp-json/v1/otakuthemes`;
    const client = createClient(network, { source: ID, allowedHosts: [host, `www.${host}`], blockedMs: 5 * 60 * 1000 });

    const toAnime = (c) => makeAnime({
        title: c.title,
        titleAlt: c.titleAlt,
        image: c.image,
        latestEpisode: c.latestEpisode,
        format: c.format,
        duration: c.duration,
        status: 'UNKNOWN',
        slug: c.animeId ? encodeSlug(ID, c.slug, c.animeId) : encodeSlug(ID, c.slug),
        source: ID,
        url: c.url,
    });

    async function restHtml(path, ctx) {
        const json = await client.json(`${rest}${path}`, ctx);
        if (!json || (json.status === false && json.success !== true)) throw notFound('Data tidak ditemukan di hianime.ro.', ID);
        return String(json.html || '');
    }

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        country: 'JP',
        policy: POLICY,

        /** "slug" atau "slug~<ID post anime>". */
        parseRef(parts) {
            const slug = String(parts[0] || '').toLowerCase();
            if (!SLUG_RE.test(slug) || parts.length > 2) return null;
            const id = parts[1] != null ? Number.parseInt(parts[1], 10) : null;
            if (parts.length === 2 && !(Number.isInteger(id) && id > 0 && String(id) === parts[1])) return null;
            return { slug, animeId: id };
        },

        titleHint(ref) {
            return ref.slug.replace(/-/g, ' ');
        },

        /** Dipakai registry saat metadata donghua kosong/gagal (lihat browseDonghua). */
        donghuaSeeds: DONGHUA_SEEDS,

        /**
         * Donghua yang ada di HiAnime (24 Oktober 2026, permintaan pengguna).
         *
         * Situlah satu-satunya sumber donghua yang benar-benar lengkap dari ketiga situs:
         * `?s=Soul Land` → 5 seri, `?s=Battle Through the Heavens` → 3, `?s=Perfect World` → 2,
         * `?s=Renegade Immortal` → 2, `?s=Throne of Seal` → 1, `?s=Shaonian Ge Xing` → 1
         * (dicek 24 Okt 2026). Hanya kartu yang judulnya cocok dengan kueri yang dipakai.
         *
         * @param {string[]} titles judul dari benih situs + metadata
         * @param {object} ctx
         */
        async browseDonghua(titles = [], ctx = {}) {
            const queries = [...new Set((Array.isArray(titles) ? titles : [])
                .map((title) => cleanText(title))
                .filter((title) => title.length >= 4))]
                .slice(0, DONGHUA_QUERIES);
            const fetched = await mapLimit(queries, DONGHUA_CONCURRENCY, async (query) => {
                const url = new URL(`${base}/`);
                url.searchParams.set('s', query);
                try {
                    const page = await client.html(url.href, ctx);
                    return { query, cards: parseCards(page.$, base).filter((c) => c.slug), error: null };
                } catch (error) {
                    return { query, cards: [], error };
                }
            });
            const items = [];
            const seen = new Set();
            let firstError = null;
            for (const { query, cards, error } of fetched) {
                if (error) {
                    firstError = firstError || error;
                    continue;
                }
                const key = titleKey(stripSeason(query));
                if (!key) continue;
                for (const card of cards) {
                    const cardKey = titleKey(stripSeason(card.title));
                    const related = cardKey === key
                        || (key.length >= 5 && cardKey.includes(key))
                        || (cardKey.length >= 5 && key.includes(cardKey));
                    if (!related) continue;
                    const slug = encodeSlug(ID, card.slug, card.animeId);
                    if (!slug || seen.has(slug)) continue;
                    seen.add(slug);
                    items.push(toAnime(card));
                }
            }
            if (!items.length && firstError) throw firstError;
            return items.slice(0, DONGHUA_LIMIT);
        },

        async latest(ctx = {}) {
            const page = await client.html(`${base}/recently-updated/`, ctx);
            const cards = parseCards(page.$, base).filter((c) => c.slug);
            if (!cards.length) throw new SourceError('Struktur halaman Recently Updated hianime.ro berubah.', { kind: 'parse', source: ID });
            const seen = new Set();
            return cards.filter((c) => !seen.has(c.slug) && seen.add(c.slug)).map(toAnime);
        },

        async search(q, ctx = {}) {
            const url = new URL(`${base}/`);
            url.searchParams.set('s', q);
            const page = await client.html(url.href, ctx);
            return parseCards(page.$, base).filter((c) => c.slug).map(toAnime);
        },

        async getAnime(ref, ctx = {}) {
            const page = await client.html(`${base}/anime/${ref.slug}/`, ctx);
            const parsed = parseAnimePage(page.$, base, ref.slug);
            if (!parsed) throw new SourceError('Struktur halaman anime hianime.ro tidak dikenali.', { kind: 'parse', source: ID });
            const animeId = parsed.animeId || ref.animeId;
            if (!animeId) throw new SourceError('ID anime hianime.ro tidak ditemukan di halaman.', { kind: 'parse', source: ID });
            const episodeList = parseEpisodeListHtml(await restHtml(`/episode/list/${animeId}`, ctx), base);
            const latestEpisode = episodeList.length ? episodeList[episodeList.length - 1].number : null;
            return {
                ...makeAnime({
                    ...parsed.anime,
                    latestEpisode,
                    episodes: parsed.anime.status === 'COMPLETED' ? latestEpisode : null,
                    slug: encodeSlug(ID, ref.slug, animeId),
                    source: ID,
                }),
                episodeList,
            };
        },

        async getEpisode(ref, ep, ctx = {}) {
            const entry = (ctx.anime?.episodeList || []).find((e) => e.number === ep);
            const episodeId = entry?.url ? postIdOf(entry.url) : null;
            if (!episodeId) throw notFound(`Episode ${ep} belum tersedia di hianime.ro.`, ID);
            const servers = parseServersHtml(await restHtml(`/episode/servers?episodeId=${episodeId}`, ctx));
            return makeEpisode({ episode: ep, title: entry.title, released: entry.released, url: entry.url, servers, downloads: [] });
        },
    };
}
