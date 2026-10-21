/**
 * Kazanime — api/jikan.js
 * Klien Jikan v4 (data MyAnimeList) + normalisasi ke format Anime.
 *
 * Perbaikan dari file asli:
 *  - Urutan "Relevansi" dulu dikirim sebagai order_by=mal_id desc → yang muncul
 *    justru anime dengan ID terbaru, bukan yang paling cocok. Sekarang tanpa order_by.
 *  - Pemetaan sort: 'popularity' → members desc (order_by=popularity di Jikan adalah
 *    peringkat, makin kecil makin populer), 'newest' → start_date desc.
 *  - Jeda minimal antar-request (Jikan: ±3/detik, 60/menit) → tidak kena 429 saat
 *    beberapa section fallback bersamaan.
 *  - Jikan kadang mengembalikan entri ganda di daftar top → di-dedupe.
 *
 * Tahap C (cadangan halaman nonton bila AniList gagal): detail per id MAL,
 * jumlah episode yang sudah tayang (/episodes), dan rekomendasi.
 * Perbaikan pasca-D: `firstAiredAt` (aired.from + broadcast) untuk perkiraan episode tayang.
 */
import { API_CONFIG, CACHE_TTL, UI } from '../config.js';
import { fetchJSON, hashKey } from './http.js';
import { createAnime, firstAiringAt, toScore10 } from './normalize.js';

const BASE = API_CONFIG.jikan.url;
const THROTTLE = { key: 'jikan', interval: API_CONFIG.jikan.minInterval };

const FORMAT = { TV: 'TV', Movie: 'MOVIE', OVA: 'OVA', ONA: 'ONA', Special: 'SPECIAL', 'TV Special': 'SPECIAL', Music: 'MUSIC', CM: 'SPECIAL', PV: 'SPECIAL' };
const TYPE_PARAM = { TV: 'tv', MOVIE: 'movie', OVA: 'ova', ONA: 'ona' };
const ORDER = { score: ['score', 'desc'], popularity: ['members', 'desc'], newest: ['start_date', 'desc'] };
const SEASON = { winter: 'WINTER', spring: 'SPRING', summer: 'SUMMER', fall: 'FALL' };
/** /anime/{id}/episodes berisi 100 episode per halaman. */
const EPISODES_PER_PAGE = 100;

/** "24 min per ep" → 24 · "1 hr 52 min" → 112 · "Unknown" → null */
function parseDuration(text) {
    const s = String(text || '');
    const h = /(\d+)\s*hr/.exec(s);
    const m = /(\d+)\s*min/.exec(s);
    const total = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
    return total || null;
}

/* ------------------------------------------------------------------ */
/* Normalisasi                                                         */
/* ------------------------------------------------------------------ */
/** Objek anime Jikan → Anime. */
export function fromJikan(a) {
    if (!a || !a.mal_id) return null;
    const status = a.airing ? 'ONGOING'
        : a.status === 'Finished Airing' ? 'COMPLETED'
            : a.status === 'Not yet aired' ? 'UPCOMING' : 'UNKNOWN';
    const genres = [...(a.genres || []), ...(a.themes || [])].map((g) => g?.name).filter(Boolean);
    return createAnime({
        title: a.title_english || a.title,
        titleAlt: a.title_english ? a.title : (a.title_japanese || ''),
        image: a.images?.webp?.large_image_url || a.images?.jpg?.large_image_url || a.images?.jpg?.image_url,
        // Thumbnail trailer YouTube (16:9) cocok untuk hero saat AniList tidak tersedia
        banner: a.trailer?.images?.maximum_image_url || a.trailer?.images?.large_image_url || null,
        description: a.synopsis,
        episodes: a.episodes,
        genres: [...new Set(genres)],
        score: toScore10(a.score, 10),
        status,
        format: FORMAT[a.type] || a.type || 'TV',
        year: a.year || a.aired?.prop?.from?.year,
        popularity: a.members,
        ids: { mal: a.mal_id },
        source: 'mal',
        studios: (a.studios || []).map((x) => x?.name),
        duration: parseDuration(a.duration),
        season: SEASON[a.season] || null,
        // Tanggal mulai + jam siaran (JST) → perkiraan jumlah episode tayang bila daftar episode MAL masih kosong
        firstAiredAt: firstAiringAt(a.aired?.from, a.broadcast),
    });
}

/** Entri ringkas (rekomendasi: hanya id, judul, gambar) → Anime. */
function fromJikanEntry(e) {
    if (!e?.mal_id || !e.title) return null;
    return createAnime({
        title: e.title,
        image: e.images?.webp?.large_image_url || e.images?.jpg?.large_image_url || e.images?.jpg?.image_url,
        ids: { mal: e.mal_id },
        source: 'mal',
    });
}

function toList(json) {
    const seen = new Set();
    const items = [];
    for (const raw of json?.data || []) {
        const anime = fromJikan(raw);
        if (anime && !seen.has(anime.id)) {
            seen.add(anime.id);
            items.push(anime);
        }
    }
    return {
        items,
        hasNext: Boolean(json?.pagination?.has_next_page),
        total: json?.pagination?.items?.total ?? null,
    };
}

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */
function jikan(path, params = {}, { ttl = CACHE_TTL.browse, signal, timeout = API_CONFIG.jikan.timeout, transform = toList, force = false } = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    });
    const url = `${BASE}${path}${qs.toString() ? `?${qs}` : ''}`;
    return fetchJSON(url, {
        source: 'jikan',
        ttl,
        cacheKey: `jikan:${hashKey(url)}`,
        signal,
        timeout,
        force,
        throttle: THROTTLE,
        transform,
    });
}

/** Parameter tipe hanya bisa satu nilai di Jikan; jika >1 format, disaring di facade. */
const typeParam = (formats = []) => (formats.length === 1 ? TYPE_PARAM[formats[0]] : undefined);

/* ------------------------------------------------------------------ */
/* Endpoint                                                            */
/* ------------------------------------------------------------------ */
/** Anime tayang dengan peringkat tertinggi (pengganti "ongoing"). */
export function topAiring({ limit = UI.sectionSize, page = 1, signal } = {}) {
    return jikan('/top/anime', { filter: 'airing', sfw: true, limit, page }, { ttl: CACHE_TTL.home, signal });
}

/** Anime paling populer sepanjang masa. */
export function mostPopular({ limit = UI.sectionSize, page = 1, signal } = {}) {
    return jikan('/top/anime', { filter: 'bypopularity', sfw: true, limit, page }, { ttl: CACHE_TTL.home, signal });
}

/** Anime musim ini (pengganti "baru rilis"). */
export function seasonNow({ limit = UI.sectionSize, page = 1, formats = [], signal } = {}) {
    return jikan('/seasons/now', { sfw: true, limit, page, filter: typeParam(formats) }, { ttl: CACHE_TTL.home, signal });
}

/**
 * Pencarian / penjelajahan umum lewat /anime.
 * @param {{q?:string, page?:number, limit?:number, sort?:string, formats?:string[], genreId?:number, status?:'airing'|'complete'|'upcoming', signal?:AbortSignal, timeout?:number}} [opts]
 */
export function searchAnime({ q = '', page = 1, limit = UI.searchPerPage, sort = 'relevance', formats = [], genreId, status, signal, timeout } = {}) {
    let order = ORDER[sort];
    if (!order && !q) order = ORDER.popularity; // tanpa kata kunci, "relevansi" = populer
    return jikan('/anime', {
        q: q || undefined,
        page,
        limit,
        sfw: true,
        type: typeParam(formats),
        genres: genreId || undefined,
        status,
        order_by: order?.[0],
        sort: order?.[1],
    }, { ttl: q ? CACHE_TTL.search : CACHE_TTL.browse, signal, timeout });
}

/**
 * Jadwal mingguan MAL (cadangan jika AniList gagal). Mengambil beberapa halaman
 * berurutan (dibatasi throttle). Jam siaran MAL dalam JST.
 * @returns {Promise<{anime: Anime, day: string|null, time: string|null, timezone: string|null}[]>}
 */
export async function weeklySchedule({ maxPages = 4, signal } = {}) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
        // eslint-disable-next-line no-await-in-loop
        const res = await jikan('/schedules', { sfw: true, kids: false, limit: 25, page }, {
            ttl: CACHE_TTL.schedule,
            signal,
            transform: (json) => ({
                items: (json?.data || []).map((a) => ({
                    anime: fromJikan(a),
                    day: a.broadcast?.day || null,
                    time: a.broadcast?.time || null,
                    timezone: a.broadcast?.timezone || null,
                })).filter((x) => x.anime),
                hasNext: Boolean(json?.pagination?.has_next_page),
            }),
        });
        all.push(...res.items);
        if (!res.hasNext) break;
    }
    return all;
}

/* ------------------------------------------------------------------ */
/* Detail (halaman nonton, cadangan AniList)                           */
/* ------------------------------------------------------------------ */
/**
 * Detail satu anime. HTTP 404 = id tidak ada di MAL.
 * @returns {Promise<Anime|null>}
 */
export function getAnimeById(id, { signal } = {}) {
    return jikan(`/anime/${encodeURIComponent(id)}`, {}, {
        ttl: CACHE_TTL.detail,
        signal,
        transform: (json) => fromJikan(json?.data),
    });
}

/**
 * Jumlah episode yang SUDAH tayang (untuk anime ongoing yang total episodenya null).
 * Maks 2 request: halaman 1 → tahu jumlah halaman → halaman terakhir.
 * Episode bertanggal tayang di masa depan tidak dihitung.
 * @returns {Promise<number|null>}
 */
export async function airedEpisodeCount(id, { signal } = {}) {
    const read = (json) => ({
        aired: (json?.data || []).filter((e) => !e?.aired || Date.parse(e.aired) <= Date.now()).length,
        lastPage: Number(json?.pagination?.last_visible_page) || 1,
    });
    const path = `/anime/${encodeURIComponent(id)}/episodes`;
    const first = await jikan(path, {}, { ttl: CACHE_TTL.detail, signal, transform: read });
    if (first.lastPage <= 1) return first.aired || null;
    const last = await jikan(path, { page: first.lastPage }, { ttl: CACHE_TTL.detail, signal, transform: read });
    return (first.lastPage - 1) * EPISODES_PER_PAGE + last.aired || null;
}

/**
 * Rekomendasi pengguna MAL (hanya judul + gambar; tanpa skor/episode).
 * @returns {Promise<{items: Anime[], hasNext: false}>}
 */
export function recommendations(id, { limit = 12, signal } = {}) {
    return jikan(`/anime/${encodeURIComponent(id)}/recommendations`, {}, {
        ttl: CACHE_TTL.detail,
        signal,
        transform: (json) => ({
            items: (json?.data || []).map((r) => fromJikanEntry(r?.entry)).filter(Boolean).slice(0, limit),
            hasNext: false,
        }),
    });
}

/** Request ringan untuk widget status API. */
export function ping() {
    return jikan('/top/anime', { limit: 1 }, { ttl: 0, force: true, timeout: 8000, transform: (json) => Boolean(json?.data) });
}
