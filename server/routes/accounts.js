/**
 * Kazanime backend — routes/accounts.js
 * Sinkronisasi akun opsional (putaran 10, 24 Okt 2026).
 *
 *   GET  /api/accounts/status    → {ok, data:{enabled, provider, persistent, accounts, reason}}
 *   POST /api/accounts/register  → {ok, data:{token, user}}
 *   POST /api/accounts/login     → {ok, data:{token, user}}
 *   GET  /api/accounts/me        → {ok, data:{user}}          (Authorization: Bearer <token>)
 *   POST /api/accounts/sync      → {ok, data:{user}}          (bookmark union + avatar terbaru)
 *   POST /api/accounts/logout    → {ok, data:{loggedOut:true}} (token stateless; klien yang membuang)
 *
 * Bila ACCOUNT_STORE tidak diisi, semua endpoint POST menjawab 503 dengan
 * penjelasan cara mengaktifkannya — frontend lalu memakai akun lokal + berkas
 * cadangan, jadi tidak ada fitur yang "hilang diam-diam".
 */
import { Router } from 'express';
import { badRequest } from '../lib/errors.js';
import { createAccountStore } from '../lib/account-store.js';

/** Body JSON sederhana: object, bukan array, ukuran dibatasi express.json(). */
function readBody(req) {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Body JSON wajib berupa objek.');
    return body;
}

function bearer(req) {
    const header = String(req.get('authorization') || '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : '';
}

/** @param {{store?: ReturnType<typeof createAccountStore>}} [opts] */
export function accountRouter({ store = createAccountStore() } = {}) {
    const router = Router();

    const send = (res, status, payload) => {
        res.set('Cache-Control', 'no-store');
        res.status(status).json(payload);
    };

    router.get('/status', async (req, res, next) => {
        try {
            send(res, 200, { ok: true, source: 'accounts', data: await store.status() });
        } catch (error) {
            next(error);
        }
    });

    router.post('/register', async (req, res, next) => {
        try {
            const result = await store.register(readBody(req));
            if (!result.ok) return send(res, result.status || 400, { ok: false, error: result.error });
            return send(res, 200, { ok: true, source: 'accounts', data: { token: result.token, user: result.user } });
        } catch (error) {
            return next(error);
        }
    });

    router.post('/login', async (req, res, next) => {
        try {
            const result = await store.login(readBody(req));
            if (!result.ok) return send(res, result.status || 400, { ok: false, error: result.error });
            return send(res, 200, { ok: true, source: 'accounts', data: { token: result.token, user: result.user } });
        } catch (error) {
            return next(error);
        }
    });

    router.get('/me', async (req, res, next) => {
        try {
            const user = await store.fromToken(bearer(req));
            if (!user) return send(res, 401, { ok: false, error: 'Sesi server kedaluwarsa — masuk ulang.' });
            return send(res, 200, { ok: true, source: 'accounts', data: { user } });
        } catch (error) {
            return next(error);
        }
    });

    router.post('/sync', async (req, res, next) => {
        try {
            const token = bearer(req);
            if (!token) return send(res, 401, { ok: false, error: 'Token sesi wajib dikirim.' });
            const result = await store.sync(token, readBody(req));
            if (!result.ok) return send(res, result.status || 400, { ok: false, error: result.error });
            return send(res, 200, { ok: true, source: 'accounts', data: { user: result.user } });
        } catch (error) {
            return next(error);
        }
    });

    router.post('/logout', async (req, res) => {
        // Token stateless (HMAC) — tidak ada sesi yang perlu dihapus di server.
        send(res, 200, { ok: true, source: 'accounts', data: { loggedOut: true } });
    });

    return router;
}
