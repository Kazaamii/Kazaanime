/**
 * Kazanime backend — routes/reactions.js
 * Hitungan "suka" (like) per episode — putaran 14 (24 Okt 2026).
 *
 *   GET  /api/reactions?keys=slug~ep1,slug~ep2   → { ok, data:{ counts:{key:n}, enabled, provider, persistent } }
 *   GET  /api/reactions/status                   → { ok, data:{ enabled, provider, persistent, mode, keys, reason } }
 *   POST /api/reactions/:key                     → { ok, data:{ key, count, liked } }
 *        body: { "liked": true|false, "visitor": "<id anonim 8–64 karakter>" }
 *
 * Desain:
 *  - Satu like per `visitor` per key (klik berulang/refresh tidak menambah hitungan).
 *  - `visitor` dibuat frontend (id acak di perangkat) — tidak ada nama/email/IP yang disimpan.
 *  - Bila penyimpanan nonaktif (`REACTION_STORE=off`), endpoint tetap menjawab 200 dengan
 *    `enabled:false` supaya frontend bisa memakai jejak lokal tanpa error.
 *  - Semua respons `Cache-Control: no-store` untuk GET (hitungan harus "live"); POST juga.
 */
import { Router } from 'express';
import { badRequest } from '../lib/errors.js';
import { createReactionStore, normalizeKey, normalizeVisitor } from '../lib/reaction-store.js';

/** Maksimal key per permintaan GET. */
export const MAX_KEYS_PER_REQUEST = 20;

/**
 * @param {unknown} value `?keys=a,b` atau array (query berulang)
 * @returns {string[]} key yang sudah dinormalisasi (unik)
 */
export function readKeys(value) {
    const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
    const parts = [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
    if (!parts.length) throw badRequest('Parameter keys wajib diisi (pisahkan dengan koma).');
    if (parts.length > MAX_KEYS_PER_REQUEST) throw badRequest(`Maksimal ${MAX_KEYS_PER_REQUEST} key per permintaan.`);
    const keys = [];
    for (const part of parts) {
        const key = normalizeKey(part);
        if (!key) throw badRequest(`Key tidak valid: ${part.slice(0, 60)}`);
        keys.push(key);
    }
    return keys;
}

/** Body JSON sederhana: object, bukan array. */
function readBody(req) {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Body JSON wajib berupa objek.');
    const visitor = normalizeVisitor(body.visitor);
    if (!visitor) throw badRequest('visitor wajib diisi (8–64 karakter: huruf kecil, angka, tanda hubung).');
    if (typeof body.liked !== 'boolean') throw badRequest('liked wajib boolean (true = suka, false = batal).');
    return { visitor, liked: body.liked };
}

/** @param {{store?: ReturnType<typeof createReactionStore>}} [opts] */
export function reactionsRouter({ store = createReactionStore() } = {}) {
    const router = Router();
    const send = (res, payload) => {
        res.set('Cache-Control', 'no-store');
        res.status(200).json({ ok: true, source: 'reactions', data: payload });
    };

    router.get('/status', async (req, res, next) => {
        try {
            send(res, await store.status());
        } catch (error) {
            next(error);
        }
    });

    router.get('/', async (req, res, next) => {
        try {
            const keys = readKeys(req.query.keys ?? req.query.key);
            const counts = await store.counts(keys);
            send(res, {
                counts,
                enabled: store.enabled,
                provider: store.provider,
                persistent: store.persistent,
            });
        } catch (error) {
            next(error);
        }
    });

    router.post('/:key', async (req, res, next) => {
        try {
            const key = normalizeKey(req.params.key);
            if (!key) throw badRequest('Key tidak valid.');
            const { visitor, liked } = readBody(req);
            const result = await store.setLike(key, visitor, liked);
            send(res, { key, count: result.count, liked: result.liked, enabled: store.enabled });
        } catch (error) {
            next(error);
        }
    });

    return router;
}
