/**
 * Kazanime — api/streams.js
 * Sumber video & link download untuk SATU episode.
 *
 *  - Server scraping : backend (server/sources/ — AnimeXin, Samehadaku) lewat
 *                      GET /api/anime/:slug/episode/:ep → server embed + link download
 *                      dari situs sumber. Anime yang dibuka dari AniList/MAL/Kitsu (tanpa slug)
 *                      dicarikan padanannya di backend lewat judul (findBackendMatch).
 *                      Urutan putar (scraping dulu / statis dulu) diatur PLAYER.serverOrder.
 *  - Server statis   : config.STREAMING_SERVERS (MegaPlay, Vidnest, TryEmbed — berbasis id AniList),
 *                      URL embed dibangun dari id anime. Tanpa request jaringan — cadangan otomatis.
 *                      (24 Okt 2026: slot penyedia ReAnime/AniZone dihapus karena backend selalu
 *                      ditolak Cloudflare 403 → tombolnya tidak pernah bisa memutar apa pun.)
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
 * @property {string}   lang         bahasa subtitle: 'id' | 'en' | 'multi' | '' (tidak diketahui)
 * @property {'hard'|'soft'} [subtitleType] jenis subtitle bila dicantumkan eksplisit oleh sumber
 * @property {string[]} origins      origin yang boleh mengirim postMessage untuk server ini
 * @property {'embed'|'hls'|'video'} [kind]  'hls'/'video' = player video bawaan (AniZone/AnimeOnsen), selain itu iframe
 * @property {string[]|null} [mirrors] URL cadangan penyedia yang sama (dicoba berurutan sebelum pindah server)
 * @property {string} [direct]       (hls) URL CDN untuk HLS native Safari/iOS
 * @property {{label:string, lang:string, url:string, default:boolean}[]} [subtitles] (hls) track WebVTT
 * @property {{url:string, from:string, sourceLabel:string, label:string}|null} [ai] (hls, 22 Okt 2026) tawaran
 *           "Subtitle Indonesia (AI)" dari backend — hanya ada bila episode TIDAK punya subtitle Indonesia
 *           dan backend punya GEMINI_API_KEY (lihat ui/ai-subtitle.js)
 *
 * @typedef {{quality:string, size:string, format?:string, subtitle?:string, links:{provider:string, url:string}[]}} DownloadGroup
 */
import { STREAMING_SERVERS } from '../config.js';
import { ApiError } from './http.js';
import { looseTitleKey, originOf, stripSeasonSuffix, titleKey, titleVariants, toHttpUrl } from './normalize.js';
import * as backend from './sources.js';

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
        // Alasan untuk pengguna tanpa nama penyedia / database (detail teknis ada di console).
        let reason = '';
        if (!url) {
            reason = hasId ? 'Server ini sedang tidak bisa dipakai' : 'Server ini belum tersedia untuk anime ini';
            if (hasId) console.warn(`[streams] url() server "${s.id}" menghasilkan URL tidak valid (cek config.js).`);
        }
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
            lang: s.lang || '',
            origins: [originOf(url), ...(s.origins || [])].filter(Boolean),
        };
    });
}

/* ------------------------------------------------------------------ */
/* Mencocokkan anime (AniList/MAL/Kitsu) dengan anime di situs sumber  */
/* ------------------------------------------------------------------ */
/** Maks. kata kunci berbeda yang dicari per anime (tiap kata kunci = 1 request backend, di-cache). */
const MAX_SEARCH_TITLES = 4;

/** Daftar judul → tanpa duplikat (titleKey), tanpa kosong. */
function uniqueTitles(list) {
    const seen = new Set();
    return list
        .map((t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 100))
        .filter((t) => {
            const k = titleKey(t);
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
        });
}

/**
 * Judul untuk dicari di backend: judul utama + judul alternatif (romaji), plus judul tambahan
 * (mis. judul dari URL dan dari detail). Samehadaku memakai judul romaji ("Kusuriya no
 * Hitorigoto 3rd Season"), AnimeXin pinyin + Inggris — judul Inggris saja sering tidak ketemu.
 * @param {{title?: string, titleAlt?: string}|string[]} source  objek anime atau daftar judul
 */
function titleList(source) {
    return uniqueTitles(Array.isArray(source) ? source : [source?.title, source?.titleAlt]);
}

/**
 * Item backend yang mewakili anime yang sama. Dua tahap:
 *  1. judul persis (titleKey) — termasuk bagian dalam/luar kurung "Pinyin [English]"
 *  2. judul longgar (looseTitleKey) — "3rd Season" = "Season 3", tanpa kata sandang
 * Nomor season tetap harus sama, jadi season lain tidak ikut tercocokkan.
 * @param {{title?: string, titleAlt?: string}|string[]} anime  objek anime atau daftar judulnya
 * @param {import('./normalize.js').Anime[]} items
 */
export function matchBackendItem(anime, items) {
    const mine = titleList(anime).flatMap(titleVariants);
    const strict = new Set(mine.map(titleKey).filter(Boolean));
    const loose = new Set(mine.map(looseTitleKey).filter(Boolean));
    const variantsOf = (item) => [item.title, item.titleAlt].flatMap(titleVariants);
    return items.find((item) => variantsOf(item).some((t) => strict.has(titleKey(t))))
        || items.find((item) => variantsOf(item).some((t) => loose.has(looseTitleKey(t))))
        || null;
}

/**
 * Cari padanan anime di situs sumber backend lewat judul (semua judul dicari bersamaan;
 * hasil di-cache http.js, jadi judul yang sama tidak diminta 2x). Hasil dari API metadata
 * (fallback: semua scraper gagal) diabaikan — slug metadata tidak punya halaman episode.
 * @param {import('./normalize.js').Anime} anime
 * @param {{titles?: string[], signal?: AbortSignal}} [opts]  titles = semua judul yang diketahui (default: judul anime)
 * @returns {Promise<{slug: string, title: string, source: string}|null>}
 */
export async function findBackendMatch(anime, opts = {}) {
    return (await findBackendMatches(anime, opts))[0] || null;
}

/**
 * Padanan anime di SETIAP situs sumber backend (maks satu per situs, urutan prioritas hasil backend).
 * Backend mengirim judul yang sama dari situs berbeda (dedupe per sumber sejak 22 Okt 2026), jadi
 * halaman nonton bisa menggabungkan server Samehadaku + Otakudesu + hianime.ro sekaligus.
 * @param {import('./normalize.js').Anime} anime
 * @param {{titles?: string[], signal?: AbortSignal}} [opts]
 * @returns {Promise<{slug: string, title: string, source: string}[]>}
 */
/** Cache padanan situs per anime (sesi ini) — menjaga daftar server tetap konsisten antar episode. */
const MATCH_TTL_MS = 30 * 60 * 1000;
const MATCH_STORAGE_KEY = 'kz:matches:v1';

const matchCacheKey = (titles) => [...new Set(titles.map((t) => titleKey(t)).filter(Boolean))].sort().join('|');

/** @returns {{at:number, list:{slug:string,title:string,source:string}[]}|null} */
function readMatchCache(key) {
    if (!key) return null;
    try {
        const raw = JSON.parse(sessionStorage.getItem(MATCH_STORAGE_KEY) || '{}');
        const hit = raw?.[key];
        if (!hit || !Array.isArray(hit.list) || Date.now() - Number(hit.at || 0) > MATCH_TTL_MS) return null;
        return hit.list.length ? hit : null;
    } catch {
        return null;
    }
}

function writeMatchCache(key, list) {
    if (!key) return;
    try {
        const raw = JSON.parse(sessionStorage.getItem(MATCH_STORAGE_KEY) || '{}');
        raw[key] = { at: Date.now(), list };
        // Buang entri kedaluwarsa supaya sessionStorage tidak tumbuh terus.
        const now = Date.now();
        for (const [k, v] of Object.entries(raw)) {
            if (!v || now - Number(v.at || 0) > MATCH_TTL_MS) delete raw[k];
        }
        sessionStorage.setItem(MATCH_STORAGE_KEY, JSON.stringify(raw));
    } catch {
        // mode privat / kuota penuh → cache hanya di memori proses ini
    }
}

/** Padanan situs dari cache (tanpa jaringan) — dipakai untuk menjaga urutan server stabil. */
export function cachedBackendMatches(anime, { titles } = {}) {
    const key = matchCacheKey(titleList(titles?.length ? titles : anime));
    return readMatchCache(key)?.list || null;
}

/**
 * Jeda yang bisa dibatalkan (dipakai saat mencoba ulang sumber Sub Indo).
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
const wait = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const id = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(id); resolve(); }, { once: true });
});

export async function findBackendMatches(anime, { titles: extra, signal } = {}) {
    const titles = titleList(extra?.length ? extra : anime);
    if (!titles.length) return [];
    // Kata kunci: judul lengkap dulu, lalu judul tanpa penanda season (pencarian WordPress = semua kata
    // wajib ada). Pencocokan tetap memakai judul LENGKAP, jadi season lain tidak ikut tercocokkan.
    const queries = uniqueTitles([...titles, ...titles.map(stripSeasonSuffix)]).slice(0, MAX_SEARCH_TITLES);
    const cached = readMatchCache(matchCacheKey(titles));
    const settled = await Promise.allSettled(queries.map((q) => backend.searchBackend(q, { signal })));
    const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!ok.length) {
        // Semua pencarian gagal (throttle/offline) tetapi padanan sudah pernah ditemukan → pakai itu.
        if (cached) return cached.list;
        throw settled[0].reason;
    }
    const items = ok.filter((r) => !r.fallback).flatMap((r) => r.items).filter((a) => a.slug);
    const bySource = new Map();
    for (const it of items) {
        const site = String(it.source || '').replace(/^backend:/, '');
        if (!bySource.has(site)) bySource.set(site, []);
        bySource.get(site).push(it);
    }
    const out = [];
    for (const [site, list] of bySource) {
        const hit = matchBackendItem(titles, list);
        if (hit) out.push({ slug: hit.slug, title: hit.title, source: site });
    }
    // Hasil pertama disimpan per sesi: pergantian episode memakai daftar situs yang SAMA,
    // sehingga Sub Indo tidak "hilang" hanya karena pencarian ulang sedang gagal/di-throttle.
    if (out.length) writeMatchCache(matchCacheKey(titles), [...out].sort((a, b) => subIndoRank(a.source) - subIndoRank(b.source)));
    // AnimeKu & Oploverz (Sub Indo) dicoba lebih dulu; sisanya tetap tersedia setelahnya.
    return out.sort((a, b) => subIndoRank(a.source) - subIndoRank(b.source));
}

// Putaran 25: dub (sulih suara) selalu setelah semua jenis subtitle.
const LANG_RANK = { multi: 0, id: 1, en: 2, dub: 3 };

/**
 * Dua situs yang katalognya memang Sub Indo (24 Okt 2026). Server dari situs ini
 * diprioritaskan di halaman nonton — permintaan pengguna: "prioritaskan data anime
 * streamingnya ke Sub Indo yang sudah tersedia di kedua web itu" dan "tambahkan server
 * dari AnimeKu dan Oploverz untuk opsi stream".
 */
export const SUB_INDO_SOURCES = Object.freeze(['animeku', 'oploverz']);

/** "backend:animeku" / "animeku~slug" → "animeku". */
const siteOfSource = (value) => String(value || '').replace(/^backend:/, '').split('~')[0].toLowerCase();

/** 0 untuk AnimeKu, 1 untuk Oploverz, 2 untuk sumber lain. */
const subIndoRank = (source) => {
    const index = SUB_INDO_SOURCES.indexOf(siteOfSource(source));
    return index === -1 ? SUB_INDO_SOURCES.length : index;
};

/**
 * Server + link download dari backend scraper untuk satu episode.
 * Tanpa backend (dinonaktifkan di config, atau tidak berjalan di origin ini) langsung
 * selesai dengan `disabled: true` — bukan error. Anime / episode yang tidak ada di situs
 * sumber → `error.kind === 'empty'` (bukan gangguan; player memakai server cadangan).
 * @param {import('./normalize.js').Anime} anime
 * @param {number} ep
 * @param {{slug?: string|null, titles?: string[], signal?: AbortSignal}} [opts]
 *   slug   = slug dari URL (item yang berasal dari backend) → tanpa pencarian
 *   titles = semua judul yang diketahui untuk mencari padanan (default: judul & judul alternatif anime)
 * Full-series Kusonime packages intentionally use getKusonimeDownloads() separately (sources.js)
 * from the title-level watch flow; they are not episode downloads and must not be merged here.
 * @returns {Promise<{servers: StreamServer[], downloads: DownloadGroup[], source: string|null, slug?: string|null, matchedTitle?: string, disabled?: boolean, error?: ApiError}>}
 */
export async function getEpisodeExtras(anime, ep, { slug, titles, signal, refresh = false } = {}) {
    // Putaran 16: `refresh` (tombol "cari ulang" Sub Indo) melewati cache episode — kalau tidak,
    // klik bisa memakai hasil lama yang sama dan tombol tetap "tidak terjangkau".
    const getEpisode = (target) => backend.getBackendEpisode(target, ep, { signal, refresh });
    // Prioritas: sumber yang dibuka pengguna. Jika belum menyediakan server Sub Indo,
    // cari sumber lain dengan judul/season yang sama dan gabungkan server yang ditemukan.
    const disabled = { servers: [], downloads: [], source: null, disabled: true };
    const empty = (message, source = null) => ({
        servers: [],
        downloads: [],
        source,
        error: new ApiError(message, { kind: 'empty', source: 'backend' }),
    });
    if (!backend.isBackendEnabled()) return disabled;

    try {
        const own = slug || anime.slug || null;
        let primary = null;
        let primaryError = null;
        let matchedTitle = '';

        if (own) {
            try {
                primary = { ...(await getEpisode(own)), slug: own };
            } catch (error) {
                if (error?.kind === 'abort') throw error;
                primaryError = error;
                // Sumber asal Sub Indo (AnimeKu/Animeloverz) yang gagal sekali dicoba SEKALI lagi —
                // penyebab "episode 1 ada Sub Indo, episode lain cuma Sub Inggris" walau sumbernya sama.
                if (subIndoRank(own) < SUB_INDO_SOURCES.length && !signal?.aborted) {
                    await wait(700, signal);
                    if (!signal?.aborted) {
                        try {
                            primary = { ...(await getEpisode(own)), slug: own };
                            primaryError = null;
                        } catch (retryError) {
                            if (retryError?.kind === 'abort') throw retryError;
                            primaryError = retryError;
                        }
                    }
                }
            }
        }

        // AnimeKu & Oploverz harus SELALU muncul sebagai opsi server (24 Okt 2026). Bila sumber
        // asal sudah punya server Sub Indo, cukup tambahkan dua situs itu; bila belum, pakai
        // semua padanan yang ditemukan.
        const hasIndonesianServer = (item) => (item?.servers || []).some((server) => server?.lang === 'id');
        const needsAllSources = !own || !hasIndonesianServer(primary);
        let targets = [];
        try {
            const matches = await findBackendMatches(anime, { titles, signal });
            const alternatives = matches.filter((match) => match.slug && match.slug !== own);
            const picked = needsAllSources
                ? alternatives
                : alternatives.filter((match) => subIndoRank(match.source) < SUB_INDO_SOURCES.length);
            targets = picked.map((match) => match.slug);
            matchedTitle = picked[0]?.title || alternatives[0]?.title || '';
            if (needsAllSources && !alternatives.length && !primary) {
                return empty('Anime ini belum ditemukan di sumber streaming yang mengizinkan akses otomatis.');
            }
        } catch (error) {
            if (error?.kind === 'abort') throw error;
            // Pencarian padanan gagal: data sumber asal (bila ada) tetap dipakai.
            if (!primary) throw error;
            targets = [];
        }

        const settledTargets = [...new Set(targets)];
        let settled = await Promise.allSettled(
            settledTargets.map((target) => getEpisode(target)),
        );
        // AnimeKu/Oploverz yang gagal sekali (halaman lambat, kuota, 5xx sesaat) dicoba SEKALI lagi:
        // inilah penyebab "episode 1 ada Sub Indo, episode lain cuma Sub Inggris".
        const subIndoFailed = settled
            .map((result, index) => (result.status === 'rejected' ? settledTargets[index] : null))
            .filter((target) => target && subIndoRank(target) < SUB_INDO_SOURCES.length);
        if (subIndoFailed.length) {
            await wait(700, signal);
            if (!signal?.aborted) {
                const retried = await Promise.allSettled(
                    subIndoFailed.map((target) => getEpisode(target)),
                );
                settled = settled.map((result, index) => {
                    const retryIndex = subIndoFailed.indexOf(settledTargets[index]);
                    return result.status === 'rejected' && retryIndex !== -1 ? retried[retryIndex] : result;
                });
            }
        }
        const stillFailedSubIndo = settled
            .map((result, index) => (result.status === 'rejected' ? settledTargets[index] : null))
            .filter((target) => target && subIndoRank(target) < SUB_INDO_SOURCES.length)
            .map((target) => siteOfSource(target));
        const ok = [
            ...(primary ? [primary] : []),
            ...settled.map((result, index) => (
                result.status === 'fulfilled'
                    ? { ...result.value, slug: settledTargets[index] }
                    : null
            )).filter(Boolean),
        ];

        if (!ok.length) {
            const errors = [
                ...(primaryError ? [primaryError] : []),
                ...settled.filter((result) => result.status === 'rejected').map((result) => result.reason),
            ].filter(Boolean);
            if (errors.some((error) => error?.kind === 'abort')) {
                throw errors.find((error) => error?.kind === 'abort');
            }
            if (errors.length && errors.every((error) => error?.kind === 'http' && error.status === 404 && error.payload)) {
                return {
                    ...empty(errors[0].message || `Episode ${ep} belum ada di sumber yang tersedia.`),
                    slug: own || settledTargets[0] || null,
                    matchedTitle,
                };
            }
            if (!errors.length) return empty(`Belum ditemukan server untuk episode ${ep}.`);
            throw errors.find((error) => !(error?.kind === 'http' && error.status === 404)) || errors[0];
        }

        // AnimeKu & Oploverz lebih dulu (permintaan pengguna), lalu Multi Sub, Sub Indo situs lain,
        // dan terakhir Sub Eng.
        const seenUrl = new Set();
        const servers = ok.flatMap((item) => item.servers || [])
            .filter((server) => server.url && !seenUrl.has(server.url) && seenUrl.add(server.url))
            .map((server, index) => ({ server, index }))
            .sort((a, b) => (subIndoRank(a.server.source) - subIndoRank(b.server.source))
                || ((LANG_RANK[a.server.lang] ?? 3) - (LANG_RANK[b.server.lang] ?? 3))
                || (a.index - b.index))
            .map(({ server }) => server);
        const downloads = ok.flatMap((item) => item.downloads || [])
            .map((download, index) => ({ download, index }))
            .sort((a, b) => ((a.download.subtitle === 'Sub Indo' ? 0 : 1) - (b.download.subtitle === 'Sub Indo' ? 0 : 1)) || (a.index - b.index))
            .map(({ download }) => download);
        return {
            servers,
            downloads,
            // Info untuk halaman nonton: sumber Sub Indo mana yang gagal dimuat episode ini.
            failedSubIndo: stillFailedSubIndo,
            source: [...new Set(ok.map((item) => item.source).filter(Boolean))].join(', '),
            sources: [...new Set(ok.map((item) => item.source).filter(Boolean))],
            slug: primary?.slug || ok[0].slug || null,
            matchedTitle,
        };
    } catch (error) {
        if (error?.kind === 'disabled') return disabled;
        throw error;
    }
}
