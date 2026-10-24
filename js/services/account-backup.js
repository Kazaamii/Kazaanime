/**
 * Kazanime — services/account-backup.js
 * Cadangkan & pulihkan akun (putaran 10, 24 Okt 2026).
 *
 * Latar belakang: akun Kazanime disimpan di localStorage perangkat, jadi bila
 * pengguna mengganti HP / membersihkan data browser, akunnya hilang dan login
 * menjawab "Username tidak ditemukan". Modul ini menyediakan dua jalur pindah:
 *
 *   1. BERKAS CADANGAN (.json) — berisi seluruh akun (hash password + salt,
 *      avatar, bookmark). Bisa diunggah di perangkat lain lewat "Pulihkan Akun".
 *   2. KODE SINKRON — berkas yang sama dipadatkan + base64url, jadi bisa
 *      disalin-tempel lewat chat tanpa mengirim file. Awalan `KZ1-` (tanpa
 *      kompresi) atau `KZ1Z-` (deflate-raw via CompressionStream).
 *
 * Catatan jujur: berkas/kode ini berisi hash password (SHA-256 + salt) dan
 * bookmark. Siapa pun yang memegangnya bisa menebak password secara offline —
 * perlakukan seperti kata sandi, jangan sampai bocor.
 */
import { importUsers, exportUsers, listAccounts, storageInfo } from './auth.js';
import { AVATAR_UPLOAD } from '../config.js';

export const BUNDLE_APP = 'kazanime';
export const BUNDLE_TYPE = 'account-backup';
export const BUNDLE_VERSION = 1;
const MAX_USERS = 50;
const MAX_AVATAR_BYTES = Math.max(AVATAR_UPLOAD.maxDataUrlBytes, 400 * 1024);

/* ------------------------------------------------------------------ */
/* Utilitas base64url                                                  */
/* ------------------------------------------------------------------ */
const toBase64Url = (bytes) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text) => {
    const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
};

/** Kompresi deflate-raw bila peramban mendukung (Chrome/Edge/Firefox/Safari 16.4+). */
async function deflate(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        const buffer = await new Response(stream).arrayBuffer();
        return new Uint8Array(buffer);
    } catch {
        return null;
    }
}

async function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') throw new Error('Peramban ini belum mendukung kode terkompresi. Gunakan berkas cadangan.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

/* ------------------------------------------------------------------ */
/* Bundel                                                              */
/* ------------------------------------------------------------------ */
/**
 * Susun bundel cadangan dari data di perangkat ini.
 * @returns {{app:string, type:string, version:number, exportedAt:string, currentUser:string|null, users:object}}
 */
export function buildBundle() {
    const users = exportUsers();
    const info = storageInfo();
    return {
        app: BUNDLE_APP,
        type: BUNDLE_TYPE,
        version: BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        currentUser: info.currentUser,
        users,
    };
}

/** Apakah objek ini bundel Kazanime yang valid? */
export function isBundle(value) {
    return Boolean(value)
        && typeof value === 'object'
        && value.app === BUNDLE_APP
        && value.type === BUNDLE_TYPE
        && value.users
        && typeof value.users === 'object'
        && !Array.isArray(value.users);
}

/** Ringkasan bundel untuk ditampilkan di UI. */
export function bundleSummary(bundle) {
    const users = isBundle(bundle) ? bundle.users : {};
    const accounts = Object.entries(users).map(([key, record]) => ({
        username: String(record?.username || key),
        bookmarks: Array.isArray(record?.bookmarks) ? record.bookmarks.length : 0,
        custom: Boolean(record?.avatar?.custom),
    }));
    return {
        accounts,
        total: accounts.length,
        exportedAt: bundle?.exportedAt || null,
        currentUser: bundle?.currentUser || null,
        hasCredentials: accounts.length > 0,
    };
}

/** Validasi ukuran: bundel raksasa (avatar base64) ditolak dengan pesan jelas. */
export function validateBundle(bundle) {
    if (!isBundle(bundle)) return { ok: false, error: 'Berkas ini bukan cadangan akun Kazanime.' };
    const entries = Object.entries(bundle.users);
    if (entries.length > MAX_USERS) return { ok: false, error: `Cadangan berisi ${entries.length} akun (maksimal ${MAX_USERS}).` };
    for (const [key, record] of entries) {
        if (!record || typeof record !== 'object') return { ok: false, error: `Data akun "${key}" rusak.` };
        const img = record.avatar?.img;
        if (typeof img === 'string' && img.startsWith('data:image/') && img.length > MAX_AVATAR_BYTES) {
            return { ok: false, error: `Foto avatar akun "${record.username || key}" terlalu besar (${Math.round(img.length / 1024)} KB).` };
        }
    }
    return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Berkas                                                              */
/* ------------------------------------------------------------------ */
/** Nama berkas cadangan: kazanime-akun-YYYYMMDD-HHMM.json */
export function bundleFileName(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `kazanime-akun-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
}

/**
 * Unduh bundel sebagai berkas .json.
 * @returns {{ok:boolean, filename?:string, bytes?:number, error?:string}}
 */
export function downloadBundle() {
    const accounts = listAccounts();
    if (!accounts.length) return { ok: false, error: 'Belum ada akun di perangkat ini untuk dicadangkan.' };
    const bundle = buildBundle();
    const text = JSON.stringify(bundle, null, 2);
    const filename = bundleFileName();
    try {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return { ok: true, filename, bytes: blob.size };
    } catch (error) {
        return { ok: false, error: `Gagal membuat berkas: ${error?.message || error}` };
    }
}

/** Baca berkas .json yang dipilih pengguna → bundel tervalidasi. */
export async function readBundleFile(file) {
    if (!file) return { ok: false, error: 'Pilih berkas cadangan dulu.' };
    if (file.size > 5 * 1024 * 1024) return { ok: false, error: 'Berkas terlalu besar (maksimal 5 MB).' };
    let text;
    try {
        text = await file.text();
    } catch {
        return { ok: false, error: 'Berkas tidak bisa dibaca.' };
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return { ok: false, error: 'Berkas bukan JSON yang valid. Pastikan memilih berkas cadangan Kazanime.' };
    }
    const valid = validateBundle(data);
    if (!valid.ok) return valid;
    return { ok: true, bundle: data };
}

/* ------------------------------------------------------------------ */
/* Kode sinkron                                                        */
/* ------------------------------------------------------------------ */
/**
 * Buat kode sinkron (base64url, dipadatkan bila peramban mendukung).
 * @returns {Promise<{ok:true, code:string, bytes:number, compressed:boolean} | {ok:false, error:string}>}
 */
export async function createSyncCode() {
    if (!listAccounts().length) return { ok: false, error: 'Belum ada akun di perangkat ini untuk disalin.' };
    const text = JSON.stringify(buildBundle());
    const bytes = new TextEncoder().encode(text);
    const packed = await deflate(bytes);
    if (packed) {
        const code = `KZ1Z-${toBase64Url(packed)}`;
        return { ok: true, code, bytes: code.length, compressed: true };
    }
    const code = `KZ1-${toBase64Url(bytes)}`;
    return { ok: true, code, bytes: code.length, compressed: false };
}

/**
 * Baca kode sinkron (mendukung KZ1- dan KZ1Z-).
 * @returns {Promise<{ok:true, bundle:object} | {ok:false, error:string}>}
 */
export async function parseSyncCode(input) {
    const code = String(input || '').trim().replace(/\s+/g, '');
    const match = /^(KZ1Z?)-([A-Za-z0-9\-_]+)$/.exec(code);
    if (!match) return { ok: false, error: 'Kode tidak dikenali. Kode Kazanime diawali "KZ1-".' };
    let bytes;
    try {
        bytes = fromBase64Url(match[2]);
    } catch {
        return { ok: false, error: 'Kode rusak atau terpotong saat disalin.' };
    }
    try {
        if (match[1] === 'KZ1Z') bytes = await inflate(bytes);
    } catch (error) {
        return { ok: false, error: error?.message || 'Kode tidak bisa dibuka.' };
    }
    let data;
    try {
        data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return { ok: false, error: 'Isi kode tidak valid.' };
    }
    const valid = validateBundle(data);
    if (!valid.ok) return valid;
    return { ok: true, bundle: data };
}

/* ------------------------------------------------------------------ */
/* Pemulihan                                                           */
/* ------------------------------------------------------------------ */
/**
 * Pulihkan bundel ke perangkat ini (akun yang sudah ada tetap dipertahankan,
 * data terbaru menang).
 * @param {object} bundle
 * @param {{loginUser?: string|null, keepCurrent?: string|null}} [opts]
 */
export function restoreBundle(bundle, { loginUser = null, keepCurrent = null } = {}) {
    const valid = validateBundle(bundle);
    if (!valid.ok) return valid;
    const summary = bundleSummary(bundle);
    const wanted = loginUser || bundle.currentUser || keepCurrent || summary.accounts[0]?.username || null;
    const res = importUsers(bundle.users, { setCurrent: wanted });
    if (!res.ok) return res;
    return { ...res, loggedInAs: wanted };
}
