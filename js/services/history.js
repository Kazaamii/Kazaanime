/**
 * Kazanime — services/history.js
 * Riwayat tontonan lokal (per browser, tanpa akun): episode mana saja yang sudah
 * dibuka untuk tiap anime → penanda "sudah ditonton" di daftar episode watch.html.
 * TIDAK ada UI di sini.
 *
 * Disimpan di localStorage `kz:history` sebagai daftar (terbaru di depan):
 *   [{ ids:{anilist,mal,kitsu}, title, eps:[1,2,5], last:5, at:<ms> }, ...]
 * Dicocokkan dengan isSameAnime() (id sejenis, judul sebagai cadangan) — sama
 * dengan bookmark, jadi membuka anime dari sumber berbeda tetap tercatat satu.
 */
import { STORAGE_KEYS } from '../config.js';
import { storage } from './storage.js';
import { isSameAnime } from '../api/normalize.js';

const MAX_ANIME = 150;
const MAX_EPISODES = 3000;

function readAll() {
    const list = storage.get(STORAGE_KEYS.history, []);
    return Array.isArray(list) ? list.filter((e) => e && typeof e === 'object' && Array.isArray(e.eps)) : [];
}

/**
 * Episode yang sudah dibuka untuk anime ini.
 * @param {import('../api/normalize.js').Anime} anime
 * @returns {Set<number>}
 */
export function getWatchedEpisodes(anime) {
    const entry = readAll().find((e) => isSameAnime(e, anime));
    return new Set((entry?.eps || []).filter((n) => Number.isInteger(n) && n > 0));
}

/**
 * Catat episode sebagai sudah dibuka (entri dipindah ke depan, id dilengkapi).
 * @param {import('../api/normalize.js').Anime} anime
 * @param {number} ep
 * @returns {boolean} false bila penyimpanan gagal
 */
export function markWatched(anime, ep) {
    if (!anime?.title || !Number.isInteger(ep) || ep < 1) return false;
    const list = readAll();
    const index = list.findIndex((e) => isSameAnime(e, anime));
    const entry = index > -1 ? list.splice(index, 1)[0] : { ids: {}, title: anime.title, eps: [] };
    entry.ids = {
        anilist: anime.ids?.anilist || entry.ids?.anilist || null,
        mal: anime.ids?.mal || entry.ids?.mal || null,
        kitsu: anime.ids?.kitsu || entry.ids?.kitsu || null,
    };
    entry.title = anime.title;
    if (!entry.eps.includes(ep)) entry.eps.push(ep);
    if (entry.eps.length > MAX_EPISODES) entry.eps = entry.eps.slice(-MAX_EPISODES);
    entry.last = ep;
    entry.at = Date.now();
    list.unshift(entry);
    return storage.set(STORAGE_KEYS.history, list.slice(0, MAX_ANIME));
}
