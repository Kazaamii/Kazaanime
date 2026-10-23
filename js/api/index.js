/**
 * Kazanime — api/index.js (FACADE)
 * Satu-satunya pintu data untuk halaman & komponen UI.
 * UI mengimpor fungsi dari sini dan hanya menerima objek Anime yang sudah
 * dinormalisasi — tidak pernah respons mentah, tidak pernah memanggil fetch.
 *
 * Rantai fallback metadata:  AniList → Kitsu → data statis
 *   (Jikan/MyAnimeList dihapus 22 Okt 2026 atas permintaan pemilik proyek; id MAL dari AniList/Kitsu
 *    tetap disimpan di anime.ids.mal untuk tautan lama.)
 * Section Donghua (Tahap D):  backend scraper (rilis terbaru AnimeXin + Anichin) → AniList CN → Kitsu (judul pinyin) → data statis
 * Section Anime Sub Indo: backend latest per-situs (Samehadaku/Sakunime/Otakudesu/Kuramanime), lalu cek episode terbaru untuk metadata subtitle Indonesia; panel dan judul lintas sumber tetap terpisah, tanpa fallback metadata.
 * Jadwal rilis (22 Okt 2026): backend (Samehadaku jam rilis Sub Indo + AnimeXin + Anichin) → AniList → data statis
 *  - Sumber yang baru gagal "diistirahatkan" sementara (circuit breaker di
 *    http.js), jadi kunjungan berikutnya langsung ke sumber yang hidup.
 *  - Hasil memberi tahu sumber yang dipakai (`source`) dan apakah data cadangan
 *    statis yang tampil (`fallback`), supaya UI bisa memberi keterangan jujur.
 *
 * Tahap C (watch.html): getWatchData() (detail + jumlah episode + rekomendasi
 * AniList dalam 1 request), getRecommendations(), server streaming per episode
 * (streams.js) dan link download dari backend scraper (Tahap D).
 */
import { API_CONFIG, GENRES, PLAYER, SCHEDULE, UI } from '../config.js';
import * as anilist from './anilist.js';
import * as kitsu from './kitsu.js';
import * as backend from './sources.js';
import { ApiError, API_SOURCES, friendlyError, getAllHealth, getHealth, onHealthChange, pendingRequests, resetCircuits } from './http.js';
import { createAnime, titleKey, withIds } from './normalize.js';
import {
    FALLBACK_HERO, FALLBACK_ONGOING, FALLBACK_POPULAR, FALLBACK_NEW, FALLBACK_DONGHUA, FALLBACK_SCHEDULE,
} from '../data/fallback.js';
import { loadSubIndoSources } from './subindo.js';

export { ApiError, friendlyError, getAllHealth, getHealth, onHealthChange, pendingRequests };
export { listStreamServers, getEpisodeExtras, withProviderServers, SUB_INDO_SOURCES } from './streams.js';
export { getStreamServers, getAiSubtitlePart, getKusonimeDownloads, getEpisodeSubtitles } from './sources.js';
/** Dipakai tombol "Coba lagi": izinkan semua sumber dicoba lagi sekarang juga. */
export const retrySourcesNow = resetCircuits;
export const isBackendEnabled = backend.isBackendEnabled;

/**
 * @typedef {import('./normalize.js').Anime} Anime
 * @typedef {{items: Anime[], hasNext: boolean, nextPage: number, source: string|null, fallback: boolean, error?: ApiError}} ListResult
 */

/* ------------------------------------------------------------------ */
/* Helper rantai fallback                                              */
/* ------------------------------------------------------------------ */
/**
 * Jalankan langkah berurutan; kembalikan hasil pertama yang berisi data.
 * @param {{source:string, run:() => Promise<any>}[]} steps
 */
async function firstAvailable(steps) {
    const errors = [];
    for (const { source, run } of steps) {
        try {
            const res = await run();
            const out = Array.isArray(res) ? { items: res, hasNext: false } : (res || { items: [] });
            // items kosong + hasNext (mis. halaman yang tersaring habis) tetap dianggap jawaban sah
            if (out.items?.length || out.hasNext) return { ...out, source, errors };
            errors.push(new ApiError('Hasil kosong.', { kind: 'empty', source }));
        } catch (err) {
            if (err?.kind === 'abort') throw err;
            errors.push(err instanceof ApiError ? err : new ApiError(err?.message || 'Gagal', { kind: 'parse', source, cause: err }));
        }
    }
    return { items: [], hasNext: false, source: null, errors };
}

/** Error paling informatif untuk ditampilkan (error nyata > circuit > kosong). */
function pickError(errors = []) {
    return errors.find((e) => e.kind !== 'empty' && e.kind !== 'circuit')
        || errors.find((e) => e.kind === 'circuit')
        || errors[0]
        || new ApiError('Tidak ada data.', { kind: 'empty' });
}

/** Saring format di sisi klien (untuk sumber yang tidak mendukung multi-format). */
function filterFormats(items, formats = []) {
    if (!formats.length) return items;
    const wanted = new Set(formats);
    return items.filter((a) => wanted.has(a.format));
}

/** Batasi langkah ke satu sumber (agar "Muat Lebih Banyak" tetap dari sumber yang sama). */
const onlySource = (steps, source) => (source ? steps.filter((s) => s.source === source) : steps);

/** @returns {ListResult} */
function finishList(res, { page = 1, fallbackItems = [] } = {}) {
    if (res.items.length || res.hasNext) {
        return { items: res.items, hasNext: Boolean(res.hasNext), nextPage: res.nextPage || page + 1, source: res.source, fallback: false };
    }
    if (page === 1 && fallbackItems.length) {
        return { items: fallbackItems, hasNext: false, nextPage: 2, source: 'fallback', fallback: true, error: pickError(res.errors) };
    }
    return { items: [], hasNext: false, nextPage: page + 1, source: res.source, fallback: false, error: pickError(res.errors) };
}

/* ------------------------------------------------------------------ */
/* Homepage                                                            */
/* ------------------------------------------------------------------ */
const HOME_FALLBACK = { ongoing: FALLBACK_ONGOING, popular: FALLBACK_POPULAR, recent: FALLBACK_NEW, donghua: FALLBACK_DONGHUA };

/**
 * Donghua terbaru dari backend scraper. Hanya data ASLI situs sumber (bukan fallback metadata)
 * dan hanya yang negara asalnya Tiongkok — kalau tidak ada, langkah berikutnya yang dipakai.
 * @returns {Promise<Anime[]>}
 */
async function backendDonghua({ signal } = {}) {
    if (!backend.isBackendEnabled()) return [];
    try {
        const res = await backend.getLatest({ signal });
        return res.fallback ? [] : res.items.filter((a) => a.country === 'CN');
    } catch (err) {
        // Backend tidak berjalan di origin ini (hosting statis) → bukan error yang perlu ditampilkan;
        // langkah berikutnya (AniList) yang menentukan pesan untuk pengguna.
        if (err?.kind === 'disabled') return [];
        throw err;
    }
}

/**
 * Data satu section homepage.
 * @param {'ongoing'|'popular'|'recent'|'donghua'} kind
 * @returns {Promise<ListResult>}
 */
export async function getHomeSection(kind) {
    const size = UI.sectionSize;
    const steps = [{ source: 'anilist', run: async () => ((await anilist.getHomeLists())[kind] || []).slice(0, size) }];
    if (kind === 'ongoing') {
        steps.push({ source: 'kitsu', run: () => kitsu.listAnime({ status: 'current', limit: size }) });
    } else if (kind === 'popular') {
        steps.push({ source: 'kitsu', run: () => kitsu.listAnime({ limit: size }) });
    } else if (kind === 'recent') {
        steps.push({ source: 'kitsu', run: () => kitsu.listAnime({ season: true, limit: size }) });
    }
    // donghua: rilis terbaru dari backend (animexin, episode bisa langsung diputar) → AniList CN →
    // Kitsu (ONA/TV tayang berjudul pinyin; bekerja tanpa backend & saat AniList mati) → data cadangan.
    if (kind === 'donghua') {
        steps.unshift({ source: 'backend', run: async () => (await backendDonghua()).slice(0, size) });
        steps.push({ source: 'kitsu', run: () => kitsu.currentDonghua({ limit: size }) });
    }
    const res = await firstAvailable(steps);
    const out = finishList(res, { fallbackItems: HOME_FALLBACK[kind] || [] });
    out.items = out.items.slice(0, size);
    out.hasNext = false;
    return out;
}

/**
 * Rilis Sub Indo per situs, **tanpa verifikasi episode** (24 Okt 2026).
 * Panel menampilkan katalog yang dikirim backend apa adanya.
 * @param {{signal?: AbortSignal, sourceIds?: string[], refresh?: boolean}} [opts]
 *   sourceIds: batasi ke situs tertentu (tombol "Coba lagi" per panel).
 *   refresh: ambil katalog baru tanpa cache (perlu saat sumber sebelumnya gagal).
 */
export function getSubIndoHomeSources({ signal, sourceIds, refresh = false } = {}) {
    return loadSubIndoSources({
        getSources: (opts) => backend.getLatestSubIndoBySource({ ...opts, refresh }),
        signal,
        sourceIds,
        refresh,
    });
}

/** Alias kompatibilitas; hasil Sub Indo tetap dikelompokkan per sumber. */
export function getSubIndoHomeSection(opts = {}) {
    return getSubIndoHomeSources(opts);
}

/**
 * Slide hero: anime trending yang sedang tayang (dengan sinopsis & banner).
 * @returns {Promise<ListResult>}
 */
export async function getHeroSlides() {
    const res = await firstAvailable([
        { source: 'anilist', run: async () => (await anilist.getHomeLists()).ongoing || [] },
        { source: 'kitsu', run: () => kitsu.trending({ limit: 10 }) },
    ]);
    const out = finishList(res, { fallbackItems: FALLBACK_HERO });
    out.items = out.items.slice(0, UI.heroMaxSlides);
    return out;
}

/* ------------------------------------------------------------------ */
/* Genre & halaman jelajah ("Lihat Semua")                             */
/* ------------------------------------------------------------------ */
export function findGenre(label) {
    const key = String(label || '').toLowerCase();
    return GENRES.find((g) => g.label.toLowerCase() === key) || null;
}

/**
 * Anime berdasarkan genre (homepage & search.html?genre=).
 * @param {string} label
 * @param {{page?:number, perPage?:number, sort?:string, formats?:string[], source?:string, signal?:AbortSignal}} [opts]
 * @returns {Promise<ListResult>}
 */
/**
 * "Coming Soon" di halaman Jelajah.
 *
 * AnimeKu dan Oploverz tidak menyediakan halaman ini (dicek 23 Okt 2026:
 * /upcoming/, /jadwal/, /genre/ AnimeKu → 404; `?status=upcoming` Oploverz → 0 kartu),
 * jadi bagian ini memakai metadata yang sudah dipakai situs (AniList → Kitsu) dan
 * UI menuliskan sumbernya. Judul yang belum tayang tetap bisa dibuka; watch.html
 * menampilkan "Anime ini belum tayang" alih-alih player kosong.
 */
export async function getUpcomingAnime({ page = 1, perPage = UI.sectionSize, signal } = {}) {
    const steps = [
        { source: 'anilist', run: () => anilist.searchMedia({ status: 'NOT_YET_RELEASED', sort: 'popularity', page, perPage, signal }) },
        { source: 'kitsu', run: () => kitsu.listAnime({ status: 'upcoming', page, limit: perPage, signal }) },
    ];
    return finishList(await firstAvailable(steps), { page });
}

export async function getGenreAnime(label, { page = 1, perPage = UI.sectionSize, sort = 'relevance', formats = [], source, signal, year = '', season = '' } = {}) {
    const g = findGenre(label);
    if (!g) return finishList({ items: [], errors: [new ApiError('Genre tidak dikenal.', { kind: 'empty' })] }, { page });
    const s = sort === 'relevance' ? 'popularity' : sort;
    // Filter Tahun & Musim (24 Okt 2026). Nilai season: winter|spring|summer|fall.
    const seasonName = /^(winter|spring|summer|fall)$/.test(String(season || '').toLowerCase()) ? String(season).toLowerCase() : '';
    const seasonYear = /^\d{4}$/.test(String(year || '')) ? Number(year) : undefined;
    const steps = [
        {
            source: 'anilist',
            run: () => anilist.searchMedia({
                genre: g.anilistTag ? undefined : g.label,
                tag: g.anilistTag,
                sort: s,
                formats,
                page,
                perPage,
                signal,
                season: seasonName ? seasonName.toUpperCase() : undefined,
                seasonYear,
            }),
        },
        {
            source: 'kitsu',
            run: () => kitsu.listAnime({
                category: g.kitsu,
                sort: s,
                formats,
                page,
                limit: perPage,
                genreLabel: g.label,
                seasonName,
                seasonYear,
                signal,
            }),
        },
    ];
    return finishList(await firstAvailable(onlySource(steps, source)), { page });
}

/** "Baru Rilis" berhalaman dengan filter format di sisi klien (maks 3 halaman per panggilan). */
async function recentFiltered({ page, formats, signal }) {
    let current = page;
    const items = [];
    let hasNext = false;
    for (let round = 0; round < 3; round++) {
        // eslint-disable-next-line no-await-in-loop
        const res = await anilist.recentEpisodes({ page: current, signal });
        items.push(...filterFormats(res.items, formats));
        hasNext = res.hasNext;
        current += 1;
        if (!hasNext || !formats.length || items.length >= 10) break;
    }
    return { items, hasNext, nextPage: current };
}

/**
 * Halaman jelajah search.html?browse=... / ?genre=...
 * @param {'ongoing'|'popular'|'new'|'donghua'|'genre'} kind
 * @param {{page?:number, sort?:string, formats?:string[], genre?:string, source?:string, signal?:AbortSignal}} [opts]
 * @returns {Promise<ListResult>}
 */
export async function browseAnime(kind, { page = 1, sort = 'relevance', formats = [], genre, source, signal } = {}) {
    const perPage = UI.searchPerPage;
    if (kind === 'genre') return getGenreAnime(genre, { page, perPage, sort, formats, source, signal });

    const pick = (byDefault) => (sort === 'relevance' ? byDefault : sort);
    let steps;
    let fallbackItems = [];
    switch (kind) {
        case 'ongoing':
            steps = [
                { source: 'anilist', run: () => anilist.searchMedia({ status: 'RELEASING', sort: pick('trending'), formats, page, perPage, signal }) },
                { source: 'kitsu', run: () => kitsu.listAnime({ status: 'current', sort: pick('popularity'), formats, page, limit: perPage, signal }) },
            ];
            fallbackItems = FALLBACK_ONGOING;
            break;
        case 'popular':
            steps = [
                { source: 'anilist', run: () => anilist.searchMedia({ sort: pick('popularity'), formats, page, perPage, signal }) },
                { source: 'kitsu', run: () => kitsu.listAnime({ sort: pick('popularity'), formats, page, limit: perPage, signal }) },
            ];
            fallbackItems = FALLBACK_POPULAR;
            break;
        case 'new':
            steps = [
                { source: 'anilist', run: () => recentFiltered({ page, formats, signal }) },
                { source: 'kitsu', run: () => kitsu.listAnime({ season: true, sort: 'popularity', formats, page, limit: perPage, signal }) },
            ];
            fallbackItems = FALLBACK_NEW;
            break;
        case 'donghua':
            // AniList punya filter negara asal (countryOfOrigin: CN) + halaman; backend (animexin)
            // menjadi cadangan untuk halaman pertama.
            steps = [
                { source: 'anilist', run: () => anilist.searchMedia({ country: 'CN', sort: pick('trending'), formats, page, perPage, signal }) },
            ];
            if (page === 1) {
                steps.push({ source: 'backend', run: async () => filterFormats(await backendDonghua({ signal }), formats) });
                steps.push({ source: 'kitsu', run: async () => filterFormats(await kitsu.currentDonghua({ limit: perPage, signal }), formats) });
            }
            fallbackItems = FALLBACK_DONGHUA;
            break;
        default:
            return finishList({ items: [], errors: [new ApiError('Kategori tidak dikenal.', { kind: 'empty' })] }, { page });
    }
    return finishList(await firstAvailable(onlySource(steps, source)), { page, fallbackItems });
}

/* ------------------------------------------------------------------ */
/* Pencarian                                                           */
/* ------------------------------------------------------------------ */
export const SEARCH_SOURCE_ORDER = Object.freeze(['anilist', 'kitsu']);

/**
 * Cari di beberapa sumber secara paralel. Satu sumber gagal tidak
 * menggagalkan yang lain.
 * @param {string} q
 * @param {{page?:number, sort?:string, formats?:string[], sources?:string[], signal?:AbortSignal}} [opts]
 * @returns {Promise<Record<string, {items: Anime[], hasNext: boolean, total: number|null, error: ApiError|null}>>}
 */
export async function searchAnime(q, { page = 1, sort = 'relevance', formats = [], sources = SEARCH_SOURCE_ORDER, signal } = {}) {
    const runners = {
        anilist: () => anilist.searchMedia({ q, page, sort, formats, perPage: UI.searchPerPage, signal }),
        kitsu: () => kitsu.searchAnime({ q, page, sort, formats, limit: UI.searchPerPage, signal }),
        // Situs (24 Okt 2026, putaran 7): AnimeKu & Oploverz dicari lewat backend dalam satu
        // panggilan. Situs tidak punya halaman berikutnya maupun filter urutan/format.
        backend: async () => {
            const found = await backend.searchBackend(q, { signal });
            return { items: found.items || [], hasNext: false, total: null };
        },
    };
    const list = sources.filter((s) => runners[s]);
    const settled = await Promise.allSettled(list.map((s) => runners[s]()));
    if (signal?.aborted) throw new ApiError('Permintaan dibatalkan.', { kind: 'abort' });
    const out = {};
    list.forEach((s, i) => {
        const r = settled[i];
        out[s] = r.status === 'fulfilled'
            ? { items: r.value?.items || [], hasNext: Boolean(r.value?.hasNext), total: r.value?.total ?? null, error: null }
            : { items: [], hasNext: false, total: null, error: r.reason };
    });
    return out;
}

/** Kunci pembanding untuk membuang duplikat lintas sumber. */
export function dedupeKeys(anime) {
    const keys = [];
    const t1 = titleKey(anime.title);
    const t2 = titleKey(anime.titleAlt);
    if (t1) keys.push(`t:${t1}`);
    if (t2) keys.push(`t:${t2}`);
    if (anime.ids?.anilist) keys.push(`al:${anime.ids.anilist}`);
    if (anime.ids?.mal) keys.push(`mal:${anime.ids.mal}`);
    if (anime.ids?.kitsu) keys.push(`ki:${anime.ids.kitsu}`);
    return keys;
}

/**
 * Gabungkan hasil beberapa sumber tanpa duplikat.
 *  - relevance/popularity: diselang-seling per peringkat (AniList, Kitsu)
 *  - score: skor tertinggi dulu · newest: tahun terbaru dulu
 * @param {Record<string, Anime[]>} bySource
 * @param {{sort?: string, seen?: Set<string>}} [opts] `seen` diisi & dipakai ulang untuk "Muat Lebih Banyak"
 * @returns {Anime[]}
 */
export function mergeAnimeLists(bySource, { sort = 'relevance', seen = new Set() } = {}) {
    const lists = ['anilist', 'kitsu'].map((s) => bySource[s] || []);
    let sequence = [];
    if (sort === 'score' || sort === 'newest') {
        const field = sort === 'score' ? 'score' : 'year';
        sequence = lists.flat().map((a, i) => ({ a, i }))
            .sort((x, y) => ((y.a[field] ?? -1) - (x.a[field] ?? -1)) || (x.i - y.i))
            .map((x) => x.a);
    } else {
        const max = Math.max(0, ...lists.map((l) => l.length));
        for (let i = 0; i < max; i++) lists.forEach((l) => { if (l[i]) sequence.push(l[i]); });
    }
    const out = [];
    for (const anime of sequence) {
        const keys = dedupeKeys(anime);
        if (keys.some((k) => seen.has(k))) continue;
        keys.forEach((k) => seen.add(k));
        out.push(anime);
    }
    return out;
}

/**
 * Saran autocomplete: satu Promise per sumber agar dropdown bisa tampil
 * bertahap (sumber yang lambat tidak menahan yang cepat).
 *
 * 24 Okt 2026 (putaran 7) — permintaan pengguna: "gabungkan pencarian data yg di top
 * header jangan dari Kitsu dan AniList saja, gunakan yg di AnimeKu dan Oploverz juga".
 * `backend` mencari di SEMUA adapter scraper (AnimeKu, Oploverz, dll.) dalam satu
 * panggilan; `ui/search-suggest.js` hanya menampilkan AnimeKu & Oploverz. Backend yang
 * tidak aktif akan menolak promise ini → grup situs tidak muncul (tanpa pesan galat).
 *
 * @param {string} q
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {{kitsu: Promise<Anime[]>, anilist: Promise<Anime[]>, backend: Promise<Anime[]>}}
 */
export function suggestAnime(q, { signal } = {}) {
    const timeout = API_CONFIG.suggestTimeout;
    const n = UI.suggestFetch;
    return {
        kitsu: kitsu.searchAnime({ q, limit: n, signal, timeout }).then((r) => r.items),
        anilist: anilist.searchMedia({ q, page: 1, perPage: n, sort: 'relevance', signal, timeout }).then((r) => r.items),
        backend: backend.searchBackend(q, { signal }).then((r) => r.items || []),
    };
}

/* ------------------------------------------------------------------ */
/* Jadwal tayang (WIB)                                                 */
/* ------------------------------------------------------------------ */
const DAY_SEC = 86400;
const OFFSET_SEC = SCHEDULE.utcOffsetHours * 3600;
const pad2 = (n) => String(n).padStart(2, '0');

/** Hari ini (0 = Minggu) menurut WIB, apa pun zona waktu perangkat. */
export function wibWeekday(date = new Date()) {
    return new Date(date.getTime() + OFFSET_SEC * 1000).getUTCDay();
}
const wibDayStart = (sec) => Math.floor((sec + OFFSET_SEC) / DAY_SEC) * DAY_SEC - OFFSET_SEC;
const wibWeekdayOf = (sec) => new Date((sec + OFFSET_SEC) * 1000).getUTCDay();
const wibClock = (sec) => {
    const d = new Date((sec + OFFSET_SEC) * 1000);
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};

/**
 * Jadwal dari backend → per hari: anime Jepang berjam (maks SCHEDULE.perDay, urut jam) lalu donghua
 * (maks SCHEDULE.perDayDonghua; berjam dulu — Anichin punya jam perkiraan — lalu tanpa jam).
 * Anime tanpa jam (mis. Otakudesu) hanya mengisi sisa kuota anime. Tautan item = episode terbaru.
 * Dipisah per negara asal supaya donghua berjam tidak menggeser jatah anime Sub Indo.
 */
async function backendSchedule() {
    if (!backend.isBackendEnabled()) return null;
    try {
        const res = await backend.getSchedule();
        const byDay = {};
        let total = 0;
        const byTime = (a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || String(a.time || '').localeCompare(String(b.time || ''));
        for (const [day, items] of Object.entries(res.days)) {
            const isDonghua = (it) => it.anime?.country === 'CN';
            const anime = items.filter((it) => !isDonghua(it));
            const timed = anime.filter((it) => it.time).slice(0, SCHEDULE.perDay);
            const untimedAnime = anime.filter((it) => !it.time).slice(0, Math.max(0, SCHEDULE.perDay - timed.length));
            const donghua = items.filter(isDonghua).sort(byTime).slice(0, SCHEDULE.perDayDonghua);
            byDay[day] = [...timed, ...untimedAnime, ...donghua].map((it) => ({ ...it, episode: null, aired: true, latest: true }));
            total += byDay[day].length;
        }
        return total ? byDay : null;
    } catch (err) {
        if (err?.kind === 'disabled') return null; // hosting statis tanpa backend → bukan error
        throw err;
    }
}

/**
 * Jadwal 7 hari ke depan (mulai hari ini) dalam WIB.
 * Urutan: backend (jadwal rilis Sub Indo Samehadaku + donghua AnimeXin/Anichin — situs yang memang
 * dipakai untuk memutar) → AniList (jam tayang Jepang) → data contoh.
 * @returns {Promise<{byDay: Record<number, Array<{time:string|null,title:string,episode:number|null,aired:boolean,latest?:boolean,anime?:Anime}>|Array<[string,string]>>, today:number, source:'backend'|'anilist'|'fallback', error?: ApiError}>}
 */
export async function getWeeklySchedule() {
    const today = wibWeekday();
    const errors = [];

    try {
        const byDay = await backendSchedule();
        if (byDay) return { byDay, today, source: 'backend' };
    } catch (err) {
        errors.push(err);
    }

    try {
        const start = wibDayStart(Math.floor(Date.now() / 1000));
        const windows = Array.from({ length: 7 }, (_, i) => ({ key: `d${i}`, start: start + i * DAY_SEC, end: start + (i + 1) * DAY_SEC }));
        const res = await anilist.airingWindows(windows);
        const byDay = {};
        let total = 0;
        windows.forEach((w) => {
            const entries = res[w.key];
            if (!entries) return;
            const top = [...entries]
                .sort((a, b) => (b.anime.popularity || 0) - (a.anime.popularity || 0))
                .slice(0, SCHEDULE.perDay)
                .sort((a, b) => a.airingAt - b.airingAt);
            const nowSec = Date.now() / 1000;
            byDay[wibWeekdayOf(w.start)] = top.map((e) => ({
                time: wibClock(e.airingAt),
                title: e.anime.title,
                episode: e.episode,
                aired: e.airingAt <= nowSec,
                anime: e.anime,
            }));
            total += top.length;
        });
        if (total) return { byDay, today, source: 'anilist' };
        errors.push(new ApiError('Jadwal kosong.', { kind: 'empty', source: 'anilist' }));
    } catch (err) {
        errors.push(err);
    }

    return { byDay: FALLBACK_SCHEDULE, today, source: 'fallback', error: pickError(errors) };
}

/* ------------------------------------------------------------------ */
/* Halaman nonton (Tahap C)                                            */
/* ------------------------------------------------------------------ */
const FALLBACK_ALL = [FALLBACK_ONGOING, FALLBACK_POPULAR, FALLBACK_NEW, FALLBACK_DONGHUA, FALLBACK_HERO];

/** Item data cadangan dengan judul yang sama (untuk tampilan awal / saat semua API gagal). */
function findFallbackAnime(title) {
    const key = titleKey(title);
    if (!key) return null;
    for (const list of FALLBACK_ALL) {
        const hit = list.find((a) => titleKey(a.title) === key);
        if (hit) return hit;
    }
    return null;
}

/**
 * @typedef {{title?:string, alt?:string, anilist?:number|null, mal?:number|null, kitsu?:string|null, slug?:string|null, src?:string|null}} AnimeRef
 *   Isi URL watch.html (lihat routes.parseWatchParams).
 */

/**
 * Anime sementara dari parameter URL (tampil instan sebelum detail datang).
 * Khusus objek ini: `title` = '' bila URL tidak membawa judul (mis. watch.html?anilist=21),
 * supaya halaman tahu judul belum diketahui (bukan "Tanpa Judul" dari createAnime).
 * @param {AnimeRef} ref
 * @returns {Anime}
 */
export function provisionalAnime(ref) {
    const known = findFallbackAnime(ref.title);
    // Id MAL di URL (tautan lama) dibuka lewat AniList (idMal) — sumbernya ditandai AniList.
    const source = ref.src ? `backend:${ref.src}` : (ref.anilist || ref.mal) ? 'anilist' : ref.kitsu ? 'kitsu' : (known?.source || 'fallback');
    const anime = createAnime({
        ...(known || {}),
        id: undefined,
        title: ref.title || known?.title || '',
        titleAlt: ref.alt || known?.titleAlt || '',
        ids: { anilist: ref.anilist, mal: ref.mal, kitsu: ref.kitsu },
        slug: ref.slug || null,
        source,
    });
    if (!ref.title && !known) anime.title = '';
    return anime;
}

/** "Solo Leveling S2" → "Solo Leveling Season 2" (judul data cadangan lebih mudah ditemukan). */
function titleQuery(title) {
    return String(title || '').replace(/\bS(\d{1,2})\b/g, 'Season $1').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Hasil pencarian judul bertentangan dengan id di URL → itu anime lain, jangan dipakai. */
function conflictsWithRef(anime, ref) {
    return Boolean((ref.anilist && anime.ids.anilist && anime.ids.anilist !== ref.anilist)
        || (ref.mal && anime.ids.mal && anime.ids.mal !== ref.mal));
}

/**
 * Data utama halaman nonton.
 *
 * Rantai (berhenti di langkah pertama yang berhasil):
 *  1. AniList by id / idMal   → detail + episode berikutnya + rekomendasi (1 request)
 *  2. Kitsu by id             → mapping id MAL/AniList → kembali ke AniList
 *  3. Backend by slug         (Tahap D; dilewati bila backend nonaktif / tidak berjalan)
 *  4. Pencarian judul         AniList → Kitsu (hasil yang id-nya bertentangan dengan URL dibuang)
 *     Hasil tanpa id AniList/MAL (Kitsu tanpa mapping, backend) → id dicari lewat judul.
 *  5. Data cadangan / data URL (fallback: true)
 * (Langkah Jikan/MyAnimeList dihapus 22 Okt 2026.)
 * ID dari URL selalu dipertahankan (dilengkapi, tidak ditimpa).
 *
 * @param {AnimeRef} ref
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{anime: Anime, recommendations: Anime[]|null, source: string, fallback: boolean, error?: ApiError}>}
 */
export async function getWatchData(ref, { signal } = {}) {
    const errors = [];
    const recs = PLAYER.recommendationCount;

    /** Jalankan satu langkah; kembalikan {anime, recommendations?, source} atau null. */
    const attempt = async (source, run) => {
        try {
            const out = await run();
            if (out?.anime && !conflictsWithRef(out.anime, ref)) return { ...out, source };
            errors.push(new ApiError('Anime tidak ditemukan.', { kind: 'empty', source }));
        } catch (err) {
            if (err?.kind === 'abort') throw err;
            errors.push(err instanceof ApiError ? err : new ApiError(err?.message || 'Gagal memuat.', { kind: 'parse', source, cause: err }));
        }
        return null;
    };
    const anilistById = (id, idMal) => attempt('anilist', () => anilist.getMediaDetail({ id, idMal, recs, signal }));

    let res = null;
    if (ref.anilist || ref.mal) res = await anilistById(ref.anilist, ref.anilist ? null : ref.mal);

    if (!res && ref.kitsu) {
        const k = await attempt('kitsu', async () => ({ anime: await kitsu.getAnimeById(ref.kitsu, { signal }) }));
        if (k) {
            const { anilist: al, mal } = k.anime.ids;
            let viaIds = null;
            if (al || mal) viaIds = await anilistById(al, al ? null : mal);
            res = viaIds ? { ...viaIds, anime: withIds(viaIds.anime, k.anime.ids) } : k;
        }
    }

    if (!res && ref.slug && backend.isBackendEnabled()) {
        res = await attempt('backend', () => backend.getBackendAnime(ref.slug, { signal }));
    }

    /** Pencarian judul: AniList (→ Kitsu bila `withKitsu`). Judul yang sama tidak dicari 2x. */
    const triedTitles = new Set();
    const byTitle = async (title, { withKitsu = true } = {}) => {
        const q = titleQuery(title);
        if (!q || triedTitles.has(q)) return null;
        triedTitles.add(q);
        return await attempt('anilist', () => anilist.getMediaDetail({ search: q, recs, signal }))
            || (withKitsu ? await attempt('kitsu', async () => ({ anime: await kitsu.findByTitle(q, { signal }) })) : null);
    };

    if (!res && ref.title) res = await byTitle(ref.title);
    if (!res && ref.alt) res = await byTitle(ref.alt);

    // Hasil tanpa id AniList/MAL (mis. Kitsu tanpa mapping, atau backend) → server streaming
    // tidak bisa dipakai. Cari id-nya lewat judul; hasil AniList dipakai bila tidak bertentangan.
    if (res && !res.anime.ids.anilist && !res.anime.ids.mal) {
        const found = await byTitle(ref.title || res.anime.title, { withKitsu: false });
        if (found && (found.anime.ids.anilist || found.anime.ids.mal)) {
            const base = res.anime;
            const merged = { ...found.anime, slug: found.anime.slug || base.slug };
            if (res.source === 'backend' && base.slug) {
                // Episode diputar dari situs sumber → jumlah/status episode situs itu yang dipakai untuk
                // navigasi (judul bisa cocok ke season lain di AniList/MAL, mis. seri donghua bernomor lanjut).
                // Episode terbaru = milik situs sumber (yang benar-benar bisa diputar Sub Indo); metadata hanya
                // bila situs tidak mencantumkan daftar episode. (Dulu: nilai terbesar → bisa menunjuk episode
                // yang sudah tayang di Jepang tetapi belum ada subtitle Indonesianya.)
                merged.latestEpisode = base.latestEpisode || found.anime.latestEpisode || null;
                if (base.episodes || base.latestEpisode) merged.episodes = base.episodes || null;
                if (base.status !== 'UNKNOWN') merged.status = base.status;
                // Perkiraan jadwal mingguan milik judul yang cocok (bisa season lain) tidak berlaku di sini.
                merged.firstAiredAt = null;
                // Jadwal "episode berikutnya" milik season lain (nomornya sudah lewat) → jangan ditampilkan.
                if (merged.nextAiring?.episode && merged.nextAiring.episode <= (merged.latestEpisode || 0)) merged.nextAiring = null;
            }
            res = { ...found, anime: withIds(merged, base.ids) };
        }
    }

    if (res) {
        const anime = withIds({ ...res.anime, slug: res.anime.slug || ref.slug || null }, ref);
        return { anime, recommendations: res.recommendations || null, source: res.source, fallback: false };
    }
    return { anime: provisionalAnime(ref), recommendations: null, source: 'fallback', fallback: true, error: pickError(errors) };
}

/**
 * Rekomendasi untuk halaman nonton (anime yang sedang dibuka tidak ikut).
 * Rantai: rekomendasi AniList (sudah ikut di getWatchData, 0 request tambahan)
 *       → anime se-genre → anime populer (cache homepage) → data cadangan.
 * @param {Anime|null} anime
 * @param {{preloaded?: Anime[]|null, signal?: AbortSignal, limit?: number}} [opts]
 * @returns {Promise<{items: Anime[], source: string|null, fallback: boolean}>}
 */
export async function getRecommendations(anime, { preloaded = null, signal, limit = PLAYER.recommendationCount } = {}) {
    const exclude = anime ? dedupeKeys(anime) : [];
    const pick = (items) => {
        const seen = new Set(exclude);
        const out = [];
        for (const a of items || []) {
            const keys = dedupeKeys(a);
            if (keys.some((k) => seen.has(k))) continue;
            keys.forEach((k) => seen.add(k));
            out.push(a);
            if (out.length >= limit) break;
        }
        return out;
    };

    const first = pick(preloaded);
    if (first.length) return { items: first, source: 'anilist', fallback: false };

    const steps = [];
    const genre = (anime?.genres || []).map(findGenre).find(Boolean);
    if (genre) steps.push({ source: 'genre', run: () => getGenreAnime(genre.label, { signal }) });
    steps.push({ source: 'popular', run: () => getHomeSection('popular') });

    for (const step of steps) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const res = await step.run();
            const items = pick(res?.items);
            if (items.length) return { items, source: res.source || step.source, fallback: Boolean(res.fallback) };
        } catch (err) {
            if (err?.kind === 'abort') throw err;
        }
    }
    return { items: [], source: null, fallback: true };
}

/* ------------------------------------------------------------------ */
/* Status sumber                                                       */
/* ------------------------------------------------------------------ */
const PINGS = { anilist: anilist.ping, kitsu: kitsu.ping, backend: backend.ping };

/** Sumber yang relevan untuk ditampilkan di widget status. */
export function activeApiSources() {
    return API_SOURCES.filter((s) => s !== 'backend' || backend.isBackendEnabled());
}

/**
 * Cek ringan sumber yang statusnya belum diketahui (atau semua bila all=true).
 * Sumber yang sudah terpakai oleh halaman tidak di-ping ulang.
 */
export async function checkApiSources({ all = false } = {}) {
    const health = getAllHealth();
    const targets = activeApiSources().filter((s) => all || health[s].state === 'unknown');
    await Promise.allSettled(targets.map((s) => PINGS[s]()));
    return getAllHealth();
}
