/**
 * Kazanime — api/streams.js
 * Sumber video & link download untuk SATU episode.
 *
 *  - Server statis  : config.STREAMING_SERVERS, URL embed dibangun dari id anime
 *                     (AniList / MAL / Kitsu). Tanpa request jaringan.
 *  - Server backend : (Tahap D, aktif) scraper menambahkan server embed + link download
 *                     lewat GET /api/anime/:slug/episode/:ep.
 *
 * UI (ui/player.js) hanya menerima objek StreamServer yang sudah jadi dan tidak
 * tahu pola URL penyedia mana pun. Menambah/mengganti penyedia = ubah config.js
 * atau adapter backend — tanpa menyentuh UI.
 *
 * @typedef {Object} StreamServer
 * @property {string}   id
 * @property {string}   name
 * @property {string}   flag         emoji di depan nama ('' bila tidak ada)
 * @property {string}   description  tooltip
 * @property {string}   badge        label kecil (mis. nama situs sumber backend)
 * @property {string|null} url       URL embed (null = tidak tersedia)
 * @property {boolean}  available
 * @property {string}   reason       alasan tidak tersedia (untuk tooltip/toast)
 * @property {string}   source       'static' | 'backend:<situs>'
 * @property {string[]} origins      origin yang boleh mengirim postMessage untuk server ini
 *
 * @typedef {{quality:string, size:string, format?:string, subtitle?:string, links:{provider:string, url:string}[]}} DownloadGroup
 */
import { STREAMING_SERVERS } from '../config.js';
import { ApiError } from './http.js';
import { originOf, titleKey, toHttpUrl } from './normalize.js';
import * as backend from './sources.js';

const ID_LABELS = { anilist: 'AniList', mal: 'MyAnimeList', kitsu: 'Kitsu' };

/**
 * Server statis untuk satu episode, urut sesuai config (= urutan fallback).
 * Server yang id-nya tidak ada tetap dikembalikan (available:false) agar tampil 🔒.
 * @param {import('./normalize.js').Anime} anime
 * @param {number} ep
 * @returns {StreamServer[]}
 */
export function listStreamServers(anime, ep) {
    const ids = anime?.ids || {};
    return STREAMING_SERVERS.filter((s) => s.enabled !== false).map((s) => {
        const hasId = !s.needs || Boolean(ids[s.needs]);
        let url = '';
        if (hasId) {
            try {
                url = toHttpUrl(s.url({ anilist: ids.anilist, mal: ids.mal, kitsu: ids.kitsu, ep, title: anime?.title || '' }));
            } catch (err) {
                console.warn(`[streams] url() server "${s.id}" error:`, err);
            }
        }
        let reason = '';
        if (!url) reason = hasId ? 'URL server tidak valid (cek config.js)' : `ID ${ID_LABELS[s.needs] || s.needs} tidak tersedia untuk anime ini`;
        return {
            id: s.id,
            name: s.name,
            flag: s.flag || '',
            description: s.description || '',
            badge: s.badge || '',
            url: url || null,
            available: Boolean(url),
            reason,
            source: 'static',
            origins: [originOf(url), ...(s.origins || [])].filter(Boolean),
        };
    });
}

/** Cari slug anime di backend lewat judul (hasil di-cache oleh http.js). */
async function findBackendSlug(anime, { signal } = {}) {
    const res = await backend.searchBackend(anime.title, { signal });
    const keys = [titleKey(anime.title), titleKey(anime.titleAlt)].filter(Boolean);
    const hit = res.items.find((a) => keys.includes(titleKey(a.title)) || keys.includes(titleKey(a.titleAlt)));
    return hit?.slug || null;
}

/**
 * Server tambahan + link download dari backend scraper.
 * Tanpa backend (dinonaktifkan di config, atau tidak berjalan di origin ini) langsung
 * selesai dengan `disabled: true` — bukan error.
 * @param {import('./normalize.js').Anime} anime
 * @param {number} ep
 * @param {{slug?: string|null, signal?: AbortSignal}} [opts]  slug dari URL (item yang berasal dari backend)
 * @returns {Promise<{servers: StreamServer[], downloads: DownloadGroup[], source: string|null, disabled?: boolean, error?: ApiError}>}
 */
export async function getEpisodeExtras(anime, ep, { slug, signal } = {}) {
    const disabled = { servers: [], downloads: [], source: null, disabled: true };
    if (!backend.isBackendEnabled()) return disabled;
    try {
        const target = slug || anime.slug || await findBackendSlug(anime, { signal });
        if (!target) {
            return {
                servers: [],
                downloads: [],
                source: null,
                error: new ApiError('Anime ini belum ada di sumber backend.', { kind: 'empty', source: 'backend' }),
            };
        }
        const media = await backend.getBackendEpisode(target, ep, { signal });
        return { servers: media.servers, downloads: media.downloads, source: media.source };
    } catch (err) {
        if (err?.kind === 'disabled') return disabled;
        throw err;
    }
}
