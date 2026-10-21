/**
 * Kazanime — services/auth.js
 * Akun lokal (localStorage). TIDAK ada UI di sini — modal ada di ui/auth-modal.js,
 * toast & navbar diurus ui/layout.js. Modul ini hanya: validasi, simpan, baca, event.
 *
 * Kompatibel dengan data file asli:
 *   localStorage['kazanime-users']        = { [username]: { username, password, avatar, bookmarks, createdAt } }
 *   localStorage['kazanime-current-user'] = 'username'
 *
 * Perubahan:
 *  - Password disimpan sebagai SHA-256 + salt acak:
 *      { passHash, salt, hashAlgo: 'sha256-salt-v1' }  (field `password` dihapus)
 *  - Akun LAMA (password polos) otomatis dikonversi saat berhasil login berikutnya.
 *  - Tidak ada lagi reload/render ulang seluruh halaman saat login/logout:
 *    perubahan diumumkan lewat event 'kazanime:auth' (juga sinkron antar-tab).
 *  - URL avatar lama yang 404 diganti otomatis dengan gambar terbaru dari config
 *    (berdasarkan id avatar) saat dibaca — data user tidak perlu diubah.
 *  - Username baru dicek tanpa membedakan huruf besar/kecil ("Rully" = "rully").
 */
import { AUTH_RULES, AVATARS, STORAGE_KEYS } from '../config.js';
import { storage } from './storage.js';
import { sha256Hex, randomSalt } from './hash.js';

const EVENT = 'kazanime:auth';
const HASH_ALGO = 'sha256-salt-v1';
const USERNAME_PATTERN = /^[\p{L}\p{N}_.\- ]+$/u;

/** @typedef {{id:number, name:string, img:string|null, custom?:boolean}} Avatar */
/** @typedef {{username:string, avatar:Avatar|null, createdAt:number|null}} PublicUser */

/* ------------------------------------------------------------------ */
/* Penyimpanan                                                         */
/* ------------------------------------------------------------------ */
function readUsers() {
    const users = storage.get(STORAGE_KEYS.users, {});
    return users && typeof users === 'object' && !Array.isArray(users) ? users : {};
}

function writeUsers(users) {
    return storage.set(STORAGE_KEYS.users, users);
}

/** Cari kunci akun: persis dulu, lalu tanpa membedakan huruf besar/kecil. */
function findKey(users, name) {
    if (Object.prototype.hasOwnProperty.call(users, name)) return name;
    const lower = name.toLowerCase();
    return Object.keys(users).find((k) => k.toLowerCase() === lower) || null;
}

function emit(reason) {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { reason } }));
}

const fail = (error) => ({ ok: false, error });

const hashPassword = (salt, password) => sha256Hex(`${salt}:${password}`);

/* ------------------------------------------------------------------ */
/* Avatar                                                              */
/* ------------------------------------------------------------------ */
/**
 * Avatar tersimpan → avatar untuk ditampilkan.
 * Avatar preset selalu memakai URL terbaru dari config (URL lama di data user 404).
 * @returns {Avatar|null}
 */
export function resolveAvatar(avatar) {
    if (!avatar || typeof avatar !== 'object') return null;
    if (avatar.custom && typeof avatar.img === 'string' && avatar.img.startsWith('data:image/')) {
        return { id: 0, name: 'Custom', img: avatar.img, custom: true };
    }
    const id = Number(avatar.id) || 1;
    const preset = AVATARS.find((a) => a.id === id);
    return preset ? { id: preset.id, name: preset.name, img: preset.img } : { id, name: String(avatar.name || 'Avatar'), img: null };
}

/** Avatar dari modal → format penyimpanan (sama dengan file asli). */
function toStoredAvatar(avatar) {
    if (!avatar) return null;
    if (avatar.custom) {
        return typeof avatar.img === 'string' && avatar.img.startsWith('data:image/')
            ? { id: 0, name: 'Custom', img: avatar.img, custom: true }
            : null;
    }
    const preset = AVATARS.find((a) => a.id === Number(avatar.id));
    return preset ? { id: preset.id, name: preset.name, img: preset.img } : null;
}

/* ------------------------------------------------------------------ */
/* API publik                                                          */
/* ------------------------------------------------------------------ */
/** @returns {PublicUser|null} */
export function getCurrentUser() {
    const name = storage.getRaw(STORAGE_KEYS.currentUser);
    if (!name) return null;
    const record = readUsers()[name];
    if (!record || typeof record !== 'object') return null;
    return { username: record.username || name, avatar: resolveAvatar(record.avatar), createdAt: record.createdAt || null };
}

export function isLoggedIn() {
    return getCurrentUser() !== null;
}

/**
 * Daftar akun baru lalu langsung login.
 * @param {{username:string, password:string, avatar:Avatar|null}} input
 * @returns {Promise<{ok:true, user:PublicUser} | {ok:false, error:string}>}
 */
export async function register({ username, password, avatar } = {}) {
    const name = String(username || '').trim();
    if (name.length < AUTH_RULES.usernameMin) return fail(`Username minimal ${AUTH_RULES.usernameMin} karakter!`);
    if (name.length > AUTH_RULES.usernameMax) return fail(`Username maksimal ${AUTH_RULES.usernameMax} karakter!`);
    if (!USERNAME_PATTERN.test(name)) return fail('Username hanya boleh berisi huruf, angka, spasi, titik, - dan _');
    if (!password || password.length < AUTH_RULES.passwordMin) return fail(`Password minimal ${AUTH_RULES.passwordMin} karakter!`);
    const storedAvatar = toStoredAvatar(avatar);
    if (!storedAvatar) return fail('Pilih avatar atau upload foto!');

    const users = readUsers();
    if (findKey(users, name)) return fail('Username sudah dipakai!');

    const salt = randomSalt();
    users[name] = {
        username: name,
        passHash: await hashPassword(salt, password),
        salt,
        hashAlgo: HASH_ALGO,
        avatar: storedAvatar,
        bookmarks: [],
        createdAt: Date.now(),
    };
    if (!writeUsers(users)) return fail('Gagal menyimpan akun — penyimpanan browser penuh atau diblokir.');
    storage.setRaw(STORAGE_KEYS.currentUser, name);
    emit('register');
    return { ok: true, user: getCurrentUser() };
}

/**
 * Masuk. Akun lama berpassword polos dikonversi ke hash setelah cocok.
 * @param {{username:string, password:string}} input
 * @returns {Promise<{ok:true, user:PublicUser, migrated:boolean} | {ok:false, error:string}>}
 */
export async function login({ username, password } = {}) {
    const name = String(username || '').trim();
    if (!name || !password) return fail('Isi username dan password!');

    const users = readUsers();
    const key = findKey(users, name);
    if (!key) return fail('Username tidak ditemukan!');
    const record = users[key];
    if (!record || typeof record !== 'object') return fail('Data akun rusak. Silakan daftar ulang.');

    let migrated = false;
    if (record.passHash && record.salt) {
        if ((await hashPassword(record.salt, password)) !== record.passHash) return fail('Password salah!');
    } else if (typeof record.password === 'string') {
        // Akun dari versi lama: cocokkan polos sekali, lalu simpan sebagai hash
        if (record.password !== password) return fail('Password salah!');
        record.salt = randomSalt();
        record.passHash = await hashPassword(record.salt, password);
        record.hashAlgo = HASH_ALGO;
        delete record.password;
        users[key] = record;
        migrated = writeUsers(users);
    } else {
        return fail('Data akun rusak. Silakan daftar ulang.');
    }

    storage.setRaw(STORAGE_KEYS.currentUser, key);
    emit('login');
    return { ok: true, user: getCurrentUser(), migrated };
}

export function logout() {
    storage.remove(STORAGE_KEYS.currentUser);
    emit('logout');
}

/**
 * Ganti avatar user yang sedang login.
 * @param {Avatar|null} avatar
 * @returns {{ok:true, user:PublicUser, avatar:Avatar} | {ok:false, error:string}}
 */
export function updateAvatar(avatar) {
    const stored = toStoredAvatar(avatar);
    if (!stored) return fail('Pilih avatar dulu!');
    const ok = updateCurrentRecord((record) => { record.avatar = stored; });
    if (!ok) return fail('Gagal menyimpan avatar.');
    emit('avatar');
    return { ok: true, user: getCurrentUser(), avatar: resolveAvatar(stored) };
}

/**
 * Pantau login/logout/ganti avatar (termasuk dari tab lain).
 * @param {(user: PublicUser|null, reason: string) => void} callback
 * @returns {() => void}
 */
export function onAuthChange(callback) {
    const handler = (e) => callback(getCurrentUser(), e.detail?.reason || 'change');
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
}

/* ------------------------------------------------------------------ */
/* Akses rekaman user (dipakai services/bookmark.js)                   */
/* ------------------------------------------------------------------ */
/** @returns {{key:string, record:object}|null} salinan rekaman user aktif */
export function readCurrentRecord() {
    const name = storage.getRaw(STORAGE_KEYS.currentUser);
    if (!name) return null;
    const record = readUsers()[name];
    return record && typeof record === 'object' ? { key: name, record } : null;
}

/**
 * Ubah rekaman user aktif secara atomik (baca → ubah → tulis).
 * @param {(record: object) => void} mutate
 * @returns {boolean} berhasil disimpan
 */
export function updateCurrentRecord(mutate) {
    const name = storage.getRaw(STORAGE_KEYS.currentUser);
    if (!name) return false;
    const users = readUsers();
    const record = users[name];
    if (!record || typeof record !== 'object') return false;
    mutate(record);
    users[name] = record;
    return writeUsers(users);
}

/* Sinkron antar-tab: login/logout/bookmark di tab lain → tab ini ikut */
window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === STORAGE_KEYS.currentUser || e.key === STORAGE_KEYS.users) emit('sync');
});
