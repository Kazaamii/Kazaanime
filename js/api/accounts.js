/**
 * Kazanime — api/accounts.js
 * Klien untuk SERVER AKUN opsional (putaran 10, 24 Okt 2026).
 *
 * Server ini bagian dari backend Kazanime sendiri (`server/routes/accounts.js`).
 * Aktif hanya bila operator mengisi ACCOUNT_STORE (lihat .env.example):
 *   - `file`  → server sendiri / VPS
 *   - `redis` → Upstash / Vercel KV (REST)
 * Bila nonaktif, `status()` menjawab `{enabled:false}` dan seluruh aplikasi tetap
 * berjalan dengan akun lokal + berkas/kode cadangan (services/account-backup.js).
 *
 * Token sesi disimpan di localStorage (`kazanime-account-token`) dan dikirim
 * sebagai `Authorization: Bearer …`. Token ini HANYA untuk sinkronisasi; login
 * lokal tetap berlaku walau server mati (offline-first).
 */
import { API_CONFIG, STORAGE_KEYS } from '../config.js';
import { fetchJSON, ApiError } from './http.js';
import { storage } from '../services/storage.js';

const cfg = API_CONFIG.backend;
const BASE = `${cfg.baseUrl || ''}/api/accounts`;

/** Token sesi server (null bila belum login / dimatikan). */
export function getToken() {
    return storage.getRaw(STORAGE_KEYS.accountToken) || '';
}

export function setToken(token) {
    if (token) storage.setRaw(STORAGE_KEYS.accountToken, token);
    else storage.remove(STORAGE_KEYS.accountToken);
}

const authHeaders = () => {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
};

/**
 * POST JSON ke server akun.
 * @param {string} path
 * @param {object} body
 */
async function post(path, body, { timeout = 9000 } = {}) {
    return fetchJSON(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
        source: 'accounts',
        timeout,
    });
}

/**
 * Status server akun. Selalu aman dipanggil: bila backend tidak ada, hasilnya
 * `{enabled:false, reason}` dan tidak ada error yang dilempar.
 * @returns {Promise<{enabled:boolean, provider:string, persistent:boolean, reason:string}>}
 */
export async function accountServerStatus({ timeout = 6000 } = {}) {
    try {
        const json = await fetchJSON(`${BASE}/status`, { source: 'accounts', timeout });
        const data = json?.data || {};
        return {
            enabled: Boolean(data.enabled),
            provider: String(data.provider || 'none'),
            persistent: Boolean(data.persistent),
            accounts: data.accounts ?? null,
            reason: String(data.reason || ''),
        };
    } catch (error) {
        return {
            enabled: false,
            provider: 'none',
            persistent: false,
            reason: error?.kind === 'disabled' ? 'Backend tidak berjalan di origin ini.' : (error?.message || 'Server akun tidak merespons.'),
        };
    }
}

/** Daftar di server. @returns {Promise<{ok:boolean, token?:string, user?:object, error?:string}>} */
export async function remoteRegister({ username, password, avatar = null, bookmarks = [] }) {
    try {
        const json = await post('/register', { username, password, avatar, bookmarks });
        return { ok: true, token: json?.data?.token || '', user: json?.data?.user || null };
    } catch (error) {
        return { ok: false, error: error instanceof ApiError ? error.message : String(error?.message || error) };
    }
}

/** Masuk di server. */
export async function remoteLogin({ username, password }) {
    try {
        const json = await post('/login', { username, password });
        return { ok: true, token: json?.data?.token || '', user: json?.data?.user || null };
    } catch (error) {
        return { ok: false, error: error instanceof ApiError ? error.message : String(error?.message || error) };
    }
}

/** Ambil user pemilik token. */
export async function remoteMe() {
    const token = getToken();
    if (!token) return { ok: false, error: 'Belum masuk ke server akun.' };
    try {
        const json = await fetchJSON(`${BASE}/me`, { headers: authHeaders(), source: 'accounts', timeout: 8000 });
        return { ok: true, user: json?.data?.user || null };
    } catch (error) {
        return { ok: false, error: error?.message || 'Sesi server tidak valid.' };
    }
}

/**
 * Kirim data lokal ke server (bookmark digabung, avatar versi terbaru menang).
 * @param {{avatar?: object|null, bookmarks?: object[], updatedAt?: number}} payload
 */
export async function remoteSync(payload) {
    const token = getToken();
    if (!token) return { ok: false, error: 'Belum masuk ke server akun.' };
    try {
        const json = await post('/sync', { ...payload, updatedAt: payload.updatedAt || Date.now() }, { timeout: 12000 });
        return { ok: true, user: json?.data?.user || null };
    } catch (error) {
        return { ok: false, error: error?.message || 'Sinkron gagal.' };
    }
}

/** Lupakan token di perangkat (server tidak menyimpan sesi). */
export function forgetToken() {
    setToken('');
}
