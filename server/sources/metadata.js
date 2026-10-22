/**
 * Kazanime backend — sources/metadata.js
 * Fallback ke API metadata PUBLIK (resmi, memang untuk diakses program) bila scraper gagal:
 *   Kitsu   https://kitsu.app/api/edge   — bisa dijangkau dari server, punya mapping id MAL/AniList
 *   AniList https://graphql.anilist.co   — sejak 2026-09 butuh Referer & sering "temporarily disabled"
 * Jikan (MyAnimeList tidak resmi) DIHAPUS 22 Okt 2026 atas permintaan pemilik proyek; slug lama
 * "mal~<id>" tetap bisa dibuka lewat AniList (idMal).
 * Urutan bisa diatur lewat METADATA_ORDER. API resmi tidak melewati cek robots.txt (robots
 * mengatur crawling halaman web), tapi tetap kena timeout, throttle per host & circuit breaker.
 *
 * Fungsi:
 *   search(q)            → daftar anime (fallback /api/anime/search)
 *   latestDonghua()      → donghua yang sedang tayang (fallback /api/anime/latest)
 *   findByTitle(title)   → satu anime paling cocok (fallback /api/anime/:slug)
 *   getById(kind, id)    → detail by id (slug kitsu~123 / anilist~123; mal~123 via AniList idMal)
 *   lookupImage(title)   → poster pengganti untuk sumber yang gambarnya dilindungi hotlink:
 *                          Kitsu → Bangumi (judul Mandarin persis) → MangaBaka (judul persis, cover manhua)
 *
 * Sumber poster tambahan (dicek 2026-10-22, METADATA_POSTER_SOURCES):
 *   Bangumi   https://api.bgm.tv (robots.txt hanya melarang /pic/ /img/ /js/) — database anime Tiongkok;
 *             dicari dengan judul MANDARIN dari halaman seri situs sumber, dipakai hanya bila nama
 *             cocok persis (judul Inggris tidak bisa diverifikasi → tidak dipakai). Gambar lain.bgm.tv
 *             bisa ditampilkan dari situs lain.
 *   MangaBaka https://api.mangabaka.org/v1 (robots.txt mengizinkan /v1/) — database manga/manhua;
 *             cover KOMIK sumber adaptasi, dipakai paling akhir dan hanya bila judul cocok persis.
 */
import { BOT, CACHE, METADATA } from '../config.js';
import { makeAnime } from '../lib/anime.js';
import { SourceError, combineErrors, isAbort } from '../lib/errors.js';
import { bracketParts, cleanText, parseDurationMinutes, parseFormat, parseYear, stripSeason, titleKey } from '../lib/text.js';

/* ------------------------------------------------------------------ */
/* Normalisasi (murni, diekspor untuk unit test)                       */
/* ------------------------------------------------------------------ */
const KITSU_STATUS = { current: 'ONGOING', finished: 'COMPLETED', upcoming: 'UPCOMING', unreleased: 'UPCOMING', tba: 'UPCOMING' };

/**
 * Negara asal dari kunci judul Kitsu (Kitsu tidak punya field negara).
 * Penanda andal = judul romanisasi: en_cn (pinyin) / en_kr / en_jp (romaji). zh_cn saja TIDAK cukup:
 * anime Jepang pun sering punya terjemahan zh_cn (mis. Sousou no Frieren).
 */
export function kitsuCountry(titles = {}) {
    if (titles.en_cn) return 'CN';
    if (titles.en_kr) return 'KR';
    if (titles.en_jp) return 'JP';
    if (titles.zh_cn && !titles.ja_jp && !titles.ko_kr) return 'CN';
    if (titles.ko_kr && !titles.ja_jp) return 'KR';
    if (titles.ja_jp) return 'JP';
    return null;
}

/**
 * @param {any} item     data[i] dari respons Kitsu
 * @param {Map<string, any>} included  "type:id" → resource (mappings)
 */
export function normalizeKitsu(item, included = new Map()) {
    const at = item?.attributes || {};
    const titles = at.titles || {};
    const mappings = (item?.relationships?.mappings?.data || []).map((r) => included.get(`mappings:${r.id}`)).filter(Boolean);
    const mapId = (site) => {
        const m = mappings.find((x) => x.attributes?.externalSite === site);
        const n = m ? Number.parseInt(m.attributes.externalId, 10) : NaN;
        return Number.isInteger(n) && n > 0 ? n : null;
    };
    const title = titles.en || at.canonicalTitle || titles.en_jp || titles.en_cn || '';
    return makeAnime({
        title,
        titleAlt: at.canonicalTitle && at.canonicalTitle !== title ? at.canonicalTitle : (titles.en_jp || titles.en_cn || ''),
        image: at.posterImage?.large || at.posterImage?.medium || at.posterImage?.original,
        banner: at.coverImage?.large || at.coverImage?.original,
        description: at.synopsis || at.description,
        episodes: at.episodeCount,
        score: at.averageRating ? Number(at.averageRating) / 10 : null,
        status: KITSU_STATUS[at.status] || 'UNKNOWN',
        format: parseFormat(at.subtype || at.showType),
        year: parseYear(at.startDate),
        country: kitsuCountry(titles),
        ids: { kitsu: item?.id, mal: mapId('myanimelist/anime'), anilist: mapId('anilist/anime') },
        source: 'kitsu',
        duration: at.episodeLength,
        nextAiring: at.nextRelease ? { airingAt: Date.parse(at.nextRelease) / 1000 } : null,
        url: `https://kitsu.app/anime/${at.slug || item?.id}`,
    });
}

/** Semua judul sebuah item Kitsu (untuk pencocokan judul persis). */
export function kitsuTitles(item) {
    const at = item?.attributes || {};
    return [at.canonicalTitle, ...Object.values(at.titles || {}), ...(at.abbreviatedTitles || [])].filter(Boolean);
}

const AL_STATUS = { RELEASING: 'ONGOING', FINISHED: 'COMPLETED', NOT_YET_RELEASED: 'UPCOMING', HIATUS: 'ONGOING', CANCELLED: 'COMPLETED' };
const AL_FORMAT = { TV: 'TV', TV_SHORT: 'TV', MOVIE: 'MOVIE', SPECIAL: 'SPECIAL', OVA: 'OVA', ONA: 'ONA', MUSIC: 'MUSIC' };

export function normalizeAniList(m) {
    const next = m?.nextAiringEpisode;
    return makeAnime({
        title: m?.title?.english || m?.title?.romaji,
        titleAlt: m?.title?.english ? m?.title?.romaji : (m?.title?.native || ''),
        image: m?.coverImage?.extraLarge || m?.coverImage?.large,
        banner: m?.bannerImage,
        description: cleanText(String(m?.description || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')),
        episodes: m?.episodes,
        latestEpisode: next?.episode > 1 ? next.episode - 1 : null,
        genres: m?.genres,
        score: m?.averageScore ? m.averageScore / 10 : null,
        status: AL_STATUS[m?.status] || 'UNKNOWN',
        format: AL_FORMAT[m?.format] || '',
        year: m?.seasonYear || m?.startDate?.year,
        country: m?.countryOfOrigin,
        ids: { anilist: m?.id, mal: m?.idMal },
        source: 'anilist',
        studios: (m?.studios?.nodes || []).map((n) => n?.name),
        duration: m?.duration,
        season: m?.season,
        popularity: m?.popularity,
        nextAiring: next ? { episode: next.episode, airingAt: next.airingAt } : null,
        url: m?.siteUrl,
    });
}

const AL_FIELDS = `id idMal siteUrl title { romaji english native } coverImage { extraLarge large } bannerImage
  description(asHtml: false) episodes genres averageScore popularity status format season seasonYear
  startDate { year } countryOfOrigin duration nextAiringEpisode { episode airingAt } studios(isMain: true) { nodes { name } }`;

export const ANILIST_PAGE_QUERY = `query ($search: String, $page: Int, $perPage: Int, $country: CountryCode, $status: MediaStatus, $sort: [MediaSort]) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, isAdult: false, search: $search, countryOfOrigin: $country, status: $status, sort: $sort) { ${AL_FIELDS} }
  }
}`;

export const ANILIST_MEDIA_QUERY = `query ($id: Int, $idMal: Int) {
  Media(id: $id, idMal: $idMal, type: ANIME) { ${AL_FIELDS} }
}`;

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */
/**
 * @param {{network: any, createClient: Function, cache: import('../lib/cache.js').TtlCache, config?: typeof METADATA}} deps
 */
/** Ada huruf Han/Kana/Hangul? */
export const hasCjk = (s) => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(String(s || ''));

/** Kunci pembanding judul yang aman untuk huruf Mandarin: tanpa spasi/tanda baca, huruf kecil, NFKC. */
export function cjkKey(s) {
    return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function createMetadata({ network, createClient, cache, config = METADATA }) {
    const common = { robots: false, timeoutMs: config.timeoutMs, retries: 1 };
    const kitsu = createClient(network, { ...common, source: 'kitsu', allowedHosts: ['kitsu.app', 'kitsu.io'], intervalMs: config.kitsu.minIntervalMs });
    const anilist = createClient(network, {
        ...common,
        source: 'anilist',
        allowedHosts: ['graphql.anilist.co'],
        intervalMs: config.anilist.minIntervalMs,
        // AniList menolak request tanpa Referer sejak 2026-09; kirim URL situs kita sendiri (jujur) bila diketahui.
        headers: { 'Content-Type': 'application/json', ...(BOT.siteUrl ? { Referer: `${BOT.siteUrl}/` } : {}) },
    });

    /* ---------------- Kitsu ---------------- */
    async function kitsuGet(path, params, ctx) {
        const url = new URL(`${config.kitsu.baseUrl}${path}`);
        for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, String(v));
        const json = await kitsu.json(url.href, { ...ctx, accept: 'application/vnd.api+json' });
        const included = new Map((json.included || []).map((r) => [`${r.type}:${r.id}`, r]));
        const data = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
        return { data, included };
    }

    /**
     * Pencarian Kitsu. light = hanya field judul & gambar (untuk lookupImage, respons jauh lebih kecil).
     * @returns {Promise<{anime: ReturnType<typeof normalizeKitsu>, titles: string[]}[]>}
     */
    async function kitsuFind(q, ctx, limit = 10, { light = false } = {}) {
        const params = { 'filter[text]': q, 'page[limit]': Math.min(20, limit) };
        if (light) params['fields[anime]'] = 'canonicalTitle,titles,abbreviatedTitles,posterImage,coverImage,slug';
        else params.include = 'mappings';
        const { data, included } = await kitsuGet('/anime', params, ctx);
        return data.map((d) => ({ anime: normalizeKitsu(d, included), titles: kitsuTitles(d) }));
    }

    async function kitsuSearch(q, ctx, limit = 10) {
        return (await kitsuFind(q, ctx, limit)).map((x) => x.anime);
    }

    /** Entri Kitsu yang SALAH SATU judulnya (en / romaji / pinyin / singkatan) persis sama dengan kandidat. */
    function pickExactKitsu(entries, keys) {
        return entries.find((e) => e.titles.some((t) => keys.has(titleKey(t))))?.anime || null;
    }

    /* ---------------- Poster tambahan: Bangumi & MangaBaka ---------------- */
    const posterSources = new Set(config.posterSources || ['kitsu', 'bangumi', 'mangabaka']);
    const bangumi = createClient(network, {
        source: 'bangumi', allowedHosts: ['api.bgm.tv'], robots: true, timeoutMs: config.timeoutMs, retries: 0, intervalMs: config.bangumi.minIntervalMs,
    });
    const mangabaka = createClient(network, {
        source: 'mangabaka', allowedHosts: ['api.mangabaka.org'], robots: true, timeoutMs: config.timeoutMs, retries: 0, intervalMs: config.mangabaka.minIntervalMs,
    });

    /** Poster Bangumi untuk judul Mandarin — hanya bila nama (asli / zh) cocok persis. */
    async function bangumiPoster(native, ctx) {
        const q = cleanText(native).slice(0, 60);
        if (!q || !hasCjk(q)) return null;
        const json = await bangumi.json(`${config.bangumi.baseUrl}/search/subject/${encodeURIComponent(q)}?type=2&responseGroup=small&max_results=10`, ctx);
        const want = cjkKey(q);
        const hit = (Array.isArray(json?.list) ? json.list : []).find((x) => [x?.name, x?.name_cn].some((n) => n && cjkKey(n) === want));
        const img = hit?.images?.large || hit?.images?.common || '';
        return /^https?:\/\/lain\.bgm\.tv\//.test(img) ? img.replace(/^http:\/\//, 'https://') : null;
    }

    /** Cover MangaBaka (manhua/novel sumber adaptasi) — hanya bila salah satu judul cocok persis. */
    async function mangabakaPoster(titles, ctx) {
        const keys = new Set(titles.map((t) => cjkKey(t)).filter((k) => k.length >= 2));
        for (const q of titles.slice(0, 2)) {
            const json = await mangabaka.json(`${config.mangabaka.baseUrl}/series/search?q=${encodeURIComponent(q)}&limit=5`, ctx);
            const hit = (Array.isArray(json?.data) ? json.data : []).find((x) => ['safe', 'suggestive'].includes(x?.content_rating)
                && [x.title, x.native_title, x.romanized_title].some((t) => t && keys.has(cjkKey(t))));
            const raw = hit?.cover?.raw?.url;
            const img = /^https:\/\//.test(raw || '') ? raw : hit?.cover?.x350?.x1 || hit?.cover?.x250?.x1 || null;
            if (img && /^https:\/\//.test(img)) return img;
        }
        return null;
    }

    /* ---------------- AniList ---------------- */
    async function anilistQuery(query, variables, ctx) {
        const json = await anilist.json(config.anilist.baseUrl, { ...ctx, method: 'POST', body: JSON.stringify({ query, variables }) });
        if (json.errors?.length) throw new SourceError(`AniList: ${String(json.errors[0].message || 'error').slice(0, 120)}`, { kind: 'http', source: 'anilist' });
        return json.data;
    }

    async function anilistSearch(q, ctx, limit = 10) {
        const data = await anilistQuery(ANILIST_PAGE_QUERY, { search: q, page: 1, perPage: Math.min(25, limit), sort: ['SEARCH_MATCH'] }, ctx);
        return (data?.Page?.media || []).map(normalizeAniList);
    }

    const SEARCHERS = { kitsu: kitsuSearch, anilist: anilistSearch };
    const order = config.order.filter((p) => SEARCHERS[p]);

    /** Coba penyedia sesuai urutan; yang pertama berhasil dipakai. */
    async function firstProvider(run, providers = order) {
        const errors = [];
        for (const p of providers) {
            try {
                return { provider: p, value: await run(p) };
            } catch (err) {
                if (isAbort(err)) throw err;
                errors.push(err);
            }
        }
        throw combineErrors(errors, 'Semua API metadata sedang tidak bisa dihubungi.');
    }

    /** Hasil yang judulnya persis sama (kunci alfanumerik) dengan salah satu kandidat. */
    function pickExact(items, keys) {
        return items.find((a) => [a.title, a.titleAlt].some((t) => t && keys.has(titleKey(t)))) || null;
    }

    return {
        order,

        async search(q, ctx = {}) {
            const r = await firstProvider((p) => SEARCHERS[p](q, ctx, 12));
            return { provider: r.provider, items: r.value };
        },

        /** Donghua yang sedang tayang: AniList (filter negara CN) atau Kitsu (ONA/TV tayang, judul zh_cn). */
        async latestDonghua(ctx = {}) {
            const providers = order;
            const r = await firstProvider(async (p) => {
                if (p === 'anilist') {
                    const data = await anilistQuery(ANILIST_PAGE_QUERY, { page: 1, perPage: 20, country: 'CN', status: 'RELEASING', sort: ['TRENDING_DESC'] }, ctx);
                    return (data?.Page?.media || []).map(normalizeAniList);
                }
                const lists = await Promise.allSettled(['ONA', 'TV'].map((subtype) => kitsuGet('/anime', {
                    'filter[status]': 'current', 'filter[subtype]': subtype, sort: '-userCount', 'page[limit]': 20, include: 'mappings',
                }, ctx)));
                const ok = lists.filter((x) => x.status === 'fulfilled').map((x) => x.value);
                if (!ok.length) throw lists[0].reason;
                const items = ok.flatMap(({ data, included }) => data.map((d) => normalizeKitsu(d, included)));
                const seen = new Set();
                return items.filter((a) => a.country === 'CN' && !seen.has(a.ids.kitsu) && seen.add(a.ids.kitsu));
            }, providers);
            if (!r.value.length) throw new SourceError('API metadata tidak mengembalikan donghua yang sedang tayang.', { kind: 'not_found', source: r.provider });
            return { provider: r.provider, items: r.value };
        },

        /**
         * Satu anime yang judulnya PERSIS cocok (bukan sekadar hasil teratas — salah season lebih buruk
         * daripada tidak ada). Cocok di judul tanpa penanda season → dikembalikan TANPA id supaya
         * tidak "membajak" identitas anime (frontend akan mencari id-nya sendiri).
         */
        async findByTitle(title, ctx = {}) {
            const q = cleanText(title);
            if (!q) return null;
            const { main, alt } = bracketParts(q);
            const keys = new Set([q, main, alt].filter(Boolean).map(titleKey));
            const baseKeys = new Set([stripSeason(main), stripSeason(alt)].filter(Boolean).map(titleKey));
            const r = await firstProvider(async (p) => {
                if (p === 'kitsu') {
                    const entries = await kitsuFind(q, ctx, 5);
                    const exact = pickExactKitsu(entries, keys);
                    if (exact) return exact;
                    const loose = pickExactKitsu(entries, baseKeys);
                    return loose ? { ...loose, ids: { anilist: null, mal: null, kitsu: null } } : null;
                }
                const items = await SEARCHERS[p](q, ctx, 5);
                const exact = pickExact(items, keys);
                if (exact) return exact;
                const loose = pickExact(items, baseKeys);
                return loose ? { ...loose, ids: { anilist: null, mal: null, kitsu: null } } : null;
            });
            return r.value;
        },

        /** Detail by id: kind = kitsu | mal | anilist. */
        async getById(kind, id, ctx = {}) {
            if (kind === 'kitsu') {
                const { data, included } = await kitsuGet(`/anime/${id}`, { include: 'mappings' }, ctx);
                return data[0] ? normalizeKitsu(data[0], included) : null;
            }
            if (kind === 'mal') {
                // Jikan dihapus → id MAL dicari lewat AniList (field idMal).
                const data = await anilistQuery(ANILIST_MEDIA_QUERY, { idMal: id }, ctx);
                return data?.Media ? normalizeAniList(data.Media) : null;
            }
            if (kind === 'anilist') {
                const data = await anilistQuery(ANILIST_MEDIA_QUERY, { id }, ctx);
                return data?.Media ? normalizeAniList(data.Media) : null;
            }
            return null;
        },

        /**
         * Poster pengganti (di-cache 24 jam; "tidak ketemu" 6 jam). Hanya GAMBAR yang dipakai — id
         * tidak ditempel karena judul bisa cocok ke season lain. Urutan:
         *   1. Kitsu      — judul (+ bagian dalam kurung, + tanpa penanda season) cocok persis (maks 2 request)
         *   2. Bangumi    — judul Mandarin (dari resolveNative(): halaman seri situs sumber) cocok persis
         *   3. MangaBaka  — cover manhua/novel sumber, judul cocok persis (pilihan terakhir)
         * @param {string} title
         * @param {{resolveNative?: () => Promise<string|null>}} [opts]  dipanggil hanya bila Kitsu tidak menemukan
         * @returns {Promise<{image: string|null, banner: string|null, provider?: string}|null>}
         */
        async lookupImage(title, ctx = {}, { resolveNative } = {}) {
            const t = cleanText(title);
            if (!t) return null;
            const key = `meta:img:${titleKey(t)}`;
            const r = await cache.wrap(key, { ttl: (v) => (v ? CACHE.metadataTtlMs : CACHE.metadataMissTtlMs) }, async () => {
                const { main, alt } = bracketParts(t);
                const base = stripSeason(main);
                const fullKeys = new Set([t, main, alt].filter(Boolean).map(titleKey));
                const baseKeys = new Set([base, stripSeason(alt)].filter(Boolean).map(titleKey));
                const toHit = (a) => (a?.image ? { image: a.image, banner: a.banner, provider: 'kitsu' } : null);
                let failure = null;
                const quiet = async (fn) => {
                    try {
                        return await fn();
                    } catch (err) {
                        if (isAbort(err)) throw err;
                        failure ||= err; // satu sumber poster gagal → coba sumber berikutnya
                        return null;
                    }
                };

                if (posterSources.has('kitsu')) {
                    const first = await quiet(() => kitsuFind(t, ctx, 5, { light: true }));
                    const exact = pickExactKitsu(first || [], fullKeys) || pickExactKitsu(first || [], baseKeys);
                    if (exact) return toHit(exact);
                    const second = alt || (titleKey(base) !== titleKey(main) ? base : '');
                    if (second) {
                        const more = await quiet(() => kitsuFind(second, ctx, 5, { light: true }));
                        const hit = toHit(pickExactKitsu(more || [], fullKeys) || pickExactKitsu(more || [], baseKeys));
                        if (hit) return hit;
                    }
                }
                const native = resolveNative ? await quiet(resolveNative) : null;
                if (native && posterSources.has('bangumi')) {
                    const img = await quiet(() => bangumiPoster(native, ctx));
                    if (img) return { image: img, banner: null, provider: 'bangumi' };
                }
                if (posterSources.has('mangabaka')) {
                    const img = await quiet(() => mangabakaPoster([native, main, alt].filter(Boolean), ctx));
                    if (img) return { image: img, banner: null, provider: 'mangabaka' };
                }
                // Ada sumber yang GAGAL (bukan sekadar tidak ketemu) → jangan cache "tidak ada poster" 6 jam
                if (failure) throw failure;
                return null;
            });
            return r.value;
        },
    };
}
