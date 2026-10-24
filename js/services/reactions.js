/**
 * Kazanime — services/reactions.js
 * Tombol "Suka" + hitungan langsung (Count Live) per episode — putaran 14 (24 Okt 2026).
 *
 * Permintaan pengguna: *"tambahkan tombol Like/Count Live Untuk Jejak"*.
 *
 * Dua lapis, seperti fitur lain di Kazanime:
 *  1. **Jejak lokal** (selalu jalan, tanpa server): id pengunjung anonim + daftar episode yang
 *     sudah disukai disimpan di localStorage. Jadi tombol tetap berfungsi walau backend mati.
 *  2. **Hitungan bersama** (opsional): backend `/api/reactions` menyimpan satu suka per
 *     pengunjung per episode, sehingga angka yang tampil sama untuk semua orang dan naik
 *     langsung setelah diklik (optimistic update, lalu dikoreksi jawaban server).
 *
 * Privasi: tidak ada nama/email/IP yang dikirim — hanya id acak per perangkat
 * (`kz:visitor`) dan key episode (mis. `animeku~judul~ep3`). Bila pengguna menghapus data
 * situs, id baru dibuat dan suka lama tidak bisa dibatalkan (hitungan tetap, tidak turun).
 *
 * Tidak ada UI di file ini.
 */
import { API_CONFIG, STORAGE_KEYS } from '../config.js';
import { storage } from './storage.js';
import { fetchJSON } from '../api/http.js';

/** Key episode yang dipakai backend: `slug~ep12` (huruf kecil, [a-z0-9~._:-]). */
export function episodeKey({ slug, title, ep } = {}) {
    const base = String(slug || title || '').toLowerCase()
        .replace(/^backend:/, '')
        .replace(/[^a-z0-9~._:-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 100);
    if (!base) return '';
    const number = Number(ep);
    const suffix = Number.isInteger(number) && number > 0 ? `~ep${number}` : '';
    return `${base}${suffix}`.slice(0, 120);
}

/** Id pengunjung anonim per perangkat (8–64 karakter: huruf kecil, angka, tanda hubung). */
export function visitorId() {
    const saved = storage.getRaw(STORAGE_KEYS.visitor);
    if (saved && /^[a-z0-9-]{8,64}$/.test(saved)) return saved;
    const random = (() => {
        try {
            if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
        } catch {
            // peramban lama / konteks tidak aman → jatuh ke Math.random
        }
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    })();
    const id = String(random).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40).padEnd(12, '0');
    storage.setRaw(STORAGE_KEYS.visitor, id);
    return id;
}

/** Semua episode yang sudah disukai di perangkat ini. */
function readLiked() {
    const raw = storage.get(STORAGE_KEYS.likes, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export function isLiked(key) {
    return Boolean(key) && readLiked()[key] === true;
}

/** @param {string} key @param {boolean} liked */
function writeLiked(key, liked) {
    const all = readLiked();
    if (liked) all[key] = true;
    else delete all[key];
    // Batasi supaya localStorage tidak tumbuh tanpa henti (paling baru dipertahankan).
    const keys = Object.keys(all);
    if (keys.length > 500) {
        for (const stale of keys.slice(0, keys.length - 500)) delete all[stale];
    }
    storage.set(STORAGE_KEYS.likes, all);
}

const apiBase = () => String(API_CONFIG.backend?.baseUrl || '').replace(/\/+$/, '');

/**
 * Hitungan bersama untuk beberapa episode sekaligus.
 * Fail-open: backend mati/DNS → `{}` dan UI memakai jejak lokal saja.
 * @param {string[]} keys
 * @returns {Promise<Record<string, number>>}
 */
export async function getReactionCounts(keys = []) {
    const list = [...new Set(keys.filter(Boolean))].slice(0, 20);
    if (!list.length || !API_CONFIG.backend?.enabled) return {};
    try {
        const json = await fetchJSON(`${apiBase()}/api/reactions?keys=${encodeURIComponent(list.join(','))}`, {
            source: 'backend',
            ttl: 0,
            timeout: 6000,
            noCache: true,
        });
        const counts = json?.data?.counts;
        if (!counts || typeof counts !== 'object') return {};
        return Object.fromEntries(Object.entries(counts)
            .map(([key, value]) => [key, Number(value)])
            .filter(([, value]) => Number.isFinite(value) && value >= 0));
    } catch {
        return {};
    }
}

/**
 * Suka / batalkan suka.
 * @param {string} key
 * @param {boolean} liked
 * @returns {Promise<{liked:boolean, count:number|null, shared:boolean}>} count null = tidak ada hitungan bersama
 */
export async function setReaction(key, liked) {
    if (!key) return { liked: false, count: null, shared: false };
    writeLiked(key, liked);
    if (!API_CONFIG.backend?.enabled) return { liked, count: null, shared: false };
    try {
        const json = await fetchJSON(`${apiBase()}/api/reactions/${encodeURIComponent(key)}`, {
            source: 'backend',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: { liked: Boolean(liked), visitor: visitorId() },
            ttl: 0,
            timeout: 6000,
            noCache: true,
            persist: false,
        });
        const data = json?.data;
        const count = Number(data?.count);
        return {
            liked: data?.liked === undefined ? liked : Boolean(data.liked),
            count: Number.isFinite(count) ? count : null,
            shared: data?.enabled !== false,
        };
    } catch {
        // Backend mati: jejak lokal tetap tersimpan, tombol jangan terasa "gagal".
        return { liked, count: null, shared: false };
    }
}

/** Jumlah episode yang pernah disukai (dipakai ringkasan "Jejak"). */
export function likedCount() {
    return Object.keys(readLiked()).length;
}
