/**
 * Kazanime backend — lib/account-store.js
 * Penyimpanan akun opsional (putaran 10, 24 Okt 2026).
 *
 * Kenapa opsional: frontend Kazanime menyimpan akun di localStorage, jadi akun
 * tidak berpindah perangkat. Modul ini menyiapkan jalur SERVER agar akun bisa
 * disinkronkan — tanpa memaksa operator menyiapkan basis data baru:
 *
 *   ACCOUNT_STORE=file    → berkas JSON di DATA_DIR (server sendiri / VPS). Paling mudah.
 *   ACCOUNT_STORE=redis   → REST Redis (Upstash / Vercel KV) lewat env KV_REST_API_URL
 *                           + KV_REST_API_TOKEN (atau UPSTASH_REDIS_REST_*). Cocok untuk Vercel.
 *   ACCOUNT_STORE=memory  → hanya untuk demo/uji; HILANG saat proses berhenti.
 *   (tidak diisi)         → OFF. Frontend memakai akun lokal + berkas/kode cadangan.
 *
 * Keamanan:
 *  - Password di-hash scrypt + salt acak (bukan SHA-256 polos seperti versi lokal;
 *    server punya CPU, jadi pakai KDF yang benar).
 *  - Token sesi = HMAC-SHA256 atas payload {u, exp}; diverifikasi dengan
 *    timingSafeEqual. Secret dari ACCOUNTS_SECRET (disarankan), atau STREAM_SECRET.
 *  - Tidak ada endpoint yang mengembalikan hash/salt.
 *  - Payload dibatasi: avatar ≤ 400 KB (data URL), bookmark ≤ 300 item.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ACCOUNTS } from '../config.js';

const scryptAsync = promisify(scrypt);
const KEY_PREFIX = 'kazanime:account:';
const MAX_BOOKMARKS = 300;
const MAX_AVATAR_CHARS = 400 * 1024;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const normName = (value) => String(value || '').trim().toLowerCase();

/* ------------------------------------------------------------------ */
/* Adapter penyimpanan                                                 */
/* ------------------------------------------------------------------ */
/** Adapter berkas JSON (dipakai ACCOUNT_STORE=file; diekspor untuk pengujian). */
export function createFileAdapter(dir) {
    const file = path.join(dir, 'accounts.json');
    let chain = Promise.resolve();
    const readAll = async () => {
        try {
            const raw = await fs.readFile(file, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            if (error?.code === 'ENOENT') return {};
            throw error;
        }
    };
    /** Tulis serial (antrean) supaya dua request tidak saling menimpa. */
    const mutate = (fn) => {
        chain = chain.then(async () => {
            const all = await readAll();
            const next = fn(all) || all;
            await fs.mkdir(dir, { recursive: true });
            const tmp = `${file}.tmp`;
            await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
            await fs.rename(tmp, file); // tulis atomik
            return next;
        });
        return chain;
    };
    return {
        provider: 'file',
        persistent: true,
        async get(name) {
            const all = await readAll();
            return all[normName(name)] || null;
        },
        async put(record) {
            await mutate((all) => {
                all[normName(record.username)] = record;
                return all;
            });
            return record;
        },
        async count() {
            return Object.keys(await readAll()).length;
        },
    };
}

function redisAdapter({ url, token }) {
    const call = async (command, ...args) => {
        const endpoint = `${url.replace(/\/+$/, '')}/${[command, ...args].map((part) => encodeURIComponent(part)).join('/')}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`Redis ${res.status}`);
        const json = await res.json();
        return json?.result ?? null;
    };
    return {
        provider: 'redis',
        persistent: true,
        async get(name) {
            const raw = await call('get', `${KEY_PREFIX}${normName(name)}`);
            if (!raw) return null;
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        },
        async put(record) {
            await call('set', `${KEY_PREFIX}${normName(record.username)}`, JSON.stringify(record));
            return record;
        },
        async count() {
            return null; // tidak dipakai
        },
    };
}

function memoryAdapter() {
    const map = new Map();
    return {
        provider: 'memory',
        persistent: false,
        async get(name) {
            return map.get(normName(name)) || null;
        },
        async put(record) {
            map.set(normName(record.username), record);
            return record;
        },
        async count() {
            return map.size;
        },
    };
}

/** Pilih adapter dari konfigurasi. @returns {{adapter:object|null, reason:string}} */
function pickAdapter() {
    const mode = ACCOUNTS.store;
    if (mode === 'file') return { adapter: createFileAdapter(ACCOUNTS.dataDir), reason: '' };
    if (mode === 'redis') {
        if (!ACCOUNTS.redisUrl || !ACCOUNTS.redisToken) {
            return { adapter: null, reason: 'ACCOUNT_STORE=redis tetapi KV_REST_API_URL/KV_REST_API_TOKEN belum diisi.' };
        }
        return { adapter: redisAdapter({ url: ACCOUNTS.redisUrl, token: ACCOUNTS.redisToken }), reason: '' };
    }
    if (mode === 'memory') return { adapter: memoryAdapter(), reason: '' };
    return {
        adapter: null,
        reason: 'Server akun nonaktif. Set ACCOUNT_STORE=file (server sendiri) atau ACCOUNT_STORE=redis + KV_REST_API_URL/KV_REST_API_TOKEN (Upstash/Vercel KV).',
    };
}

/* ------------------------------------------------------------------ */
/* Hash & token                                                        */
/* ------------------------------------------------------------------ */
const hashPassword = async (password, salt) => {
    const buffer = await scryptAsync(String(password), salt, 32);
    return buffer.toString('hex');
};

const safeEqual = (a, b) => {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && timingSafeEqual(left, right);
};

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */
/**
 * @param {{adapter?: object|null, reason?: string}} [override] dipakai tes
 */
export function createAccountStore(override = {}) {
    const picked = 'adapter' in override ? override : pickAdapter();
    const adapter = picked.adapter || null;
    const secret = ACCOUNTS.secret || 'kazanime-dev-secret';

    const sign = (payload) => {
        const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const mac = createHmac('sha256', secret).update(body).digest('base64url');
        return `${body}.${mac}`;
    };

    const verify = (token) => {
        const [body, mac] = String(token || '').split('.');
        if (!body || !mac) return null;
        const expected = createHmac('sha256', secret).update(body).digest('base64url');
        if (!safeEqual(mac, expected)) return null;
        try {
            const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (!payload?.u || Number(payload.exp) < Date.now()) return null;
            return payload;
        } catch {
            return null;
        }
    };

    const publicUser = (record) => ({
        username: record.username,
        avatar: record.avatar || null,
        bookmarks: Array.isArray(record.bookmarks) ? record.bookmarks : [],
        createdAt: record.createdAt || null,
        updatedAt: record.updatedAt || null,
    });

    const issue = (record) => sign({ u: normName(record.username), exp: Date.now() + TOKEN_TTL_MS });

    return {
        get enabled() {
            return Boolean(adapter);
        },
        get provider() {
            return adapter?.provider || 'none';
        },
        get persistent() {
            return Boolean(adapter?.persistent);
        },
        get reason() {
            return adapter ? '' : picked.reason || '';
        },

        async status() {
            let accounts = null;
            if (adapter?.count) {
                try {
                    accounts = await adapter.count();
                } catch {
                    accounts = null;
                }
            }
            return {
                enabled: Boolean(adapter),
                provider: adapter?.provider || 'none',
                persistent: Boolean(adapter?.persistent),
                accounts,
                reason: adapter ? '' : picked.reason || '',
            };
        },

        /** Daftar akun baru. @returns {{ok:true, token:string, user:object}|{ok:false, status:number, error:string}} */
        async register({ username, password, avatar = null, bookmarks = [] } = {}) {
            if (!adapter) return { ok: false, status: 503, error: this.reason || 'Server akun nonaktif.' };
            const name = String(username || '').trim();
            if (name.length < 3 || name.length > 24) return { ok: false, status: 400, error: 'Username harus 3–24 karakter.' };
            if (!password || String(password).length < 6) return { ok: false, status: 400, error: 'Password minimal 6 karakter.' };
            if (avatar && typeof avatar?.img === 'string' && avatar.img.length > MAX_AVATAR_CHARS) {
                return { ok: false, status: 413, error: 'Foto avatar terlalu besar.' };
            }
            if (await adapter.get(name)) return { ok: false, status: 409, error: 'Username sudah dipakai di server.' };

            const salt = randomBytes(16).toString('hex');
            const record = {
                username: name,
                salt,
                hash: await hashPassword(password, salt),
                algo: 'scrypt',
                avatar: avatar && typeof avatar === 'object' ? avatar : null,
                bookmarks: Array.isArray(bookmarks) ? bookmarks.slice(0, MAX_BOOKMARKS) : [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            await adapter.put(record);
            return { ok: true, token: issue(record), user: publicUser(record) };
        },

        async login({ username, password } = {}) {
            if (!adapter) return { ok: false, status: 503, error: this.reason || 'Server akun nonaktif.' };
            const record = await adapter.get(String(username || '').trim()); // toleran spasi ("  rully ")
            // Pesan seragam untuk username tidak ada & password salah (tidak membocorkan
            // daftar akun server). Klien tetap menampilkan pesan lokal yang jelas.
            const generic = 'Username atau password salah di server.';
            if (!record) return { ok: false, status: 401, error: generic };
            const hash = await hashPassword(password, record.salt);
            if (!safeEqual(hash, record.hash)) return { ok: false, status: 401, error: generic };
            return { ok: true, token: issue(record), user: publicUser(record) };
        },

        /** Ambil akun dari token (dipakai endpoint /me & /sync). */
        async fromToken(token) {
            const payload = verify(token);
            if (!payload) return null;
            const record = await adapter?.get(payload.u);
            return record ? publicUser(record) : null;
        },

        /**
         * Gabungkan data klien ke server (bookmark union, avatar versi terbaru).
         * @returns {{ok:true, user:object}|{ok:false, status:number, error:string}}
         */
        async sync(token, { avatar, bookmarks, updatedAt } = {}) {
            if (!adapter) return { ok: false, status: 503, error: this.reason || 'Server akun nonaktif.' };
            const payload = verify(token);
            if (!payload) return { ok: false, status: 401, error: 'Sesi server kedaluwarsa — masuk ulang.' };
            const record = await adapter.get(payload.u);
            if (!record) return { ok: false, status: 404, error: 'Akun server tidak ditemukan.' };

            if (Array.isArray(bookmarks)) {
                const byKey = new Map();
                const keyOf = (item) => {
                    if (!item || typeof item !== 'object') return null;
                    const id = item.ids?.anilist || item.ids?.mal || item.ids?.kitsu || item.id;
                    if (id) return `id:${id}`;
                    return item.title ? `t:${String(item.title).toLowerCase()}|${item.episode ?? ''}` : null;
                };
                for (const item of [...record.bookmarks, ...bookmarks]) {
                    const key = keyOf(item);
                    if (!key) continue;
                    const prev = byKey.get(key);
                    if (!prev || Number(item.addedAt || 0) >= Number(prev.addedAt || 0)) byKey.set(key, item);
                }
                record.bookmarks = [...byKey.values()].slice(-MAX_BOOKMARKS);
            }
            if (avatar && typeof avatar === 'object' && (avatar.img || '').length <= MAX_AVATAR_CHARS) {
                const remoteStamp = Number(record.updatedAt || 0);
                const incomingStamp = Number(updatedAt || 0);
                if (!record.avatar || incomingStamp >= remoteStamp) record.avatar = avatar;
            }
            record.updatedAt = Date.now();
            await adapter.put(record);
            return { ok: true, user: publicUser(record) };
        },

        publicUser,
    };
}
