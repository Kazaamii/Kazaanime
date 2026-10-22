/**
 * Kazanime backend — providers/anizone.js
 * Penyedia server "AniZone — Multi Sub" (https://anizone.to), ditambahkan 22 Okt 2026.
 * HLS media memakai proxy same-origin bertanda tangan untuk kompatibilitas CORS; bukan proxy egress/anti-bot.
 *
 * Diverifikasi langsung 22 Okt 2026 dari runner GitHub Actions:
 *   robots.txt               : "User-agent: * / Disallow:" (semua diizinkan)
 *   /anime?search=<judul>    → hasil di atribut Alpine `x-data="{ items: JSON.parse('…') }"`
 *                              (slug 8 karakter, main_title, title_list multi-bahasa, start_year, …)
 *   /anime/<slug>/<episode>  → `vidstackPlayer(JSON.parse('…'))` berisi src HLS
 *                              (https://<nama>.xin-cdn.xyz/<uuid>/master.m3u8) + subtitles[]
 *                              ({title, format: ass|srt, language, default, forced, file}) — termasuk
 *                              "Indonesian" untuk banyak judul.
 *   CDN xin-cdn.xyz: master/varian/segmen 200 tanpa Referer apa pun, segmen AES-128 (key relatif),
 *   audio Jepang + Inggris terpisah; CORS dikunci ke https://anizone.to → di Chrome/Firefox diputar
 *   lewat proxy kita (server/routes/stream.js), di Safari/iOS (HLS native) langsung dari CDN.
 *   Berkas subtitle kadang kena challenge Cloudflare (acak) → diambil backend dengan pengulangan.
 */
import { load } from 'cheerio';
import { SourceError, notFound } from '../lib/errors.js';
import { cleanText } from '../lib/text.js';
import { bestTitleMatch, uniqueTitles } from './match.js';

export const ID = 'anizone';
export const NAME = 'AniZone';

const SLUG_RE = /^[a-z0-9]{6,12}$/;
const LANG_NAMES = {
    id: 'Indonesia', en: 'English', ms: 'Melayu', ar: 'Arab', de: 'Jerman', es: 'Spanyol', 'es-419': 'Spanyol (Latin)',
    fr: 'Prancis', it: 'Italia', pl: 'Polandia', pt: 'Portugis', 'pt-br': 'Portugis (Brasil)', ru: 'Rusia', th: 'Thai',
    vi: 'Vietnam', zh: 'Mandarin', 'zh-hant': 'Mandarin (Tradisional)', 'zh-hans': 'Mandarin (Sederhana)', ja: 'Jepang', ko: 'Korea', tr: 'Turki',
};
const LANG_ORDER = ['id', 'en', 'ms'];

/**
 * Isi `JSON.parse('…')` di atribut Alpine (string JS ber-escape \u0022, \/ , \\uXXXX) → nilai JS.
 * @param {string} literal isi di antara tanda kutip tunggal
 */
export function decodeJsJson(literal) {
    const unescaped = String(literal || '').replace(/\\'/g, "'").replace(/"/g, '\\"');
    return JSON.parse(JSON.parse(`"${unescaped}"`));
}

/** Teks di dalam `<marker>JSON.parse('…')` pada dokumen (atribut sudah di-unescape cheerio). */
function extractJsonParse(text, marker) {
    const re = new RegExp(`${marker}\\s*JSON\\.parse\\('((?:[^'\\\\]|\\\\.)*)'\\)`);
    const m = re.exec(String(text || ''));
    if (!m) return null;
    try {
        return decodeJsJson(m[1]);
    } catch {
        return null;
    }
}

/**
 * Halaman /anime?search= → daftar anime.
 * @param {string} html
 * @returns {{slug: string, title: string, titles: string[], year: number|null, type: string, episodes: number|null}[]}
 */
export function parseSearchItems(html) {
    const $ = load(String(html || ''));
    let items = null;
    $('[x-data]').each((_, el) => {
        if (items) return;
        const v = $(el).attr('x-data') || '';
        if (!/items\s*:\s*JSON\.parse/.test(v)) return;
        const parsed = extractJsonParse(v, 'items\\s*:');
        if (Array.isArray(parsed)) items = parsed;
    });
    return (items || [])
        .map((it) => {
            const slug = String(it?.slug || '').toLowerCase();
            if (!SLUG_RE.test(slug)) return null;
            const titles = [it.main_title, ...Object.values(it.title_list || {})].map(cleanText).filter(Boolean);
            const year = Number(it.start_year);
            const eps = Number(it.episode_count);
            return {
                slug,
                title: cleanText(it.main_title) || titles[0] || slug,
                titles: [...new Set(titles)],
                year: Number.isInteger(year) && year > 1900 ? year : null,
                type: cleanText(it.type),
                episodes: Number.isInteger(eps) && eps > 0 ? eps : null,
            };
        })
        .filter(Boolean);
}

/**
 * Halaman episode → data player.
 * @param {string} html
 * @param {string[]} mediaHosts sufiks host media yang diizinkan
 * @returns {{src: string, subtitles: {label: string, lang: string, format: string, file: string, default: boolean}[], poster: string|null}|null}
 */
export function parsePlayer(html, mediaHosts) {
    const $ = load(String(html || ''));
    let player = null;
    $('[x-data]').each((_, el) => {
        if (player) return;
        const v = $(el).attr('x-data') || '';
        if (!/vidstackPlayer\s*\(/.test(v)) return;
        player = extractJsonParse(v, 'vidstackPlayer\\(');
    });
    if (!player) {
        // cadangan: <media-player src="…"> (versi lama halaman)
        const src = $('media-player[src]').attr('src');
        if (src) player = { src, subtitles: [] };
    }
    const allowed = (u) => {
        try {
            const url = new URL(u);
            const h = url.hostname.toLowerCase();
            return url.protocol === 'https:' && mediaHosts.some((s) => h === s || h.endsWith(`.${s}`));
        } catch {
            return false;
        }
    };
    if (!player?.src || !allowed(player.src)) return null;
    const subs = (Array.isArray(player.subtitles) ? player.subtitles : [])
        .filter((s) => s && allowed(s.file) && /^(ass|ssa|srt|vtt)$/i.test(String(s.format || '')) && String(s.forced || 'no') !== 'yes')
        .map((s) => {
            const lang = String(s.language || '').toLowerCase().slice(0, 12);
            const title = cleanText(s.title);
            const base = LANG_NAMES[lang] || LANG_NAMES[lang.split('-')[0]] || title || lang || 'Subtitle';
            const extra = /sdh/i.test(title) ? ' (SDH)' : '';
            return { label: `${base}${extra}`.slice(0, 40), lang, format: String(s.format).toLowerCase(), file: s.file, default: Boolean(s.default) };
        });
    const rank = (s) => {
        const i = LANG_ORDER.indexOf(s.lang.split('-')[0]);
        return (i < 0 ? 10 : i) + (/SDH/.test(s.label) ? 0.5 : 0);
    };
    subs.sort((a, b) => rank(a) - rank(b));
    const seen = new Set();
    const subtitles = subs.filter((s) => !seen.has(s.label) && seen.add(s.label)).slice(0, 16);
    const def = subtitles.find((s) => s.lang === 'id') || subtitles.find((s) => s.lang === 'en') || subtitles[0];
    for (const s of subtitles) s.default = s === def;
    return { src: player.src, subtitles, poster: allowed(player.snapshot) ? player.snapshot : null };
}

/**
 * @param {{network: any, createClient: Function, cache?: any, baseUrl?: string, mediaHosts?: string[]}} deps
 */
export function createAnizone({ network, createClient, baseUrl = 'https://anizone.to', mediaHosts = ['xin-cdn.xyz'] }) {
    const base = String(baseUrl).replace(/\/+$/, '');
    const host = new URL(base).hostname.replace(/^www\./, '');
    const client = createClient(network, {
        source: ID,
        allowedHosts: [host, `www.${host}`],
        // Baseline GitHub Actions (2026-10-22): homepage challenged. Don't repeat content requests;
        // open the source circuit for 30 minutes and let other providers/scrapers serve as fallback.
        challengeRetries: 0,
        blockedMs: 30 * 60 * 1000,
    });

    async function findSlug(titles, year, ctx) {
        for (const q of uniqueTitles(titles, 2)) {
            const url = new URL(`${base}/anime`);
            url.searchParams.set('search', q);
            const res = await client.request(url.href, ctx);
            const items = parseSearchItems(res.text);
            const hit = bestTitleMatch(items, (it) => it.titles, titles, { year, yearOf: (it) => it.year });
            if (hit) return hit.slug;
        }
        return null;
    }

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        mediaHosts,

        /**
         * @param {{ep: number, titles?: string[], year?: number|null, slug?: string|null}} q
         * @returns {Promise<{servers: object[], slug: string}>}
         */
        async servers({ ep, titles = [], year = null, slug = null }, ctx = {}) {
            const s = slug && SLUG_RE.test(slug) ? slug : (titles.length ? await findSlug(titles, year, ctx) : null);
            if (!s) throw notFound('Anime ini tidak ditemukan di AniZone.', ID);
            let res;
            try {
                res = await client.request(`${base}/anime/${s}/${ep}`, ctx);
            } catch (err) {
                if (err?.kind === 'not_found') throw notFound(`Episode ${ep} belum tersedia di AniZone.`, ID);
                throw err;
            }
            const player = parsePlayer(res.text, mediaHosts);
            if (!player) throw new SourceError(`Player AniZone episode ${ep} tidak ditemukan/berubah.`, { kind: 'parse', source: ID });
            return {
                slug: s,
                servers: [{
                    name: 'AniZone',
                    kind: 'hls',
                    lang: 'multi',
                    src: player.src,
                    poster: player.poster,
                    subtitles: player.subtitles,
                }],
            };
        },
    };
}
