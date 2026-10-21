/**
 * Kazanime backend — routes/anime.js
 * Empat endpoint yang dipanggil frontend (js/api/sources.js):
 *   GET /api/anime/latest
 *   GET /api/anime/search?q=
 *   GET /api/anime/:slug
 *   GET /api/anime/:slug/episode/:ep
 *
 * Format respons (seragam untuk semua sumber):
 *   sukses : { ok: true, source, data, fallback, stale, errors?, generatedAt }
 *   gagal  : { ok: false, error, code, details? }   (dibuat oleh error handler di app.js)
 */
import { Router } from 'express';
import { CACHE } from '../config.js';
import { badRequest } from '../lib/errors.js';

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
    const sMax = result.fallback || result.stale ? Math.min(120, cdn.cdnMaxAge) : cdn.cdnMaxAge;
    res.set('Cache-Control', `public, max-age=${result.fallback || result.stale ? 0 : 60}, s-maxage=${sMax}, stale-while-revalidate=${cdn.cdnStale}`);
}

/**
 * @param {ReturnType<import('../sources/index.js').createRegistry>} registry
 * @param {{budgetMs: number, cdn?: typeof CACHE}} opts
 */
export function animeRouter(registry, { budgetMs, cdn = CACHE }) {
    const router = Router();

    /** Bungkus handler: siapkan ctx (batas waktu total) lalu kirim JSON seragam. */
    const handle = (fn) => async (req, res) => {
        const started = Date.now();
        const ctx = { deadline: started + budgetMs };
        const result = await fn(req, ctx);
        res.locals.result = result;
        setCacheHeaders(res, result, cdn);
        res.json({
            ok: true,
            source: result.source,
            ...(result.provider ? { provider: result.provider } : {}),
            fallback: Boolean(result.fallback),
            stale: Boolean(result.stale),
            ...(result.errors?.length ? { errors: result.errors } : {}),
            generatedAt: new Date().toISOString(),
            data: result.data,
        });
    };

    router.get('/latest', handle((req, ctx) => registry.latest(ctx)));
    router.get('/search', handle((req, ctx) => registry.search(readQuery(req.query.q), ctx)));
    router.get('/:slug/episode/:ep', handle((req, ctx) => registry.episode(req.params.slug, readEpisode(req.params.ep), ctx)));
    router.get('/:slug', handle((req, ctx) => registry.detail(req.params.slug, ctx)));

    return router;
}
