/**
 * Kazanime — services/auth.js
 * Akun lokal (localStorage). TIDAK ada UI di sini — modal ada di ui/auth-modal.js,
 * toast & navbar diurus ui/layout.js. Modul ini hanya: validasi, simpan, baca, event.
 *
 * Kompatibel dengan data file asli:
 *   localStorage['kazanime-users']        = { [username]: { username, password, avatar, bookmarks, createdAt } }
 *   localStorage['kazanime-current-user'] = 'username'
 *
 * Putaran 10 (24 Okt 2026) — penguatan penyimpanan, menjawab keluhan
 * "kadang pengguna tidak ditemukan":
 *  - Pencarian akun SELALU tanpa membedakan huruf besar/kecil (dulu register/login
 *    memakai pencarian case-insensitive tetapi getCurrentUser() memakai kunci persis →
 *    pengguna yang terdaftar sebagai "Rully" bisa "hilang" setelah reload).
 *  - BALAPAN TULIS diperbaiki: register/login dulu membaca users → `await` hash →
 *    menulis seluruh objek users. Kalau tab lain menyimpan bookmark di sela `await`,
 *    tulisannya tertimpa dan akun baru bisa hilang. Sekarang objek dibaca ULANG
 *    setelah hash selesai, sebelum ditulis.
 *  - CADANGAN OTOMATIS (`kazanime-users-backup`). Setiap tulis yang berhasil membuat
 *    salinan; bila data utama korup/hilang, salinan dipulihkan otomatis dan data
 *    rusaknya disimpan di `kazanime-users-corrupt` untuk diperiksa.
 *  - Versi data (`kazanime-users-version`) dipakai untuk sinkron antar-tab: event
 *    `storage` tidak selalu datang di Chrome Android, jadi perubahan juga dicocokkan
 *    saat tab kembali terlihat (`visibilitychange`/`pageshow`/`focus`).
 *  - Penulisan gagal (kuota penuh / mode privat) TIDAK lagi diam-diam: hasilnya
 *    dilaporkan ke pemanggil, dan kegagalan karena kuota membersihkan cache sementara.
 */
import { AUTH_RULES, AVATARS, STORAGE_KEYS } from '../config.js';
import { storage } from './storage.js';
import { sha256Hex, randomSalt } from './hash.js';

const EVENT = 'kazanime:auth';
const HASH_ALGO = 'sha256-salt-v1';
const USERNAME_PATTERN = /^[\p{L}\p{N}_.\- ]+$/u;
const CORRUPT_KEY = 'kazanime-users-corrupt';

/** @typedef {{id:number, name:string, img:string|null, card?:string|null, custom?:boolean}} Avatar */
/** @typedef {{username:string, avatar:Avatar|null, createdAt:number|null}} PublicUser */

/** Hasil tulis terakhir — dipakai UI untuk menjelaskan kegagalan penyimpanan. */
let lastWriteError = null;

/* ------------------------------------------------------------------ */
/* Penyimpanan                                                         */
/* ------------------------------------------------------------------ */
const isUserMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Parse JSON tanpa melempar. */
function parseJSON(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Baca daftar akun, dengan pemulihan otomatis dari cadangan.
 * @returns {{users: Record<string, any>, source: 'main'|'backup'|'empty', recovered: boolean}}
 */
function loadUsers() {
    const raw = storage.getRaw(STORAGE_KEYS.users);
    const parsed = parseJSON(raw);
    if (isUserMap(parsed)) return { users: parsed, source: 'main', recovered: false };

    // Data utama rusak/kosong → coba cadangan.
    const backup = parseJSON(storage.getRaw(STORAGE_KEYS.usersBackup));
    if (isUserMap(backup) && Object.keys(backup).length) {
        if (raw && raw !== '{}') storage.setRaw(CORRUPT_KEY, raw); // simpan bukti, jangan dibuang
        storage.set(STORAGE_KEYS.users, backup);
        console.warn('[auth] data akun utama rusak — dipulihkan dari cadangan otomatis.');
        return { users: backup, source: 'backup', recovered: true };
    }
    // Tidak ada apa pun: mulai bersih, tetapi JANGAN menimpa cadangan yang ada.
    return { users: {}, source: 'empty', recovered: Boolean(raw) };
}

function readUsers() {
    return loadUsers().users;
}

/** Naikkan penanda versi supaya tab lain tahu data berubah. */
function bumpVersion() {
    storage.setRaw(STORAGE_KEYS.usersVersion, String(Date.now()) + ':' + Math.random().toString(36).slice(2, 8));
}

/**
 * Tulis daftar akun + perbarui cadangan otomatis.
 * @returns {boolean} berhasil
 */
function writeUsers(users) {
    const payload = JSON.stringify(users);
    const ok = storage.set(STORAGE_KEYS.users, users);
    if (!ok) {
        // Kemungkinan besar kuota localStorage penuh (avatar custom + bookmark).
        lastWriteError = 'penyimpanan penuh';
        return false;
    }
    lastWriteError = null;
    storage.setRaw(STORAGE_KEYS.usersBackup, payload);
    bumpVersion();
    return true;
}

/** Cari kunci akun: persis dulu, lalu tanpa membedakan huruf besar/kecil & spasi tepi. */
function findKey(users, name) {
    const wanted = String(name || '').trim();
    if (!wanted) return null;
    if (Object.prototype.hasOwnProperty.call(users, wanted)) return wanted;
    const lower = wanted.toLowerCase();
    return Object.keys(users).find((k) => k.trim().toLowerCase() === lower) || null;
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
 * `card` = kartu lokal yang dipakai bila foto gagal dimuat (putaran 10).
 * @returns {Avatar|null}
 */
export function resolveAvatar(avatar) {
    if (!avatar || typeof avatar !== 'object') return null;
    if (avatar.custom && typeof avatar.img === 'string' && avatar.img.startsWith('data:image/')) {
        return { id: 0, name: 'Custom', img: avatar.img, card: null, custom: true };
    }
    const id = Number(avatar.id) || 1;
    const preset = AVATARS.find((a) => a.id === id);
    if (preset) return { id: preset.id, name: preset.name, img: preset.img, card: preset.card || null };
    return { id, name: String(avatar.name || 'Avatar'), img: null, card: null };
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
    return preset ? { id: preset.id, name: preset.name, img: preset.img || null } : null;
}

/* ------------------------------------------------------------------ */
/* API publik                                                          */
/* ------------------------------------------------------------------ */
/** @returns {PublicUser|null} */
export function getCurrentUser() {
    const pointer = storage.getRaw(STORAGE_KEYS.currentUser);
    if (!pointer) return null;
    const { users } = loadUsers();
    const key = findKey(users, pointer);
    if (!key) return null; // akun memang tidak ada di perangkat ini
    if (key !== pointer) storage.setRaw(STORAGE_KEYS.currentUser, key); // rapikan pointer lama
    const record = users[key];
    if (!record || typeof record !== 'object') return null;
    return {
        username: record.username || key,
        avatar: resolveAvatar(record.avatar),
        createdAt: record.createdAt || null,
    };
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

    // Cek cepat (sebelum hash) lalu ULANG setelah await — lihat catatan balapan tulis.
    if (findKey(readUsers(), name)) return fail('Username sudah dipakai!');
    const salt = randomSalt();
    const passHash = await hashPassword(salt, password);

    const users = readUsers(); // baca ulang: tab lain mungkin baru menyimpan sesuatu
    if (findKey(users, name)) return fail('Username sudah dipakai!');
    if (Object.keys(users).length >= 50) return fail('Maksimal 50 akun per browser. Gunakan Cadangkan Akun untuk pindah perangkat.');

    users[name] = {
        username: name,
        passHash,
        salt,
        hashAlgo: HASH_ALGO,
        avatar: storedAvatar,
        bookmarks: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    if (!writeUsers(users)) return fail('Gagal menyimpan akun — penyimpanan browser penuh atau diblokir. Cadangkan akun lama lalu hapus beberapa.');
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
    if (!key) return fail('Username tidak ditemukan di perangkat ini. Bila akun dibuat di HP lain, gunakan Pulihkan Akun.');
    const record = users[key];
    if (!record || typeof record !== 'object') return fail('Data akun rusak. Silakan daftar ulang.');

    let migrated = false;
    if (record.passHash && record.salt) {
        if ((await hashPassword(record.salt, password)) !== record.passHash) return fail('Password salah!');
    } else if (typeof record.password === 'string') {
        // Akun dari versi lama: cocokkan polos sekali, lalu simpan sebagai hash
        if (record.password !== password) return fail('Password salah!');
        const salt = randomSalt();
        const passHash = await hashPassword(salt, password);
        // Baca ulang setelah await supaya perubahan dari tab lain tidak tertimpa.
        const fresh = readUsers();
        const freshKey = findKey(fresh, key) || key;
        const target = fresh[freshKey] && typeof fresh[freshKey] === 'object' ? fresh[freshKey] : record;
        target.salt = salt;
        target.passHash = passHash;
        target.hashAlgo = HASH_ALGO;
        target.updatedAt = Date.now();
        delete target.password;
        fresh[freshKey] = target;
        migrated = writeUsers(fresh);
    } else if (record.remote) {
        // Akun cermin dari SERVER akun: password diverifikasi server, bukan di sini.
        // ui/layout.js akan mencoba accountSync.loginRemote() setelah ini.
        return fail('Akun ini tersimpan di server — verifikasi lewat server akun.');
    } else {
        return fail('Data akun rusak. Silakan daftar ulang.');
    }

    storage.setRaw(STORAGE_KEYS.currentUser, findKey(readUsers(), key) || key);
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
    const ok = updateCurrentRecord((record) => {
        record.avatar = stored;
        record.updatedAt = Date.now();
    });
    if (!ok) {
        return fail(lastWriteError === 'penyimpanan penuh'
            ? 'Gagal menyimpan avatar: penyimpanan browser penuh. Hapus foto lain atau gunakan avatar bawaan.'
            : 'Gagal menyimpan avatar.');
    }
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
    const pointer = storage.getRaw(STORAGE_KEYS.currentUser);
    if (!pointer) return null;
    const { users } = loadUsers();
    const key = findKey(users, pointer);
    if (!key) return null;
    const record = users[key];
    return record && typeof record === 'object' ? { key, record } : null;
}

/**
 * Ubah rekaman user aktif secara atomik (baca → ubah → tulis).
 * @param {(record: object) => void} mutate
 * @returns {boolean} berhasil disimpan
 */
export function updateCurrentRecord(mutate) {
    const pointer = storage.getRaw(STORAGE_KEYS.currentUser);
    if (!pointer) return false;
    const users = readUsers();
    const key = findKey(users, pointer);
    if (!key) return false;
    const record = users[key];
    if (!record || typeof record !== 'object') return false;
    mutate(record);
    record.updatedAt = Date.now();
    users[key] = record;
    return writeUsers(users);
}

/* ------------------------------------------------------------------ */
/* Cadangkan / pulihkan (dipakai services/account-backup.js)           */
/* ------------------------------------------------------------------ */
/** Ringkasan akun di perangkat ini (tanpa hash/salt). */
export function listAccounts() {
    const { users } = loadUsers();
    return Object.entries(users)
        .filter(([, record]) => record && typeof record === 'object')
        .map(([key, record]) => ({
            username: record.username || key,
            avatar: resolveAvatar(record.avatar),
            bookmarks: Array.isArray(record.bookmarks) ? record.bookmarks.length : 0,
            createdAt: record.createdAt || null,
            updatedAt: record.updatedAt || null,
        }));
}

/** Status penyimpanan untuk UI cadangan. */
export function storageInfo() {
    const { source, recovered } = loadUsers();
    return {
        enabled: storage.enabled,
        accounts: listAccounts().length,
        hasBackup: Boolean(storage.getRaw(STORAGE_KEYS.usersBackup)),
        source,
        recovered,
        lastError: lastWriteError,
        currentUser: storage.getRaw(STORAGE_KEYS.currentUser) || null,
    };
}

/** Ekspor seluruh data akun (hash password ikut, supaya bisa login di perangkat lain). */
export function exportUsers() {
    return JSON.parse(JSON.stringify(readUsers()));
}

/**
 * Impor data akun hasil cadangan.
 * - Akun yang belum ada → ditambahkan.
 * - Akun yang sudah ada → dipakai yang `updatedAt`/`createdAt` lebih baru.
 * - `setCurrent` → jadikan akun ini yang login (bila ada & valid).
 * @param {Record<string, any>} incoming
 * @param {{setCurrent?: string|null}} [opts]
 * @returns {{ok:true, added:number, updated:number, skipped:number, total:number} | {ok:false, error:string}}
 */
export function importUsers(incoming, { setCurrent = null } = {}) {
    if (!isUserMap(incoming)) return fail('Berkas cadangan tidak dikenali (bukan objek akun).');
    const users = readUsers();
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const [rawKey, record] of Object.entries(incoming)) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        const name = String(record.username || rawKey).trim();
        if (name.length < AUTH_RULES.usernameMin || name.length > AUTH_RULES.usernameMax) {
            skipped += 1;
            continue;
        }
        // Akun cermin server (`remote: true`) tidak punya hash lokal — tetap diterima
        // supaya hasil sinkron tidak hilang saat pemulihan berikutnya.
        if (!record.remote && !(record.passHash && record.salt) && typeof record.password !== 'string') {
            skipped += 1; // tidak ada kredensial yang bisa dipakai
            continue;
        }
        const existingKey = findKey(users, name);
        if (!existingKey) {
            users[name] = { ...record, username: name };
            added += 1;
            continue;
        }
        const current = users[existingKey] || {};
        const stamp = (r) => Number(r.updatedAt || r.createdAt || 0);
        if (stamp(record) >= stamp(current)) {
            users[existingKey] = { ...record, username: current.username || name };
            updated += 1;
        } else {
            skipped += 1;
        }
    }
    if (!writeUsers(users)) return fail('Gagal menyimpan hasil pemulihan — penyimpanan browser penuh.');
    const wanted = setCurrent ? findKey(users, setCurrent) : null;
    if (wanted) storage.setRaw(STORAGE_KEYS.currentUser, wanted);
    emit('import');
    return { ok: true, added, updated, skipped, total: Object.keys(users).length };
}

/** Kembalikan data utama dari cadangan otomatis (manual, dari UI). */
export function restoreFromBackup() {
    const backup = parseJSON(storage.getRaw(STORAGE_KEYS.usersBackup));
    if (!isUserMap(backup) || !Object.keys(backup).length) return fail('Belum ada cadangan otomatis di browser ini.');
    if (!storage.set(STORAGE_KEYS.users, backup)) return fail('Gagal memulihkan cadangan (penyimpanan penuh).');
    bumpVersion();
    emit('restore');
    return { ok: true, accounts: Object.keys(backup).length };
}

/** Versi data saat ini (dipakai untuk deteksi perubahan dari tab lain). */
export function dataVersion() {
    return storage.getRaw(STORAGE_KEYS.usersVersion) || '';
}

/* Sinkron antar-tab: login/logout/bookmark di tab lain → tab ini ikut */
window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === STORAGE_KEYS.currentUser || e.key === STORAGE_KEYS.users || e.key === STORAGE_KEYS.usersVersion) {
        emit('sync');
    }
});

/* Chrome Android kadang tidak mengirim event `storage`; cocokkan saat tab aktif kembali. */
let lastSeenVersion = dataVersion();
function checkExternalChange() {
    const version = dataVersion();
    if (version === lastSeenVersion) return;
    lastSeenVersion = version;
    emit('sync');
}
if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkExternalChange();
    });
}
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pageshow', checkExternalChange);
    window.addEventListener('focus', checkExternalChange);
}
