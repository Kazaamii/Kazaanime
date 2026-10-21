/**
 * Kazanime — services/bookmark.js
 * Bookmark per akun. TIDAK ada UI di sini (toast & modal login diurus ui/layout.js).
 *
 * Kompatibel dengan file asli: bookmark tetap disimpan di
 *   users[username].bookmarks = [{ title, episode, image, addedAt }, ...]
 * Item baru menambahkan field normalisasi (id, ids, score, status, format, ...)
 * TANPA menghapus field lama, jadi data tetap terbaca oleh versi lama.
 *
 * Perbaikan:
 *  - Dulu bookmark dicocokkan HANYA lewat judul → judul sama dari sumber berbeda
 *    bentrok, dan judul berisi tanda kutip memutus onclick. Sekarang dicocokkan
 *    lewat ID sumber (AniList/MAL/Kitsu) bila ada, judul hanya sebagai cadangan.
 *  - Satu sumber kebenaran + event 'kazanime:bookmarks' → semua tombol bookmark
 *    (kartu, hero, halaman nonton, navbar badge) ikut berubah, juga antar-tab.
 *  - Hasil baca di-cache di memori (dulu localStorage di-parse ulang untuk
 *    SETIAP kartu yang dirender).
 */
import { readCurrentRecord, updateCurrentRecord, onAuthChange } from './auth.js';
import { createAnime, episodeLabel, isSameAnime } from '../api/normalize.js';

const EVENT = 'kazanime:bookmarks';

/** @typedef {import('../api/normalize.js').Anime} Anime */

/* ------------------------------------------------------------------ */
/* Konversi                                                            */
/* ------------------------------------------------------------------ */
/** Anime → item tersimpan (field lama + field baru). */
function toStored(anime) {
    return {
        // format lama (dibaca file asli)
        title: anime.title,
        episode: episodeLabel(anime),
        image: anime.image || null,
        addedAt: Date.now(),
        // tambahan Tahap B
        id: anime.id,
        ids: { ...anime.ids },
        titleAlt: anime.titleAlt || '',
        score: anime.score,
        status: anime.status,
        format: anime.format,
        year: anime.year,
        episodes: anime.episodes,
        latestEpisode: anime.latestEpisode,
        source: anime.source,
        slug: anime.slug,
        color: anime.color,
    };
}

/** Item tersimpan (lama ATAU baru) → Anime. */
function fromStored(item) {
    const epNum = /(\d+)/.exec(String(item.episode || ''))?.[1];
    const legacyStatus = item.episode === 'Completed' ? 'COMPLETED' : epNum || item.episode === 'Ongoing' ? 'ONGOING' : 'UNKNOWN';
    return createAnime({
        id: item.id,
        title: item.title,
        titleAlt: item.titleAlt,
        image: item.image,
        ids: item.ids || {},
        score: typeof item.score === 'number' ? item.score : null,
        status: item.status || legacyStatus,
        format: item.format,
        year: item.year,
        episodes: item.episodes,
        latestEpisode: item.latestEpisode ?? (epNum ? Number(epNum) : null),
        source: item.source || 'fallback',
        slug: item.slug,
        color: item.color,
    });
}

/**
 * Apakah item tersimpan mewakili anime yang sama? → isSameAnime() di api/normalize.js
 * (ID sejenis = penentu, judul hanya cadangan). Dipakai juga oleh riwayat tontonan.
 */
const sameAnime = isSameAnime;

/* ------------------------------------------------------------------ */
/* Cache memori                                                        */
/* ------------------------------------------------------------------ */
let cache = null; // { key: username, raw: item[], list: Anime[] } | null

function load() {
    const current = readCurrentRecord();
    if (!current) {
        cache = null;
        return null;
    }
    if (!cache || cache.key !== current.key) {
        const raw = Array.isArray(current.record.bookmarks)
            ? current.record.bookmarks.filter((b) => b && typeof b === 'object' && b.title)
            : [];
        cache = { key: current.key, raw, list: raw.map(fromStored) };
    }
    return cache;
}

function invalidate() {
    cache = null;
}

function emit(detail) {
    window.dispatchEvent(new CustomEvent(EVENT, { detail }));
}

/* Login/logout/sinkron antar-tab → daftar bookmark berubah */
onAuthChange(() => {
    invalidate();
    emit({ reason: 'auth' });
});

/* ------------------------------------------------------------------ */
/* API publik                                                          */
/* ------------------------------------------------------------------ */
/** Semua bookmark user aktif (urutan simpan, sama seperti file asli). @returns {Anime[]} */
export function getBookmarks() {
    return load()?.list.slice() || [];
}

export function bookmarkCount() {
    return load()?.raw.length || 0;
}

/** @param {Anime} anime */
export function isBookmarked(anime) {
    const state = load();
    return Boolean(state && anime && state.raw.some((b) => sameAnime(b, anime)));
}

/**
 * Tambah/hapus bookmark.
 * @param {Anime} anime
 * @returns {{ok:true, bookmarked:boolean} | {ok:false, reason:'auth'|'storage'}}
 */
export function toggleBookmark(anime) {
    if (!load()) return { ok: false, reason: 'auth' };
    let bookmarked = false;
    const saved = updateCurrentRecord((record) => {
        const list = Array.isArray(record.bookmarks) ? record.bookmarks : [];
        const index = list.findIndex((b) => b && sameAnime(b, anime));
        if (index > -1) {
            list.splice(index, 1);
            bookmarked = false;
        } else {
            list.push(toStored(anime));
            bookmarked = true;
        }
        record.bookmarks = list;
    });
    invalidate();
    if (!saved) return { ok: false, reason: 'storage' };
    emit({ reason: bookmarked ? 'add' : 'remove', id: anime.id });
    return { ok: true, bookmarked };
}

/** Hapus bookmark (tanpa efek bila tidak ada). @param {Anime} anime */
export function removeBookmark(anime) {
    if (!isBookmarked(anime)) return { ok: true, bookmarked: false };
    return toggleBookmark(anime);
}

/**
 * Pantau perubahan bookmark (tambah/hapus/login/logout/tab lain).
 * @param {(list: Anime[], detail: {reason:string}) => void} callback
 * @returns {() => void}
 */
export function onBookmarksChange(callback) {
    const handler = (e) => callback(getBookmarks(), e.detail || {});
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
}
