/**
 * Kazanime — api/http.js
 * SATU-SATUNYA tempat `fetch()` dipanggil di seluruh frontend.
 * Modul UI tidak boleh memanggil fetch; modul sumber (anilist/kitsu/sources)
 * memanggil fetchJSON() di sini.
 *
 * Masalah di file asli yang diselesaikan di sini:
 *  - Tidak ada cache → ±12 request setiap kali halaman dibuka/login/logout.
 *  - Timeout pakai Promise.race → request lama tetap berjalan (tidak dibatalkan).
 *  - Tidak ada retry, tidak ada pembatas laju (API publik cepat kena 429).
 *  - Status API dicek dengan request terpisah, bukan dari request yang benar-benar dipakai.
 *
 * Fitur:
 *  - timeout nyata (AbortController) + dukungan AbortSignal dari pemanggil
 *  - retry terbatas dengan backoff untuk error jaringan / 5xx / 429 (timeout TIDAK diulang)
 *  - cache 2 lapis: Map (memori) + sessionStorage (antar-halaman dalam satu tab),
 *    yang disimpan adalah hasil `transform` (data sudah dinormalisasi → kecil)
 *  - dedupe: request identik yang sedang berjalan dipakai bersama
 *  - throttle per host (opsional: jeda minimal antar-request)
 *  - registry kesehatan sumber + circuit breaker: sumber yang baru gagal
 *    dilewati sementara sehingga fallback ke sumber berikutnya instan
 *  - ApiError bertipe + friendlyError() berbahasa Indonesia untuk UI
 */
import { API_CONFIG, STORAGE_KEYS } from '../config.js';

export const API_SOURCES = Object.freeze(['anilist', 'kitsu', 'backend']);
const HEALTH_EVENT = 'kazanime:api-health';
const CACHE_PREFIX = STORAGE_KEYS.apiCachePrefix;
const MEMORY_MAX = 250;

/**
 * Error terstruktur dari lapisan API.
 * kind: 'timeout' | 'network' | 'http' | 'graphql' | 'parse' | 'abort' | 'circuit' | 'disabled' | 'empty'
 */
export class ApiError extends Error {
    /**
     * @param {string} message
     * @param {{kind?: string, status?: number, source?: string, retryAfter?: number, cause?: unknown, payload?: unknown}} [opts]
     *   payload: body JSON dari respons error HTTP (null bila body bukan JSON, mis. halaman 404 server statis)
     */
    constructor(message, { kind = 'network', status = 0, source = '', retryAfter = 0, stage = '', cause, payload = null } = {}) {
        super(message);
        this.name = 'ApiError';
        this.kind = kind;
        this.status = status;
        this.source = source;
        this.retryAfter = retryAfter;
        this.stage = stage;
        this.payload = payload;
        if (cause) this.cause = cause;
    }
}

/* ------------------------------------------------------------------ */
/* Utilitas                                                            */
/* ------------------------------------------------------------------ */

/** sessionStorage yang aman (null jika diblokir, mis. mode privat tertentu). */
const session = (() => {
    try {
        const k = '__kz_session_test__';
        window.sessionStorage.setItem(k, '1');
        window.sessionStorage.removeItem(k);
        return window.sessionStorage;
    } catch {
        return null;
    }
})();

/** Hash FNV-1a 32-bit → base36 (kunci cache pendek & stabil). */
export function hashKey(text) {
    let h = 0x811c9dc5;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

function abortError(source) {
    return new ApiError('Permintaan dibatalkan.', { kind: 'abort', source });
}

/** setTimeout berbasis Promise yang bisa dibatalkan lewat AbortSignal. */
function sleep(ms, signal, source) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError(source));
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            reject(abortError(source));
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */
const memoryCache = new Map(); // key → { exp, value }
const inflight = new Map();    // key → Promise (hanya request tanpa AbortSignal pemanggil)

function cacheGet(key) {
    const now = Date.now();
    const hit = memoryCache.get(key);
    if (hit) {
        if (hit.exp > now) return hit.value;
        memoryCache.delete(key);
    }
    if (!session) return undefined;
    const storageKey = CACHE_PREFIX + key;
    try {
        const raw = session.getItem(storageKey);
        if (!raw) return undefined;
        const entry = JSON.parse(raw);
        if (entry && entry.exp > now) {
            memoryCache.set(key, entry);
            return entry.value;
        }
        session.removeItem(storageKey);
    } catch {
        try { session.removeItem(storageKey); } catch { /* abaikan */ }
    }
    return undefined;
}

/** Hapus entri kedaluwarsa, lalu separuh entri tertua (dipanggil saat storage penuh). */
function pruneSessionCache() {
    if (!session) return;
    const now = Date.now();
    const entries = [];
    for (let i = 0; i < session.length; i++) {
        const k = session.key(i);
        if (!k || !k.startsWith(CACHE_PREFIX)) continue;
        let exp = 0;
        try { exp = JSON.parse(session.getItem(k))?.exp || 0; } catch { /* korup → hapus */ }
        entries.push([k, exp]);
    }
    entries.sort((a, b) => a[1] - b[1]);
    const half = Math.ceil(entries.length / 2);
    entries.forEach(([k, exp], i) => {
        if (exp <= now || i < half) session.removeItem(k);
    });
}

function cacheSet(key, value, ttl, persist) {
    const entry = { exp: Date.now() + ttl, value };
    memoryCache.delete(key);
    memoryCache.set(key, entry);
    if (memoryCache.size > MEMORY_MAX) memoryCache.delete(memoryCache.keys().next().value);
    if (!persist || !session) return;
    let raw;
    try { raw = JSON.stringify(entry); } catch { return; }
    try {
        session.setItem(CACHE_PREFIX + key, raw);
    } catch {
        pruneSessionCache();
        try { session.setItem(CACHE_PREFIX + key, raw); } catch { /* tetap penuh: cukup cache memori */ }
    }
}

/** Kosongkan semua cache API (memori + sessionStorage). */
export function clearApiCache() {
    memoryCache.clear();
    if (!session) return;
    const keys = [];
    for (let i = 0; i < session.length; i++) {
        const k = session.key(i);
        if (k?.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => session.removeItem(k));
}

/* ------------------------------------------------------------------ */
/* Kesehatan sumber + circuit breaker                                  */
/* ------------------------------------------------------------------ */
const emptyHealth = () => ({ state: 'unknown', downUntil: 0, at: 0, message: '', status: 0 });

const health = (() => {
    const base = Object.fromEntries(API_SOURCES.map((s) => [s, emptyHealth()]));
    try {
        const saved = JSON.parse(session?.getItem(STORAGE_KEYS.apiHealth) || 'null');
        if (saved && typeof saved === 'object') {
            for (const s of API_SOURCES) if (saved[s]) base[s] = { ...emptyHealth(), ...saved[s] };
        }
    } catch { /* abaikan data korup */ }
    return base;
})();

const pending = Object.fromEntries(API_SOURCES.map((s) => [s, 0]));

function saveHealth() {
    try { session?.setItem(STORAGE_KEYS.apiHealth, JSON.stringify(health)); } catch { /* abaikan */ }
}

function emitHealth(source) {
    window.dispatchEvent(new CustomEvent(HEALTH_EVENT, { detail: { source, ...health[source] } }));
}

function markHealth(source, ok, err) {
    if (!health[source]) return;
    const prev = health[source];
    const now = Date.now();
    health[source] = ok
        ? { state: 'online', downUntil: 0, at: now, message: '', status: 0 }
        : {
            state: 'offline',
            // Hormati Retry-After bila ada (maks 5 menit); selain itu jeda standar.
            downUntil: now + (err?.retryAfter ? Math.min(err.retryAfter, 300) * 1000 : API_CONFIG.circuitMs),
            at: now,
            message: err?.message || '',
            // Status HTTP kegagalan terakhir → pesan ramah yang tepat walau request berikutnya kena circuit.
            status: err?.status || 0,
        };
    saveHealth();
    if (prev.state !== health[source].state || !ok) emitHealth(source);
}

/** true jika sumber baru saja gagal dan sedang "diistirahatkan". */
export function isCircuitOpen(source) {
    return (health[source]?.downUntil || 0) > Date.now();
}

export function getHealth(source) {
    return { ...(health[source] || emptyHealth()) };
}

export function getAllHealth() {
    return Object.fromEntries(API_SOURCES.map((s) => [s, getHealth(s)]));
}

/** Jumlah request yang sedang berjalan ke sumber tertentu. */
export function pendingRequests(source) {
    return pending[source] || 0;
}

/**
 * Pantau perubahan status sumber.
 * @param {(change: {source:string,state:string}, all: ReturnType<typeof getAllHealth>) => void} callback
 * @returns {() => void} fungsi untuk berhenti memantau
 */
export function onHealthChange(callback) {
    const handler = (e) => callback(e.detail, getAllHealth());
    window.addEventListener(HEALTH_EVENT, handler);
    return () => window.removeEventListener(HEALTH_EVENT, handler);
}

/** Buka semua circuit (dipakai saat koneksi internet kembali). */
export function resetCircuits() {
    let changed = false;
    for (const s of API_SOURCES) {
        if (health[s].downUntil) {
            health[s].downUntil = 0;
            changed = true;
        }
    }
    if (changed) saveHealth();
}
window.addEventListener('online', resetCircuits);

/** Error yang menandakan SUMBER-nya bermasalah (bukan sekadar request yang salah). */
function isSourceFailure(err) {
    if (err.kind === 'timeout' || err.kind === 'network' || err.kind === 'parse') return true;
    // 404 tanpa body JSON di /api = tidak ada backend di origin ini (mis. hosting/Live Server statis).
    // 404 berbentuk {ok:false} dari backend kita = "anime/episode tidak ada" → sumbernya sehat.
    if (err.source === 'backend' && err.kind === 'http' && err.status === 404 && !err.payload) return true;
    if (err.kind === 'http' || err.kind === 'graphql') {
        return err.status >= 500 || err.status === 403 || err.status === 429 || err.status === 0;
    }
    return false;
}

/* ------------------------------------------------------------------ */
/* Throttle per host                                                   */
/* ------------------------------------------------------------------ */
const throttleNext = new Map(); // key → timestamp giliran berikutnya

async function waitTurn({ key, interval }, signal, source) {
    const now = Date.now();
    const at = Math.max(now, throttleNext.get(key) || 0);
    throttleNext.set(key, at + interval);
    if (at > now) await sleep(at - now, signal, source);
}

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */
async function attemptFetch(url, { method, headers, body, timeout, signal, source }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeout);
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
        const res = await fetch(url, {
            method,
            headers,
            body,
            signal: controller.signal,
            // AniList menolak request tanpa Referer → pastikan origin selalu terkirim.
            referrerPolicy: 'strict-origin-when-cross-origin',
        });
        const text = await res.text();
        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch {
                if (res.ok) throw new ApiError('Respons server bukan JSON.', { kind: 'parse', status: res.status, source });
            }
        }
        if (!res.ok) {
            const retryAfter = Number.parseInt(res.headers.get('Retry-After') || '', 10) || 0;
            const detail = json?.errors?.[0]?.message || json?.errors?.[0]?.detail || json?.message || json?.error;
            throw new ApiError(String(detail || `HTTP ${res.status}`).slice(0, 200), { kind: 'http', status: res.status, source, retryAfter, payload: json });
        }
        return json;
    } catch (err) {
        if (err instanceof ApiError) throw err;
        if (err?.name === 'AbortError') {
            throw timedOut
                ? new ApiError(`Waktu habis (${Math.round(timeout / 1000)} dtk).`, { kind: 'timeout', source })
                : abortError(source);
        }
        throw new ApiError(err?.message || 'Gagal terhubung.', { kind: 'network', source, cause: err });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

function backoffDelay(attempt, retryAfter) {
    if (retryAfter) return Math.min(retryAfter, 5) * 1000;
    return 600 * 2 ** (attempt - 1) + Math.random() * 250;
}

/**
 * Ambil JSON dengan timeout, retry, cache, dedupe, throttle & pelacakan kesehatan.
 *
 * @param {string} url
 * @param {{
 *   source?: 'anilist'|'kitsu'|'backend',
 *   method?: string,
 *   headers?: Record<string,string>,
 *   body?: unknown,                 objek → JSON.stringify
 *   timeout?: number,               ms per percobaan
 *   retries?: number,
 *   ttl?: number,                   ms; 0 = tanpa cache
 *   cacheKey?: string,              default: hash dari method+url+body
 *   persist?: boolean,              simpan juga di sessionStorage (default true)
 *   signal?: AbortSignal,
 *   throttle?: {key:string, interval:number},
 *   validate?: (json:any) => any,   lempar error untuk menolak respons
 *   transform?: (json:any) => any,  hasilnya yang di-cache & dikembalikan
 *   force?: boolean,                abaikan circuit breaker (cek ulang manual)
 * }} [options]
 */
export function fetchJSON(url, options = {}) {
    const {
        source = 'other',
        method = 'GET',
        headers,
        body,
        timeout = 8000,
        retries = API_CONFIG.retries,
        ttl = 0,
        cacheKey,
        persist = true,
        signal,
        throttle,
        validate,
        transform,
        force = false,
    } = options;

    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const key = cacheKey || `${source}:${hashKey(`${method} ${url} ${payload || ''}`)}`;

    if (ttl > 0) {
        const cached = cacheGet(key);
        if (cached !== undefined) return Promise.resolve(cached);
    }
    if (signal?.aborted) return Promise.reject(abortError(source));
    if (!force && isCircuitOpen(source)) {
        return Promise.reject(new ApiError('Sumber sedang dilewati sementara (baru saja gagal).', { kind: 'circuit', source, status: health[source]?.status || 0 }));
    }
    // Dedupe hanya untuk request tanpa signal pemanggil (mis. section homepage yang
    // berbagi satu query gabungan). Request yang bisa dibatalkan berjalan sendiri.
    if (!signal && inflight.has(key)) return inflight.get(key);

    const run = async () => {
        if (pending[source] !== undefined) pending[source]++;
        try {
            for (let attempt = 0; ; attempt++) {
                try {
                    if (throttle) await waitTurn(throttle, signal, source);
                    const json = await attemptFetch(url, { method, headers, body: payload, timeout, signal, source });
                    const valid = validate ? validate(json) : json;
                    const value = transform ? transform(valid) : valid;
                    markHealth(source, true);
                    if (ttl > 0) cacheSet(key, value, ttl, persist);
                    return value;
                } catch (rawErr) {
                    const err = rawErr instanceof ApiError
                        ? rawErr
                        : new ApiError(rawErr?.message || 'Data tidak valid.', { kind: 'parse', source, cause: rawErr });
                    if (err.kind === 'abort') throw err;
                    const retryable = attempt < retries && (
                        err.kind === 'network'
                        || (err.kind === 'http' && (err.status >= 500 || (err.status === 429 && (err.retryAfter || 0) <= 5)))
                    );
                    if (retryable) {
                        await sleep(backoffDelay(attempt + 1, err.retryAfter), signal, source);
                        continue;
                    }
                    if (isSourceFailure(err)) markHealth(source, false, err);
                    else if (err.kind === 'http' || err.kind === 'graphql') markHealth(source, true); // server merespons
                    throw err;
                }
            }
        } finally {
            if (pending[source] !== undefined) pending[source]--;
        }
    };

    const promise = run();
    if (!signal) {
        inflight.set(key, promise);
        promise.then(() => inflight.delete(key), () => inflight.delete(key));
    }
    return promise;
}

/* ------------------------------------------------------------------ */
/* Pesan error untuk pengguna                                          */
/* ------------------------------------------------------------------ */
/**
 * Ubah error apa pun menjadi kalimat yang ramah (Bahasa Indonesia).
 * @param {unknown} err
 * @returns {string}
 */
export function friendlyError(err) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return 'Kamu sedang offline. Periksa koneksi internet lalu coba lagi.';
    }
    const e = err instanceof ApiError ? err : null;
    if (!e) return 'Terjadi kesalahan saat memuat data. Coba lagi.';
    switch (e.kind) {
        case 'timeout': return 'Server terlalu lama merespons. Coba lagi sebentar lagi.';
        case 'network': return 'Tidak dapat terhubung ke server data anime.';
        case 'blocked':
            if (e.stage === 'robots') {
                return e.status
                    ? `Akses dibatasi pada pemeriksaan robots.txt (HTTP ${e.status}); sumber dilewati.`
                    : 'Akses dibatasi pada pemeriksaan robots.txt atau challenge keamanan; sumber dilewati.';
            }
            if (e.status === 429) return 'Sumber membatasi permintaan (HTTP 429); tidak dicoba ulang otomatis.';
            if (e.status === 403) return 'Sumber menolak akses (HTTP 403); permintaan dihentikan tanpa menerobos pembatasan.';
            return 'Sumber mengirim challenge keamanan; permintaan dihentikan.';
        case 'robots':
            if (e.stage === 'robots' && e.status >= 200 && e.status < 300) {
                return 'robots.txt berhasil dibaca, tetapi jalur yang diminta tidak diizinkan; sumber dilewati.';
            }
            if (e.status >= 400) return `robots.txt tidak dapat diverifikasi (HTTP ${e.status}); sumber dilewati sementara.`;
            return 'Sumber dilewati karena aturan robots.txt tidak bisa diverifikasi.';
        case 'policy':
            if (e.stage === 'robots' && e.status === 404) return 'robots.txt tidak tersedia dan izin sumber belum dapat diverifikasi; sumber dilewati.';
            return 'Akses otomatis ke sumber ini tidak diaktifkan sampai kebijakannya dapat diverifikasi.';
        case 'rate_limited': return 'Sumber membatasi permintaan (HTTP 429); hormati waktu Retry-After sebelum mencoba lagi.';
        case 'circuit':
            if (e.status === 403) return 'Akses ke sumber data sedang dibatasi oleh penyedianya.';
            if (e.status === 429) return 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.';
            return 'Sumber data sedang gangguan. Akan dicoba lagi otomatis sebentar lagi.';
        case 'abort': return 'Permintaan dibatalkan.';
        case 'parse': return 'Struktur halaman sumber berubah atau data tidak dikenali.';
        case 'disabled': return e.message;
        case 'empty': return 'Tidak ada data yang ditemukan.';
        default:
            if (e.status === 429) return 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.';
            if (e.status === 403) return 'Akses ke sumber data sedang dibatasi oleh penyedianya.';
            if (e.status === 404) return 'Data tidak ditemukan.';
            if (e.status >= 500) return 'Server sumber data sedang gangguan.';
            return 'Terjadi kesalahan saat memuat data. Coba lagi.';
    }
}
