/**
 * Kazanime — api/anilist.js
 * Klien AniList GraphQL + normalisasi ke format Anime.
 *
 * Perbaikan dari file asli:
 *  - BUG: query search memakai variabel `$s`/`$g` tetapi mengirim `{search}`/`{genre}`
 *    → filter tidak pernah terkirim, hasil pencarian & genre selalu "acak populer".
 *    Sekarang nama variabel konsisten dan bertipe benar.
 *  - Isekai adalah TAG di AniList (bukan genre) → pakai tag_in.
 *  - "Baru Rilis" dulu START_DATE_DESC tanpa filter → isinya anime yang BELUM tayang.
 *    Sekarang diambil dari airingSchedules: episode yang benar-benar baru tayang.
 *  - Homepage dulu 4–6 request AniList per kunjungan. Batas AniList saat ini
 *    30 request/menit, jadi semua section homepage diambil dengan SATU query
 *    gabungan (alias). Jika server menolak query gabungan, otomatis pindah ke
 *    query per-section dan keputusan itu diingat 24 jam.
 *  - isAdult:false di semua daftar.
 *
 * Tahap C: detail anime + jumlah episode tayang + jadwal episode berikutnya +
 * rekomendasi diambil dalam SATU query (getMediaDetail) — halaman nonton cukup
 * 1 request AniList. File asli: search + getAnimeById terpisah, dan rekomendasi tidak ada.
 */
import { API_CONFIG, CACHE_TTL, UI, STORAGE_KEYS } from '../config.js';
import { fetchJSON, ApiError, hashKey } from './http.js';
import { createAnime, toScore10 } from './normalize.js';

const ENDPOINT = API_CONFIG.anilist.url;

/** Field yang dipakai kartu/hero. Dipusatkan di satu fragment. */
const MEDIA_FIELDS = 'id idMal title{romaji english native} coverImage{extraLarge large color} bannerImage episodes nextAiringEpisode{episode} genres averageScore meanScore popularity status format seasonYear startDate{year} countryOfOrigin';
const FRAGMENT = `fragment F on Media{${MEDIA_FIELDS}}`;
/** Field ringan untuk jadwal (banyak entri). */
const SCHEDULE_MEDIA = 'id idMal title{romaji english native} coverImage{large color} episodes popularity isAdult status format countryOfOrigin';

const STATUS = { RELEASING: 'ONGOING', HIATUS: 'ONGOING', FINISHED: 'COMPLETED', CANCELLED: 'COMPLETED', NOT_YET_RELEASED: 'UPCOMING' };
const FORMAT = { TV: 'TV', TV_SHORT: 'TV', MOVIE: 'MOVIE', SPECIAL: 'SPECIAL', OVA: 'OVA', ONA: 'ONA', MUSIC: 'MUSIC' };
const SORT = {
    relevance: 'SEARCH_MATCH',
    score: 'SCORE_DESC',
    popularity: 'POPULARITY_DESC',
    newest: 'START_DATE_DESC',
    trending: 'TRENDING_DESC',
};
const FORMAT_IN = { TV: ['TV', 'TV_SHORT'], MOVIE: ['MOVIE'], OVA: ['OVA'], ONA: ['ONA'] };

/* ------------------------------------------------------------------ */
/* Normalisasi                                                         */
/* ------------------------------------------------------------------ */
/**
 * Media AniList → Anime.
 * @param {object} m
 * @param {{latestEpisode?: number|null}} [extra]
 */
export function fromAniList(m, extra = {}) {
    if (!m || !m.id) return null;
    const t = m.title || {};
    const title = t.english || t.romaji || t.native;
    const titleAlt = [t.romaji, t.native].find((x) => x && x !== title) || '';
    const status = STATUS[m.status] || 'UNKNOWN';
    const next = m.nextAiringEpisode?.episode;
    const latestEpisode = extra.latestEpisode !== undefined
        ? extra.latestEpisode
        : (status === 'ONGOING' && next > 1 ? next - 1 : null);
    return createAnime({
        title,
        titleAlt,
        image: m.coverImage?.extraLarge || m.coverImage?.large,
        banner: m.bannerImage,
        description: m.description,
        episodes: m.episodes,
        latestEpisode,
        genres: m.genres,
        score: toScore10(m.averageScore || m.meanScore, 100),
        status,
        format: FORMAT[m.format] || m.format || 'TV',
        year: m.seasonYear || m.startDate?.year,
        popularity: m.popularity,
        country: m.countryOfOrigin,
        ids: { anilist: m.id, mal: m.idMal },
        source: 'anilist',
        color: m.coverImage?.color,
        // field detail (hanya ada di query detail; di query daftar otomatis kosong)
        studios: m.studios?.nodes?.map((n) => n?.name),
        duration: m.duration,
        season: m.season,
        nextAiring: m.nextAiringEpisode?.airingAt
            ? { episode: m.nextAiringEpisode.episode, airingAt: m.nextAiringEpisode.airingAt }
            : null,
    });
}

const mapMedia = (list) => (list || []).map((m) => fromAniList(m)).filter(Boolean);

/**
 * Jadwal tayang (urut TIME_DESC) → daftar "baru rilis".
 * Satu entri per anime (episode terbaru), utamakan anime yang cukup populer
 * supaya daftar tidak dipenuhi judul yang sangat tidak dikenal.
 */
function recentFromSchedules(list, minPopularity = API_CONFIG.recentMinPopularity) {
    const seen = new Set();
    const popular = [];
    const rest = [];
    for (const s of list || []) {
        const m = s?.media;
        if (!m || m.isAdult || seen.has(m.id)) continue;
        seen.add(m.id);
        const anime = fromAniList(m, { latestEpisode: s.episode || null });
        if (!anime) continue;
        ((m.popularity || 0) >= minPopularity ? popular : rest).push(anime);
    }
    rest.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    return [...popular, ...rest];
}

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */
/** Hapus variabel kosong: argumen yang tidak dikirim = tanpa filter. */
function cleanVars(vars) {
    return Object.fromEntries(Object.entries(vars || {}).filter(([, v]) => (
        v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)
    )));
}

function checkGraphQL(json) {
    if (!json || typeof json !== 'object') {
        throw new ApiError('Respons AniList kosong.', { kind: 'parse', source: 'anilist' });
    }
    if (Array.isArray(json.errors) && json.errors.length) {
        if (!json.data) {
            const e = json.errors[0] || {};
            throw new ApiError(e.message || 'Query AniList ditolak.', { kind: 'graphql', status: e.status || 400, source: 'anilist' });
        }
        console.warn('[AniList] sebagian query gagal:', json.errors.map((e) => e.message).join(' | '));
    }
    return json;
}

/**
 * Kirim query GraphQL.
 * @returns {Promise<any>} hasil transform(data)
 */
function gql(query, variables, { cacheKey, ttl = 0, signal, timeout = API_CONFIG.anilist.timeout, force = false, transform } = {}) {
    return fetchJSON(ENDPOINT, {
        source: 'anilist',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: { query, variables: cleanVars(variables) },
        timeout,
        ttl,
        cacheKey,
        signal,
        force,
        validate: checkGraphQL,
        transform: (json) => (transform ? transform(json.data) : json.data),
    });
}

/** Query DITOLAK (bukan masalah jaringan) → aman dicoba ulang dalam bentuk lain. */
function isQueryRejected(err) {
    return err instanceof ApiError
        && (err.kind === 'graphql' || (err.kind === 'http' && (err.status === 400 || err.status === 413 || err.status === 422)));
}

const BATCH_OFF_MS = 24 * 60 * 60 * 1000;
function batchDisabled() {
    try {
        const at = Number(window.localStorage.getItem(STORAGE_KEYS.anilistNoBatch) || 0);
        return Date.now() - at < BATCH_OFF_MS;
    } catch {
        return false;
    }
}
function disableBatch(err) {
    console.warn('[AniList] query gabungan ditolak, pindah ke query per-section:', err.message);
    try { window.localStorage.setItem(STORAGE_KEYS.anilistNoBatch, String(Date.now())); } catch { /* abaikan */ }
}

/**
 * Jalankan beberapa blok (alias) dalam SATU request. Jika server menolak
 * (mis. batas kompleksitas), jalankan per-alias secara berurutan.
 * @param {{key:string, names:string[], build:(names:string[])=>string, variables:object, ttl:number, map:(name:string, block:any)=>any}} spec
 * @returns {Promise<Record<string, any>>}
 */
async function runAliases({ key, names, build, variables, ttl, map }) {
    const pick = (data, list) => Object.fromEntries(list.map((n) => [n, data?.[n] ? map(n, data[n]) : null]));
    if (!batchDisabled()) {
        try {
            return await gql(build(names), variables, { cacheKey: key, ttl, transform: (data) => pick(data, names) });
        } catch (err) {
            if (!isQueryRejected(err)) throw err; // jaringan/403/429 → biar facade fallback ke Kitsu
            disableBatch(err);
        }
    }
    const out = {};
    for (const n of names) {
        try {
            out[n] = await gql(build([n]), variables, {
                cacheKey: `${key}:${n}`,
                ttl,
                transform: (data) => (data?.[n] ? map(n, data[n]) : null),
            });
        } catch (err) {
            if (!isQueryRejected(err)) throw err;
            console.warn(`[AniList] blok "${n}" ditolak:`, err.message);
            out[n] = null;
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Homepage                                                            */
/* ------------------------------------------------------------------ */
const HOME_BLOCKS = {
    ongoing: `Page(page:1,perPage:${UI.sectionSize}){media(type:ANIME,status:RELEASING,sort:[TRENDING_DESC,POPULARITY_DESC],isAdult:false){...F description(asHtml:false)}}`,
    popular: `Page(page:1,perPage:${UI.sectionSize}){media(type:ANIME,sort:[POPULARITY_DESC],isAdult:false){...F}}`,
    donghua: `Page(page:1,perPage:${UI.sectionSize}){media(type:ANIME,countryOfOrigin:$cn,sort:[TRENDING_DESC,POPULARITY_DESC],isAdult:false){...F}}`,
    recent: 'Page(page:1,perPage:50){airingSchedules(airingAt_greater:$since,airingAt_lesser:$now,sort:[TIME_DESC]){episode airingAt media{...F isAdult}}}',
};
const HOME_VARS = { donghua: ['$cn:CountryCode'], recent: ['$now:Int', '$since:Int'] };

function buildHomeQuery(names) {
    const decl = names.flatMap((n) => HOME_VARS[n] || []);
    const head = decl.length ? `query(${decl.join(',')})` : 'query';
    return `${head}{${names.map((n) => `${n}:${HOME_BLOCKS[n]}`).join(' ')}}${FRAGMENT}`;
}

/**
 * Semua daftar homepage dalam satu request (di-cache 15 menit).
 * Dipanggil bersamaan oleh beberapa section → request otomatis dipakai bersama.
 * @returns {Promise<{ongoing:Anime[]|null, popular:Anime[]|null, donghua:Anime[]|null, recent:Anime[]|null}>}
 */
export function getHomeLists() {
    const now = Math.floor(Date.now() / 1000);
    return runAliases({
        key: 'anilist:home:v1',
        names: ['ongoing', 'popular', 'donghua', 'recent'],
        build: buildHomeQuery,
        variables: { cn: 'CN', now, since: now - 3 * 86400 },
        ttl: CACHE_TTL.home,
        map: (name, block) => (name === 'recent' ? recentFromSchedules(block.airingSchedules) : mapMedia(block.media)),
    });
}

/* ------------------------------------------------------------------ */
/* Pencarian & daftar berhalaman                                       */
/* ------------------------------------------------------------------ */
const PAGE_QUERY = `query($page:Int,$perPage:Int,$search:String,$sort:[MediaSort],$formats:[MediaFormat],$genres:[String],$tags:[String],$status:MediaStatus,$country:CountryCode,$season:MediaSeason,$seasonYear:Int){Page(page:$page,perPage:$perPage){pageInfo{hasNextPage total}media(type:ANIME,isAdult:false,search:$search,sort:$sort,format_in:$formats,genre_in:$genres,tag_in:$tags,status:$status,countryOfOrigin:$country,season:$season,seasonYear:$seasonYear){...F}}}${FRAGMENT}`;

/**
 * Cari / jelajahi anime (satu fungsi untuk search, genre, ongoing, donghua, dst).
 * @param {{
 *   q?: string, page?: number, perPage?: number,
 *   sort?: 'relevance'|'score'|'popularity'|'newest'|'trending',
 *   formats?: string[], genre?: string, tag?: string,
 *   status?: 'RELEASING'|'FINISHED'|'NOT_YET_RELEASED', country?: string,
 *   season?: 'WINTER'|'SPRING'|'SUMMER'|'FALL', seasonYear?: number,
 *   signal?: AbortSignal, timeout?: number,
 * }} [opts]
 * @returns {Promise<{items: Anime[], hasNext: boolean, total: number|null}>}
 */
export function searchMedia({ q = '', page = 1, perPage = UI.searchPerPage, sort = 'relevance', formats = [], genre, tag, status, country, season, seasonYear, signal, timeout } = {}) {
    let primary = SORT[sort] || SORT.popularity;
    if (primary === 'SEARCH_MATCH' && !q) primary = SORT.popularity;
    const sortList = primary === 'SEARCH_MATCH' ? ['SEARCH_MATCH', 'POPULARITY_DESC'] : [primary];
    const variables = {
        page,
        perPage,
        search: q || undefined,
        sort: sortList,
        formats: formats.flatMap((f) => FORMAT_IN[f] || []),
        genres: genre ? [genre] : undefined,
        tags: tag ? [tag] : undefined,
        status,
        country,
        season,
        seasonYear,
    };
    const clean = cleanVars(variables);
    return gql(PAGE_QUERY, clean, {
        cacheKey: `anilist:page:${hashKey(JSON.stringify(clean))}`,
        ttl: q ? CACHE_TTL.search : CACHE_TTL.browse,
        signal,
        timeout,
        transform: (data) => ({
            items: mapMedia(data?.Page?.media),
            hasNext: Boolean(data?.Page?.pageInfo?.hasNextPage),
            total: data?.Page?.pageInfo?.total ?? null,
        }),
    });
}

const RECENT_QUERY = `query($page:Int,$perPage:Int,$now:Int,$since:Int){Page(page:$page,perPage:$perPage){pageInfo{hasNextPage}airingSchedules(airingAt_greater:$since,airingAt_lesser:$now,sort:[TIME_DESC]){episode airingAt media{...F isAdult}}}}${FRAGMENT}`;

/**
 * Episode yang baru tayang (7 hari terakhir), berhalaman — untuk search.html?browse=new.
 * Waktu dibulatkan per 10 menit agar kunci cache stabil antar-halaman.
 */
export function recentEpisodes({ page = 1, perPage = 50, days = 7, signal } = {}) {
    const now = Math.floor(Date.now() / 1000 / 600) * 600;
    return gql(RECENT_QUERY, { page, perPage, now, since: now - days * 86400 }, {
        cacheKey: `anilist:recent:${now}:${page}`,
        ttl: CACHE_TTL.browse,
        signal,
        transform: (data) => ({
            // Di halaman jelajah urutan kronologis dipertahankan; ambang popularitas rendah
            items: recentFromSchedules(data?.Page?.airingSchedules, 0),
            hasNext: Boolean(data?.Page?.pageInfo?.hasNextPage),
            total: null,
        }),
    });
}

/* ------------------------------------------------------------------ */
/* Detail (halaman nonton)                                             */
/* ------------------------------------------------------------------ */
/*
 * Satu query: info lengkap + episode berikutnya (jumlah episode tayang) + rekomendasi.
 * Variabel yang tidak dikirim = argumen tidak dipakai, jadi query yang sama melayani
 * pencarian lewat id AniList, id MAL (idMal), atau judul (search + SEARCH_MATCH).
 * `nextAiringEpisode{episode airingAt}` digabung dengan field yang sama di fragment F.
 */
const DETAIL_QUERY = `query($id:Int,$idMal:Int,$search:String,$sort:[MediaSort],$adult:Boolean,$recs:Int){Media(id:$id,idMal:$idMal,search:$search,sort:$sort,isAdult:$adult,type:ANIME){...F isAdult description(asHtml:false) duration season studios(isMain:true){nodes{name}} nextAiringEpisode{episode airingAt} recommendations(sort:[RATING_DESC],page:1,perPage:$recs){nodes{mediaRecommendation{...F isAdult}}}}}${FRAGMENT}`;

/**
 * Detail satu anime + rekomendasinya.
 * Prioritas kunci: id → idMal → search (judul). HTTP 404 = tidak ditemukan.
 * @param {{id?:number|null, idMal?:number|null, search?:string, recs?:number, signal?:AbortSignal}} opts
 * @returns {Promise<{anime: Anime, recommendations: Anime[]}|null>}
 */
export function getMediaDetail({ id, idMal, search, recs = 12, signal } = {}) {
    const byTitle = !id && !idMal && Boolean(search);
    const variables = cleanVars({
        id: id || undefined,
        idMal: id ? undefined : idMal || undefined,
        search: byTitle ? search : undefined,
        sort: byTitle ? ['SEARCH_MATCH', 'POPULARITY_DESC'] : undefined,
        adult: byTitle ? false : undefined, // pencarian judul: jangan pernah mendarat di judul dewasa
        recs,
    });
    if (!variables.id && !variables.idMal && !variables.search) return Promise.resolve(null);
    return gql(DETAIL_QUERY, variables, {
        cacheKey: `anilist:detail:${hashKey(JSON.stringify(variables))}`,
        ttl: CACHE_TTL.detail,
        signal,
        transform: (data) => {
            const m = data?.Media;
            const anime = fromAniList(m);
            if (!anime) return null;
            const recommendations = (m.recommendations?.nodes || [])
                .map((n) => n?.mediaRecommendation)
                .filter((r) => r && !r.isAdult)
                .map((r) => fromAniList(r))
                .filter(Boolean);
            return { anime, recommendations };
        },
    });
}

/* ------------------------------------------------------------------ */
/* Jadwal tayang                                                       */
/* ------------------------------------------------------------------ */
/**
 * Jadwal untuk beberapa rentang waktu sekaligus (satu alias per hari).
 * @param {{key:string, start:number, end:number}[]} windows  detik UNIX
 * @returns {Promise<Record<string, {airingAt:number, episode:number|null, anime:Anime}[]|null>>}
 */
export function airingWindows(windows) {
    const names = windows.map((w) => w.key);
    const variables = {};
    windows.forEach((w) => {
        variables[`${w.key}s`] = w.start - 1; // airingAt_greater bersifat eksklusif
        variables[`${w.key}e`] = w.end;
    });
    const build = (list) => `query(${list.map((n) => `$${n}s:Int,$${n}e:Int`).join(',')}){${list
        .map((n) => `${n}:Page(page:1,perPage:50){airingSchedules(airingAt_greater:$${n}s,airingAt_lesser:$${n}e,sort:[TIME]){airingAt episode media{${SCHEDULE_MEDIA}}}}`)
        .join(' ')}}`;
    return runAliases({
        key: `anilist:schedule:${windows[0]?.start || 0}`,
        names,
        build,
        variables,
        ttl: CACHE_TTL.schedule,
        map: (_name, block) => (block.airingSchedules || [])
            .filter((s) => s?.media && !s.media.isAdult)
            .map((s) => ({ airingAt: s.airingAt, episode: s.episode || null, anime: fromAniList(s.media, { latestEpisode: null }) }))
            .filter((s) => s.anime),
    });
}

/* ------------------------------------------------------------------ */
/* Cek status                                                          */
/* ------------------------------------------------------------------ */
/** Request super ringan untuk widget status API (melewati circuit breaker). */
export function ping() {
    return gql('query{Page(page:1,perPage:1){media(type:ANIME){id}}}', {}, { force: true, timeout: 8000 });
}
