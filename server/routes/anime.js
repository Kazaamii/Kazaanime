/**
 * Kazanime backend — routes/anime.js
 * Endpoint yang dipanggil frontend (js/api/sources.js):
 *   GET /api/anime/latest
 *   GET /api/anime/latest-subindo  (rilis anime Jepang Sub Indo, per sumber)
 *   GET /api/anime/browse?source=oploverz&filter=popular&genre=action&page=1   (halaman Jelajah)
 *   GET /api/anime/search?q=
 *   GET /api/anime/schedule          (jadwal rilis Sub Indo per hari, WIB — ditambahkan 22 Okt 2026)
 *   GET /api/anime/downloads/kusonime?title=<Romaji>
 *   GET /api/anime/:slug
 *   GET /api/anime/:slug/episode/:ep
 *
 * Format respons (seragam untuk semua sumber):
 *   sukses : { ok: true, source, data, fallback, stale, errors?, generatedAt }
 *   gagal  : { ok: false, error, code, details? }   (dibuat oleh error handler di app.js)
 */
import { Router } from 'express';
import { CACHE, SOURCES } from '../config.js';
import { encodeTarget } from '../lib/stream-proxy.js';
import { badRequest } from '../lib/errors.js';
import { titleKey } from '../lib/text.js';

/** Validasi ?q= : string 1–100 karakter, tanpa karakter kontrol. */
export function readQuery(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') throw badRequest('Parameter q wajib diisi.');
    // eslint-disable-next-line no-control-regex
    const q = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (q.length < 2) throw badRequest('Kata kunci minimal 2 karakter.');
    if (q.length > 100) throw badRequest('Kata kunci maksimal 100 karakter.');
    return q;
}

/** Up to four Latin-script title candidates (Romaji/known aliases), with no CJK guessing. */
export function readRomajiTitles(value) {
    const candidates = Array.isArray(value) ? value : [value];
    const out = [];
    const seen = new Set();
    for (const raw of candidates) {
        if (typeof raw !== 'string') continue;
        // eslint-disable-next-line no-control-regex
        const title = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
        if (title.length < 2 || title.length > 100 || !/\p{Script=Latin}/u.test(title)
            || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(title)) continue;
        const key = titleKey(title);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(title);
        if (out.length === 4) break;
    }
    if (!out.length) throw badRequest('Kandidat judul Romaji minimal 2 karakter dan harus memakai huruf Latin.');
    return out;
}

/** Token filter/genre: huruf kecil, angka, garis; kosong = default adapter. */
export function readFilterToken(value, name) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === undefined || raw === null || raw === '') return '';
    if (typeof raw !== 'string' || raw.length > 40 || !/^[a-z0-9-]+$/i.test(raw)) {
        throw badRequest(`Parameter ${name} tidak valid.`);
    }
    return raw.toLowerCase();
}

/** Id sumber untuk katalog: huruf kecil, angka, garis (mis. "animeku", "oploverz"). */
export function readSourceId(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/i.test(raw)) {
        throw badRequest('Parameter source tidak valid.');
    }
    return raw.toLowerCase();
}

/** Halaman katalog 1–500. */
export function readPageNumber(value) {
    if (value === undefined || value === null || value === '') return 1;
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) throw badRequest('Parameter page tidak valid.');
    const n = Number.parseInt(raw, 10);
    if (n < 1 || n > 500) throw badRequest('Parameter page tidak valid.');
    return n;
}

/** "12" → 12 ; selain bilangan bulat 1–5000 → 400. */
export function readEpisode(value) {
    if (!/^\d{1,4}$/.test(String(value))) throw badRequest('Nomor episode tidak valid.');
    const n = Number.parseInt(value, 10);
    if (n < 1 || n > 5000) throw badRequest('Nomor episode tidak valid.');
    return n;
}

/**
 * Header cache CDN (Vercel) + browser. Hasil fallback/stale di-cache lebih singkat
 * supaya data asli segera muncul lagi begitu sumber pulih.
 */
function setCacheHeaders(res, result, cdn) {
    // partial = poster pengganti belum semuanya ketemu (masih dicari di belakang) → cache singkat
    const sMax = result.fallback || result.stale ? Math.min(120, cdn.cdnMaxAge) : result.partial ? Math.min(60, cdn.cdnMaxAge) : cdn.cdnMaxAge;
    res.set('Cache-Control', `public, max-age=${result.fallback || result.stale ? 0 : 60}, s-maxage=${sMax}, stale-while-revalidate=${cdn.cdnStale}`);
}

function isAllowedAnimeOnsenMediaUrl(value, hosts) {
    try {
        const url = new URL(String(value || ''));
        const host = url.hostname.toLowerCase();
        return url.protocol === 'https:' && !url.port && !url.username && !url.password
            && hosts.map((entry) => String(entry).toLowerCase()).includes(host);
    } catch {
        return false;
    }
}

/** Convert AnimeOnsen's upstream media URLs to signed same-origin proxy paths; never cache them at the CDN. */
function proxyAnimeOnsenEpisode(result, signer, mediaHosts) {
    if (result?.source !== 'animeonsen' || !result.data || !Array.isArray(result.data.servers)) return result;
    const data = { ...result.data };
    if (typeof signer?.sign !== 'function') {
        data.servers = [];
        return { ...result, data };
    }
    data.servers = data.servers.map((server) => {
        const kind = server?.kind;
        const target = String(server?.url || '');
        if (!['hls', 'video'].includes(kind) || !isAllowedAnimeOnsenMediaUrl(target, mediaHosts)) return null;
        const proxy = (url, format = '') => {
            const encoded = encodeTarget(url);
            const signature = format
                ? signer.sign(`${url}|${format}|animeonsen`)
                : signer.sign(`${url}|animeonsen`);
            return format
                ? `/api/stream/sub?u=${encoded}&f=${format}&p=animeonsen&s=${signature}`
                : `/api/stream/hls?u=${encoded}&p=animeonsen&s=${signature}`;
        };
        const subtitles = (Array.isArray(server.subtitles) ? server.subtitles : [])
            .filter((track) => track && ['ass', 'ssa', 'srt', 'vtt'].includes(String(track.format || '').toLowerCase())
                && isAllowedAnimeOnsenMediaUrl(track.url, mediaHosts))
            .slice(0, 16)
            .map((track) => ({
                label: String(track.label || 'Subtitle').slice(0, 40),
                lang: String(track.lang || 'und').slice(0, 12).toLowerCase(),
                default: Boolean(track.default),
                url: proxy(track.url, String(track.format).toLowerCase()),
            }));
        return { ...server, url: proxy(target), subtitles };
    }).filter(Boolean);
    return { ...result, data };
}

/**
 * @param {ReturnType<import('../sources/index.js').createRegistry>} registry
 * @param {{budgetMs: number, cdn?: typeof CACHE, signer?: {sign:Function}, animeOnsenMediaHosts?:string[]}} opts
 */
export function animeRouter(registry, { budgetMs, cdn = CACHE, signer = null, animeOnsenMediaHosts = SOURCES.animeonsen.mediaHosts } = {}) {
    const router = Router();

    /** Bungkus handler: siapkan ctx (batas waktu total) lalu kirim JSON seragam. */
    const handle = (fn) => async (req, res) => {
        const started = Date.now();
        const ctx = { deadline: started + budgetMs };
        const rawResult = await fn(req, ctx);
        const result = req.params?.ep
            ? proxyAnimeOnsenEpisode(rawResult, signer, animeOnsenMediaHosts)
            : rawResult;
        res.locals.result = result;
        setCacheHeaders(res, result, cdn);
        if ((req.params?.ep && result.source === 'animeonsen') || req.path === '/downloads/kusonime') res.set('Cache-Control', 'private, no-store');
        res.json({
            ok: true,
            source: result.source,
            ...(result.provider ? { provider: result.provider } : {}),
            fallback: Boolean(result.fallback),
            stale: Boolean(result.stale),
            ...(result.partial ? { partial: true } : {}),
            ...(result.errors?.length ? { errors: result.errors } : {}),
            ...(result.disabled ? { disabled: true } : {}),
            generatedAt: new Date().toISOString(),
            data: result.data,
        });
    };

    router.get('/latest', handle((req, ctx) => registry.latest(ctx)));
    router.get('/latest-subindo', handle((req, ctx) => registry.latestSubIndo(ctx)));
    router.get('/search', handle((req, ctx) => registry.search(readQuery(req.query.q), ctx)));
    router.get('/downloads/kusonime', handle((req, ctx) => {
        const titles = readRomajiTitles(req.query.title);
        return typeof registry.kusonimeDownloads === 'function'
            ? registry.kusonimeDownloads(titles, ctx)
            : { source: 'kusonime', data: { query: '', matchedTitle: '', downloads: [] }, fallback: false, stale: false, errors: [], disabled: true };
    }));
    // Harus SEBELUM '/:slug' — kalau tidak, "browse"/"schedule" dianggap slug anime.
    router.get('/browse', handle((req, ctx) => registry.browse({
        source: readSourceId(req.query.source),
        filter: readFilterToken(req.query.filter, 'filter'),
        genre: readFilterToken(req.query.genre, 'genre'),
        page: readPageNumber(req.query.page),
    }, ctx)));
    router.get('/schedule', handle((req, ctx) => registry.schedule(ctx)));
    router.get('/:slug/episode/:ep', handle((req, ctx) => registry.episode(req.params.slug, readEpisode(req.params.ep), ctx)));
    router.get('/:slug', handle((req, ctx) => registry.detail(req.params.slug, ctx)));

    return router;
}
