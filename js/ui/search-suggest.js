/**
 * Kazanime — ui/search-suggest.js
 * Pengelompokan saran pencarian header. Dipisah dari DOM supaya bisa diuji tanpa browser.
 *
 * 24 Okt 2026 (putaran 7) — permintaan pengguna: "gabungkan pencarian data yg di top
 * header jangan dari kitsu dan anilist saja, gunakan yg di anime ku dan oploverz juga".
 * Hasil situs (AnimeKu & Oploverz) masuk sebagai grup sendiri:
 *
 *  - Hanya AnimeKu & Oploverz yang ditampilkan; adapter lain boleh ikut dicari backend
 *    tetapi tidak ditampilkan supaya dropdown tetap ringkas dan sesuai permintaan.
 *  - Item situs **tidak** dibuang walau judulnya sudah muncul dari AniList/Kitsu: yang
 *    ditawarkan berbeda — item situs membuka episode langsung dari situs (slug + src),
 *    sedangkan item metadata membuka halaman anime. Keduanya berguna.
 *  - Maksimal 3 judul per situs (AnimeKu lebih dulu) dan tanpa judul kembar di situs
 *    yang sama.
 */
import { dedupeKeys } from '../api/index.js';

/** Situs yang ikut tampil di saran pencarian header (urutan = urutan tampil). */
export const SITE_SOURCES = Object.freeze(['animeku', 'oploverz']);
export const SITE_LABELS = Object.freeze({ animeku: 'AnimeKu', oploverz: 'Oploverz' });
/** Batas judul per situs supaya dropdown tidak memanjang. */
export const SITE_PER_SOURCE = 3;

/**
 * Sumber situs dari satu item saran: `backend:animeku` → `animeku`.
 * Sumber lain (metadata, backend situs lain) → `''`.
 * @param {{source?: string}} anime
 * @returns {string}
 */
export function siteOfSuggestion(anime) {
    const raw = String(anime?.source || '');
    if (!raw.startsWith('backend:')) return '';
    const site = raw.slice('backend:'.length).split('~')[0].toLowerCase();
    return SITE_SOURCES.includes(site) ? site : '';
}

/**
 * Item situs: hanya AnimeKu/Oploverz, AnimeKu lebih dulu, maks `perSource` per situs,
 * tanpa slug kembar. Dipakai dropdown header (3/situs) dan halaman hasil pencarian
 * (batas lebih besar, lihat js/search.js).
 * @param {any[]} list
 * @param {number} [perSource]
 * @returns {any[]}
 */
export function siteResults(list, perSource = SITE_PER_SOURCE) {
    const all = Array.isArray(list) ? list : [];
    const sites = all.filter((anime) => siteOfSuggestion(anime));
    // Array#sort stabil: urutan dari backend tetap terjaga di dalam satu situs.
    const ordered = sites.sort((a, b) => SITE_SOURCES.indexOf(siteOfSuggestion(a)) - SITE_SOURCES.indexOf(siteOfSuggestion(b)));
    const out = [];
    const counts = { animeku: 0, oploverz: 0 };
    const seen = new Set();
    for (const anime of ordered) {
        const site = siteOfSuggestion(anime);
        if (counts[site] >= perSource) continue;
        const key = `${site}:${anime.slug || anime.title || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        counts[site] += 1;
        out.push(anime);
    }
    return out;
}

/**
 * Item metadata (AniList/Kitsu) dengan pembuangan duplikat lintas sumber seperti sebelumnya.
 * @param {any[]} list
 * @param {Set<string>} seen dibagi antar sumber metadata
 * @param {number} limit
 */
function metadataItems(list, seen, limit) {
    const out = [];
    for (const anime of list) {
        const keys = dedupeKeys(anime);
        if (keys.some((key) => seen.has(key))) continue;
        keys.forEach((key) => seen.add(key));
        out.push(anime);
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * Kelompokkan hasil `suggestAnime()` menjadi grup yang siap dirender.
 * `state` boleh berisi `undefined` (masih dimuat), Error (gagal), atau array (hasil).
 *
 * @param {Record<string, any>} state
 * @param {{groups?: {source:string,label:string,badge:string,name:string}[], limitOf?: (source:string)=>number}} [opts]
 * @returns {{groups: {source:string,label:string,badge:string,name:string,items:any[]}[], pending: string[], failed: number, total: number}}
 */
export function groupSuggestions(state, { groups = [], limitOf = () => 5 } = {}) {
    const seen = new Set();
    const out = [];
    const pending = [];
    let failed = 0;
    let total = 0;
    for (const group of groups) {
        const value = state?.[group.source];
        if (value === undefined) {
            pending.push(group.name);
            continue;
        }
        if (!Array.isArray(value)) {
            failed += 1;
            continue;
        }
        const items = group.source === 'backend'
            ? siteResults(value)
            : metadataItems(value, seen, limitOf(group.source));
        if (!items.length) continue;
        out.push({ ...group, items });
        total += items.length;
    }
    return { groups: out, pending, failed, total };
}
