/**
 * Kazanime — api/kitsu.js
 * Klien Kitsu (JSON:API) + normalisasi ke format Anime.
 *
 * Perbaikan dari file asli & temuan pengecekan langsung (Okt 2026):
 *  - `sort=relevance` TIDAK valid di Kitsu (HTTP 400) → pencarian Kitsu di file
 *    asli selalu gagal. Untuk relevansi, parameter sort dikosongkan.
 *  - File asli mengirim header Content-Type pada GET → memicu preflight CORS, dan
 *    kitsu.app menjawab preflight dengan 403. Sekarang tanpa header kustom
 *    ("simple request"), cukup dengan CORS `Access-Control-Allow-Origin: *`.
 *  - `page[offset]` saat ini diabaikan server (halaman 2 = halaman 1), jadi Kitsu
 *    hanya dipakai untuk halaman pertama (hasNext selalu false).
 *  - Sparse fieldset (fields[anime]) → respons jauh lebih kecil.
 *
 * Perbaikan 22 Okt 2026: negara asal dari kunci judul (en_cn = pinyin → CN) + currentDonghua()
 * untuk section Donghua saat backend & AniList tidak tersedia.
 *
 * Tahap C: detail per id + pencarian satu judul, dengan `include=mappings`
 * → Kitsu memberi id MyAnimeList & AniList (dicek langsung: myanimelist/anime,
 * anilist/anime), sehingga server streaming tetap bisa dipakai untuk anime yang
 * dibuka dari hasil pencarian Kitsu.
 */
import { API_CONFIG, CACHE_TTL, UI } from '../config.js';
import { fetchJSON, hashKey } from './http.js';
import { createAnime, firstAiringAt, toScore10 } from './normalize.js';

const BASE = API_CONFIG.kitsu.url;
const FIELDS = 'canonicalTitle,titles,synopsis,posterImage,coverImage,episodeCount,averageRating,status,subtype,startDate,popularityRank,userCount';
const DETAIL_FIELDS = `${FIELDS},episodeLength,nextRelease,mappings,categories`;
const DETAIL_PARAMS = Object.freeze({
    include: 'mappings,categories',
    'fields[mappings]': 'externalSite,externalId',
    'fields[categories]': 'title',
});
const MAX_LIMIT = 20;

const STATUS = { current: 'ONGOING', finished: 'COMPLETED', upcoming: 'UPCOMING', unreleased: 'UPCOMING', tba: 'UPCOMING' };
const FORMAT = { TV: 'TV', movie: 'MOVIE', OVA: 'OVA', ONA: 'ONA', special: 'SPECIAL', music: 'MUSIC' };
const SUBTYPE_PARAM = { TV: 'TV', MOVIE: 'movie', OVA: 'OVA', ONA: 'ONA' };
const SORT = { score: '-averageRating', popularity: 'popularityRank', newest: '-startDate' };

/* ------------------------------------------------------------------ */
/* Normalisasi                                                         */
/* ------------------------------------------------------------------ */
/**
 * Resource anime Kitsu → Anime.
 * @param {object} item
 * @param {{genres?: string[], ids?: {anilist?:any, mal?:any}, duration?: number, nextAiring?: object|null}} [extra]
 */
/**
 * Negara asal dari kunci judul (Kitsu tidak punya field negara). Penanda andal = judul romanisasi:
 * en_cn (pinyin) / en_kr / en_jp (romaji). zh_cn saja TIDAK cukup (anime Jepang pun punya zh_cn).
 */
export function kitsuCountry(titles = {}) {
    if (titles.en_cn) return 'CN';
    if (titles.en_kr) return 'KR';
    if (titles.en_jp || titles.ja_jp) return 'JP';
    return null;
}

export function fromKitsu(item, extra = {}) {
    const a = item?.attributes;
    if (!a || !item.id) return null;
    const t = a.titles || {};
    const title = t.en || t.en_us || a.canonicalTitle || t.en_jp || t.ja_jp;
    return createAnime({
        title,
        titleAlt: [t.en_jp, a.canonicalTitle, t.ja_jp].find((x) => x && x !== title) || '',
        image: a.posterImage?.large || a.posterImage?.medium || a.posterImage?.original,
        banner: a.coverImage?.large || a.coverImage?.original || null,
        description: a.synopsis,
        episodes: a.episodeCount,
        genres: extra.genres || [],
        score: toScore10(a.averageRating, 100),
        status: STATUS[a.status] || 'UNKNOWN',
        format: FORMAT[a.subtype] || 'TV',
        year: a.startDate ? Number.parseInt(a.startDate.slice(0, 4), 10) : null,
        popularity: a.userCount,
        ids: { ...(extra.ids || {}), kitsu: item.id },
        source: 'kitsu',
        duration: extra.duration,
        nextAiring: extra.nextAiring,
        country: kitsuCountry(t),
        // Kitsu tidak memberi nomor episode terbaru → perkiraan jadwal mingguan dari startDate
        firstAiredAt: firstAiringAt(a.startDate),
    });
}

/** Resource + `included` (mappings & categories) → Anime dengan id MAL/AniList. */
function fromKitsuDetail(item, included = []) {
    if (!item?.attributes) return null;
    const byKey = new Map((included || []).map((x) => [`${x.type}:${x.id}`, x]));
    const related = (name) => (item.relationships?.[name]?.data || [])
        .map((r) => byKey.get(`${r.type}:${r.id}`))
        .filter(Boolean);
    const mappings = related('mappings').map((m) => m.attributes || {});
    const idFor = (site) => mappings.find((m) => m.externalSite === site)?.externalId;
    const next = item.attributes.nextRelease ? Date.parse(item.attributes.nextRelease) : NaN;
    return fromKitsu(item, {
        genres: related('categories').map((c) => c.attributes?.title).filter(Boolean).slice(0, 8),
        ids: { anilist: idFor('anilist/anime'), mal: idFor('myanimelist/anime') },
        duration: item.attributes.episodeLength,
        nextAiring: Number.isFinite(next) ? { episode: null, airingAt: Math.floor(next / 1000) } : null,
    });
}

const toList = (extra) => (json) => ({
    items: (json?.data || []).map((x) => fromKitsu(x, extra)).filter(Boolean),
    hasNext: false, // page[offset] diabaikan server — lihat catatan di atas
    total: json?.meta?.count ?? null,
});

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */
function kitsu(path, params = {}, { ttl = CACHE_TTL.browse, signal, timeout = API_CONFIG.kitsu.timeout, transform = toList(), force = false, fields = FIELDS } = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    });
    if (fields) qs.set('fields[anime]', fields);
    const url = `${BASE}${path}?${qs}`;
    // PENTING: jangan tambahkan header apa pun di sini (lihat catatan preflight di atas).
    return fetchJSON(url, { source: 'kitsu', ttl, cacheKey: `kitsu:${hashKey(url)}`, signal, timeout, force, transform });
}

const subtypeParam = (formats = []) => formats.map((f) => SUBTYPE_PARAM[f]).filter(Boolean).join(',') || undefined;

/** Musim berjalan (winter/spring/summer/fall) untuk "baru rilis". */
function currentSeason(date = new Date()) {
    const m = date.getUTCMonth();
    return { season: ['winter', 'spring', 'summer', 'fall'][Math.floor(m / 3)], year: date.getUTCFullYear() };
}

/* ------------------------------------------------------------------ */
/* Endpoint                                                            */
/* ------------------------------------------------------------------ */
/**
 * Daftar umum: status/kategori/musim + urutan.
 * @param {{status?:'current'|'finished'|'upcoming', category?:string, season?:boolean, sort?:string, formats?:string[], limit?:number, page?:number, genreLabel?:string, signal?:AbortSignal}} [opts]
 */
export function listAnime({ status, category, season = false, sort = 'popularity', formats = [], limit = UI.sectionSize, page = 1, genreLabel, signal } = {}) {
    if (page > 1) return Promise.resolve({ items: [], hasNext: false, total: null });
    const s = season ? currentSeason() : null;
    return kitsu('/anime', {
        'filter[status]': status,
        'filter[categories]': category,
        'filter[season]': s?.season,
        'filter[seasonYear]': s?.year,
        'filter[subtype]': subtypeParam(formats),
        sort: SORT[sort] || SORT.popularity,
        'page[limit]': Math.min(limit, MAX_LIMIT),
    }, { ttl: CACHE_TTL.home, signal, transform: toList(genreLabel ? { genres: [genreLabel] } : undefined) });
}

/** Trending Kitsu (punya coverImage lebar → cocok untuk hero cadangan). */
/**
 * Donghua yang sedang tayang: ONA & TV berstatus current (urut popularitas), disaring yang
 * berjudul pinyin (en_cn). Dipakai section Donghua bila backend & AniList tidak tersedia.
 */
export async function currentDonghua({ limit = UI.sectionSize, signal } = {}) {
    const lists = await Promise.allSettled(['ONA', 'TV'].map((subtype) => kitsu('/anime', {
        'filter[status]': 'current',
        'filter[subtype]': subtype,
        sort: '-userCount',
        'page[limit]': MAX_LIMIT,
    }, { ttl: CACHE_TTL.home, signal })));
    const ok = lists.filter((r) => r.status === 'fulfilled').map((r) => r.value.items);
    if (!ok.length) throw lists[0].reason;
    const seen = new Set();
    const fresh = (key) => Boolean(key) && !seen.has(key) && Boolean(seen.add(key));
    return ok.flat()
        .filter((a) => a.country === 'CN' && fresh(`id:${a.ids.kitsu}`) && fresh(`t:${a.title.toLowerCase().replace(/[^a-z0-9]/g, '')}`))
        .sort((x, y) => (y.popularity || 0) - (x.popularity || 0))
        .slice(0, limit);
}

export function trending({ limit = 10, signal } = {}) {
    return kitsu('/trending/anime', { limit }, { ttl: CACHE_TTL.home, signal, fields: false });
}

/**
 * Pencarian teks. Hanya halaman 1 (lihat catatan offset).
 * @param {{q:string, page?:number, limit?:number, sort?:string, formats?:string[], signal?:AbortSignal, timeout?:number}} opts
 */
export function searchAnime({ q, page = 1, limit = UI.searchPerPage, sort = 'relevance', formats = [], signal, timeout } = {}) {
    if (page > 1 || !q) return Promise.resolve({ items: [], hasNext: false, total: null });
    return kitsu('/anime', {
        'filter[text]': q,
        'filter[subtype]': subtypeParam(formats),
        sort: SORT[sort], // relevance → tanpa sort (sort=relevance membuat Kitsu error 400)
        'page[limit]': Math.min(limit, MAX_LIMIT),
    }, { ttl: CACHE_TTL.search, signal, timeout });
}

/**
 * Detail satu anime (+ id MAL/AniList dari mappings). HTTP 404 = id tidak ada.
 * @returns {Promise<Anime|null>}
 */
export function getAnimeById(id, { signal } = {}) {
    return kitsu(`/anime/${encodeURIComponent(id)}`, DETAIL_PARAMS, {
        ttl: CACHE_TTL.detail,
        signal,
        fields: DETAIL_FIELDS,
        transform: (json) => fromKitsuDetail(json?.data, json?.included),
    });
}

/**
 * Hasil teratas pencarian judul (+ id MAL/AniList dari mappings).
 * @returns {Promise<Anime|null>}
 */
export function findByTitle(q, { signal } = {}) {
    if (!q) return Promise.resolve(null);
    return kitsu('/anime', { 'filter[text]': q, 'page[limit]': 1, ...DETAIL_PARAMS }, {
        ttl: CACHE_TTL.detail,
        signal,
        fields: DETAIL_FIELDS,
        transform: (json) => fromKitsuDetail(json?.data?.[0], json?.included),
    });
}

/** Request ringan untuk widget status API. */
export function ping() {
    return kitsu('/anime', { 'page[limit]': 1, 'fields[anime]': 'slug' }, { ttl: 0, force: true, timeout: 8000, fields: false, transform: (json) => Boolean(json?.data) });
}
