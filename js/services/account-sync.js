/**
 * Kazanime — services/account-sync.js
 * Lapisan sinkronisasi akun opsional (putaran 10, 24 Okt 2026).
 *
 * Prinsip: **lokal dulu, server bila ada.**
 *   - Bila operator mengaktifkan server akun (ACCOUNT_STORE), akun yang dibuat di
 *     perangkat ini otomatis didorong ke server, dan login bisa menemukan akun
 *     yang dibuat di perangkat lain.
 *   - Bila server nonaktif/mati, semuanya tetap jalan seperti sebelumnya: akun
 *     lokal + berkas/kode cadangan. Tidak ada toast error yang mengganggu.
 *
 * Yang disinkronkan: bookmark + avatar. Password tidak pernah dikirim setelah
 * login/daftar (server menyimpan hash scrypt sendiri).
 */
import * as api from '../api/accounts.js';
import * as auth from './auth.js';
import { readCurrentRecord } from './auth.js';
import { storage } from './storage.js';
import { STORAGE_KEYS } from '../config.js';

let cachedStatus = null;
let statusAt = 0;
const STATUS_TTL = 5 * 60 * 1000;

/** Apakah perangkat ini sudah punya token server (pernah sinkron). */
export function hasToken() {
    return Boolean(api.getToken());
}

/** Status server akun (di-cache 5 menit; `force` untuk tombol Sinkron). */
export async function serverStatus({ force = false } = {}) {
    if (!force && cachedStatus && Date.now() - statusAt < STATUS_TTL) return cachedStatus;
    cachedStatus = await api.accountServerStatus();
    statusAt = Date.now();
    return cachedStatus;
}

/** Apakah server akun aktif dan menyimpan data (bukan sekadar memory sementara)? */
export async function isServerEnabled({ force = false } = {}) {
    const status = await serverStatus({ force });
    return Boolean(status.enabled);
}

/** Data lokal yang layak dikirim. */
function localPayload() {
    const current = readCurrentRecord();
    if (!current) return null;
    const record = current.record;
    return {
        avatar: auth.resolveAvatar(record.avatar),
        bookmarks: Array.isArray(record.bookmarks) ? record.bookmarks : [],
        updatedAt: Number(record.updatedAt || Date.now()),
    };
}

/**
 * Dorong data lokal ke server (best-effort; tidak pernah melempar).
 * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string}>}
 */
export async function push() {
    if (!api.getToken()) return { ok: false, skipped: true };
    if (!(await isServerEnabled())) return { ok: false, skipped: true };
    const payload = localPayload();
    if (!payload) return { ok: false, skipped: true };
    const res = await api.remoteSync(payload);
    if (res.ok) storage.setRaw(STORAGE_KEYS.usersVersion, String(Date.now()));
    return res;
}

/**
 * Tarik data dari server lalu gabungkan ke akun lokal (dipakai saat halaman dibuka
 * dan tombol "Sinkron Sekarang").
 * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string, updated?:number}>}
 */
export async function pull() {
    if (!api.getToken()) return { ok: false, skipped: true };
    if (!(await isServerEnabled())) return { ok: false, skipped: true };
    const res = await api.remoteMe();
    if (!res.ok || !res.user) return { ok: false, error: res.error };
    const remote = res.user;
    let updated = 0;
    auth.updateCurrentRecord((record) => {
        const localStamp = Number(record.updatedAt || 0);
        const remoteStamp = Number(remote.updatedAt || 0);
        if (remote.avatar && remoteStamp >= localStamp) {
            record.avatar = remote.avatar;
            updated += 1;
        }
        if (Array.isArray(remote.bookmarks) && remote.bookmarks.length) {
            const keyOf = (item) => {
                if (!item || typeof item !== 'object') return null;
                const id = item.ids?.anilist || item.ids?.mal || item.ids?.kitsu || item.id;
                return id ? `id:${id}` : (item.title ? `t:${String(item.title).toLowerCase()}|${item.episode ?? ''}` : null);
            };
            const merged = new Map();
            for (const item of [...(Array.isArray(record.bookmarks) ? record.bookmarks : []), ...remote.bookmarks]) {
                const key = keyOf(item);
                if (!key) continue;
                const prev = merged.get(key);
                if (!prev || Number(item.addedAt || 0) >= Number(prev.addedAt || 0)) merged.set(key, item);
            }
            const next = [...merged.values()].slice(-300);
            if (next.length !== (record.bookmarks || []).length) {
                record.bookmarks = next;
                updated += 1;
            }
        }
    });
    if (updated) window.dispatchEvent(new CustomEvent('kazanime:bookmarks', { detail: { reason: 'sync' } }));
    return { ok: true, updated };
}

/**
 * Dipanggil sekali per halaman setelah layout siap.
 * Tidak melakukan apa pun bila server nonaktif atau belum login.
 */
export async function bootstrap() {
    if (!api.getToken()) return;
    if (!auth.getCurrentUser()) {
        // Token ada tetapi sesi lokal tidak (mis. data browser dibersihkan) → buang.
        api.forgetToken();
        return;
    }
    try {
        await pull();
        await push();
    } catch {
        /* offline / server mati: abaikan, data lokal tetap utuh */
    }
}

/**
 * Daftarkan akun baru ke server (dipanggil setelah register lokal berhasil).
 * Bila username sudah dipakai di server, data lokal TIDAK ditimpa — pengguna diberi tahu.
 */
export async function registerRemote({ username, password, avatar }) {
    if (!(await isServerEnabled())) return { ok: false, skipped: true };
    const payload = localPayload();
    const res = await api.remoteRegister({
        username,
        password,
        avatar: avatar || payload?.avatar || null,
        bookmarks: payload?.bookmarks || [],
    });
    if (res.ok) {
        api.setToken(res.token);
        return { ok: true, token: res.token };
    }
    return res;
}

/**
 * Coba login ke server (dipakai login lokal yang gagal "Username tidak ditemukan").
 * Bila berhasil, akun server dicerminkan ke lokal supaya bookmark & avatar ikut.
 * @returns {Promise<{ok:boolean, skipped?:boolean, mirrored?:boolean, error?:string}>}
 */
export async function loginRemote({ username, password }) {
    if (!(await isServerEnabled())) return { ok: false, skipped: true };
    const res = await api.remoteLogin({ username, password });
    if (!res.ok) return res;
    api.setToken(res.token);
    const user = res.user || {};
    return { ok: true, mirrored: mirrorRemoteUser(user), error: '' };
}

/**
 * Tulis akun server ke penyimpanan lokal (tanpa password: server yang memverifikasi).
 * Pemulihan password tetap lewat berkas cadangan bila server mati.
 */
function mirrorRemoteUser(user) {
    const username = String(user.username || '').trim();
    if (!username) return false;
    const result = auth.importUsers({
        [username]: {
            username,
            remote: true,
            avatar: auth.resolveAvatar(user.avatar),
            bookmarks: Array.isArray(user.bookmarks) ? user.bookmarks : [],
            createdAt: user.createdAt || Date.now(),
            updatedAt: user.updatedAt || Date.now(),
        },
    }, { setCurrent: username });
    return Boolean(result.ok);
}

/** Sinkron manual (tombol menu profil). */
export async function syncNow() {
    const status = await serverStatus({ force: true });
    if (!status.enabled) return { ok: false, disabled: true, reason: status.reason };
    if (!api.getToken()) return { ok: false, noToken: true };
    const pulled = await pull();
    if (pulled.skipped) return { ok: false, noToken: true };
    const pushed = await push();
    return { ok: Boolean(pulled.ok && pushed.ok), error: pulled.error || pushed.error, updated: pulled.updated || 0 };
}

/** Lupakan token saat logout. */
export function logoutRemote() {
    api.forgetToken();
    cachedStatus = null;
}
