/**
 * Kazanime backend — sources/index.js
 * Registry + aggregator. Routes hanya bicara dengan modul ini; adapter bisa ditambah/diganti
 * tanpa menyentuh routes maupun frontend.
 *
 * Menambah sumber baru:
 *   1. Buat server/sources/<nama>.js yang mengekspor factory `create<Nama>({ network, createClient, baseUrl })`
 *      dan mengembalikan { id, name, baseUrl, policy, parseRef, titleHint, latest, search, getAnime, getEpisode }
 *      — semua hasil lewat makeAnime()/makeEpisode() di lib/anime.js (format seragam).
 *   2. Daftarkan di FACTORIES di bawah + tambahkan base URL di config.js (SOURCES).
 *   3. Tambahkan nama ke SCRAPER_SOURCES (env) bila ingin diaktifkan.
 *
 * Alur & fallback:
 *   latest / search : scraper yang mendukung method dipanggil paralel → digabung (selang-seling) & dedupe judul.
 *                     latest: adapter `supportsLatest: false` (mis. AnimeOnsen: popular, bukan latest) dilewati;
 *                     dedupe lintas sumber (kartu donghua AnimeXin & Anichin tidak dobel);
 *                     search: dedupe PER SUMBER (22 Okt 2026) — judul yang sama dari Samehadaku &
 *                     Otakudesu tetap dikirim agar halaman nonton bisa menggabungkan server keduanya.
 *                     Semua gagal → API metadata publik (fallback: true).
 *   detail          : dirutekan lewat prefix slug ("animexin~…"). Gagal → metadata (judul dari slug).
 *   episode         : hanya dari scraper (metadata tidak punya server streaming) → error yang jelas,
 *                     frontend lalu memakai server statisnya.
 *   schedule        : adapter yang punya schedule() (samehadaku: jam rilis Sub Indo WIB, animexin:
 *                     hari rilis donghua) paralel → digabung per hari. Di-cache 1 jam.
 *   Semua hasil di-cache (TTL 10–15 menit) + stale-if-error 1 jam; "tidak ditemukan" di-cache 5 menit.
 */
import { CACHE, METADATA, SOURCES } from '../config.js';
import { TtlCache } from '../lib/cache.js';
import { AppError, SourceError, badRequest, combineErrors, describeError, isAbort, notFound } from '../lib/errors.js';
import { createClient, createNetwork } from '../lib/fetcher.js';
import { decodeSlug } from '../lib/slug.js';
import { textShowsIndonesianSubtitle } from '../lib/subtitle-evidence.js';
import { titleKey } from '../lib/text.js';
import { createAnichin } from './anichin.js';
import { createAnimeku } from './animeku.js';
import { createAnimeIndo } from './animeindo.js';
import { createAnoboy } from './anoboy.js';
import { createAnimeOnsen } from './animeonsen.js';
import { createAnimexin } from './animexin.js';
import { createHianime } from './hianime.js';
import { createKuramanime } from './kuramanime.js';
import { createKusonimeDownloader } from './kusonime.js';
import { createMetadata, hasCjk } from './metadata.js';
import { createOploverz } from './oploverz.js';
import { createOtakudesu } from './otakudesu.js';
import { createSamehadaku } from './samehadaku.js';
import { createSakunime } from './sakunime.js';

/**
 * Pemeriksaan Sub Indo per episode (24 Okt 2026, putaran 3).
 * Halaman episode disentuh satu per satu, jadi jumlahnya dibatasi dan dijalankan bertahap.
 */
const SUBTITLES = Object.freeze({
    maxEpisodes: 24,
    concurrency: 3,
    ttlMs: CACHE.subtitleMapTtlMs,
});

/** Jalankan `run` untuk setiap item dengan batas konkurensi (tanpa dependensi). */
async function forEachLimit(items, limit, run) {
    const list = Array.from(items || []);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), list.length) }, async () => {
        while (cursor < list.length) {
            const index = cursor;
            cursor += 1;
            await run(list[index]);
        }
    });
    await Promise.all(workers);
}

/** id sumber → factory adapter. */
export const FACTORIES = Object.freeze({
    animexin: createAnimexin,
    animeindo: createAnimeIndo,
    animeku: createAnimeku,
    oploverz: createOploverz,
    samehadaku: createSamehadaku,
    animeonsen: createAnimeOnsen,
    anoboy: createAnoboy,
    sakunime: createSakunime,
    anichin: createAnichin,
    otakudesu: createOtakudesu,
    hianime: createHianime,
    kuramanime: createKuramanime,
});

/** Prefix slug untuk anime dari API metadata (kitsu~123, mal~456, anilist~789). */
const METADATA_KINDS = new Set(['kitsu', 'mal', 'anilist']);
const NOT_FOUND = Symbol('notFound');
// Latest feed dari sumber anime Jepang Sub Indo. URUTAN = urutan panel di beranda.
// AnimeKu & Oploverz diletakkan lebih dulu (23 Okt 2026) supaya panel yang paling sering
// bisa diakses tetap tampil walau Samehadaku/Sakunime/Otakudesu/Kuramanime sedang gagal.
// AnimeIndo masih lookup-only; Anoboy belum punya rute latest terverifikasi;
// Anichin/AnimeXin tampil pada section Donghua yang terpisah.
// 23 Okt 2026: hanya AnimeKu & Oploverz yang tampil di panel beranda (pilihan pengguna).
// Samehadaku/Sakunime/Otakudesu/Kuramanime tetap aktif sebagai adapter untuk pencarian
// halaman nonton, tetapi tidak lagi menjadi panel Sub Indo.
const SUB_INDO_LATEST_SOURCE_ORDER = ['animeku', 'oploverz'];
const SUB_INDO_LATEST_SOURCE_IDS = new Set(SUB_INDO_LATEST_SOURCE_ORDER);
const SUB_INDO_LATEST_LIMIT = 24;

/**
 * Gabungkan beberapa daftar secara selang-seling + buang judul ganda.
 * @param {any[][]} groups
 * @param {number} [limit]
 * @param {{perSource?: boolean}} [opts] perSource = judul sama dari sumber BERBEDA tetap dipertahankan
 */
export function mergeLists(groups, limit = 60, { perSource = false } = {}) {
    const out = [];
    const seen = new Set();
    const max = Math.max(0, ...groups.map((g) => g.length));
    for (let i = 0; i < max && out.length < limit; i++) {
        for (const g of groups) {
            const it = g[i];
            if (!it) continue;
            const base = titleKey(it.title) || it.slug;
            const k = base && perSource ? `${it.source}:${base}` : base;
            if (!k || seen.has(k)) continue;
            seen.add(k);
            out.push(it);
        }
    }
    return out.slice(0, limit);
}

/**
 * @param {{
 *   adapters: any[],
 *   downloaders?: any[],
 *   metadata?: ReturnType<typeof createMetadata>|null,
 *   cache?: TtlCache,
 *   network?: ReturnType<typeof createNetwork>|null,
 *   ttl?: typeof CACHE,
 *   enrichImages?: boolean,
 *   enrichBudgetMs?: number,
 *   enrichConcurrency?: number,
 * }} deps
 */
/**
 * Opsi filter/genre/musim dari adapter (bentuk seragam untuk respons browse).
 * @returns {{filters: object[], genres: object[], seasons: object[]}}
 */
function browseOptionsOf(adapter) {
    const raw = typeof adapter.browseOptions === 'function' ? adapter.browseOptions() : {};
    return {
        filters: Array.isArray(raw.filters) ? raw.filters : [],
        genres: Array.isArray(raw.genres) ? raw.genres : [],
        seasons: Array.isArray(raw.seasons) ? raw.seasons : [],
    };
}

export function createRegistry({
    adapters,
    downloaders = [],
    metadata = null,
    cache = new TtlCache({ max: CACHE.maxEntries }),
    network = null,
    ttl = CACHE,
    enrichImages = METADATA.enrichImages,
    enrichBudgetMs = METADATA.enrichBudgetMs,
    enrichConcurrency = METADATA.enrichConcurrency,
} = {}) {
    const list = (adapters || []).filter(Boolean);
    const downloadList = (downloaders || []).filter(Boolean);
    const byId = new Map(list.map((a) => [a.id, a]));
    const downloadById = new Map(downloadList.map((a) => [a.id, a]));
    const usable = () => list.filter((a) => a.policy?.tos?.verdict !== 'forbidden');

    const wrap = (key, ttlMs, producer, opts = {}) => {
        const settings = { ttl: ttlMs, stale: ttl.staleMs, ...opts };
        return network?.requestManager?.cache && network.requestManager.cached
            ? network.requestManager.cached(key, settings, producer)
            : cache.wrap(key, settings, producer);
    };

    /** Seperti wrap, tapi "tidak ditemukan" juga di-cache (singkat) supaya slug salah tidak terus menembak sumber. */
    async function wrapFound(key, ttlMs, producer, opts = {}) {
        const r = await wrap(key, (v) => (v === NOT_FOUND || v?.[NOT_FOUND] ? ttl.notFoundTtlMs : ttlMs), async () => {
            try {
                return await producer();
            } catch (err) {
                if (err?.kind === 'not_found') return { [NOT_FOUND]: err.message, source: err.source };
                throw err;
            }
        }, opts);
        if (r.value?.[NOT_FOUND]) throw notFound(r.value[NOT_FOUND], r.value.source);
        return r;
    }

    function resolveAdapter(slug) {
        const ref = decodeSlug(slug);
        if (!ref) throw badRequest('Slug tidak valid.');
        if (METADATA_KINDS.has(ref.source)) {
            const id = Number.parseInt(ref.parts[0], 10);
            if (ref.parts.length !== 1 || !Number.isInteger(id) || id < 1) throw badRequest('Slug metadata tidak valid.');
            return { kind: 'metadata', metaKind: ref.source, id };
        }
        const adapter = byId.get(ref.source);
        if (!adapter) throw notFound(`Sumber "${ref.source}" tidak dikenal atau sedang dimatikan.`);
        const parsed = adapter.parseRef(ref.parts);
        if (!parsed) throw badRequest(`Slug tidak valid untuk sumber ${adapter.name}.`);
        return { kind: 'adapter', adapter, ref: parsed };
    }

    /**
     * Judul Mandarin/Jepang sebuah item (untuk poster Bangumi): dari item itu sendiri (detail), atau
     * dari halaman detail situs sumber yang di-cache (item daftar hanya punya judul Inggris/pinyin).
     */
    async function nativeTitleOf(it) {
        if (hasCjk(it.titleAlt)) return it.titleAlt;
        if (!it.slug) return null;
        const target = resolveAdapter(it.slug);
        if (target.kind !== 'adapter') return null;
        const r = await wrapFound(`detail:${it.slug}`, ttl.detailTtlMs, () => target.adapter.getAnime(target.ref, {}));
        return hasCjk(r.value?.titleAlt) ? r.value.titleAlt : null;
    }

    /**
     * Ganti gambar dari sumber yang dilindungi hotlink dengan poster metadata (maks enrichBudgetMs).
     * Mengembalikan salinan baru (cache sumber tidak diubah). Gambar yang belum ketemu → null
     * (frontend memakai placeholder); pencarian tetap jalan di belakang & mengisi cache.
     * Array hasil diberi properti `partial = true` bila batas waktu habis sebelum semua pencarian
     * selesai → route memakai cache CDN pendek supaya poster yang menyusul cepat terlihat.
     */
    async function withSafeImages(items) {
        const out = items.map((it) => ({ ...it }));
        const targets = out.filter((it) => byId.get(it.source)?.policy?.imagePolicy === 'blocked');
        if (!targets.length) return out;
        for (const it of targets) it.image = null;
        if (!enrichImages || !metadata?.lookupImage) return out;

        const results = new Map();
        let next = 0;
        const worker = async () => {
            while (next < targets.length) {
                const it = targets[next++];
                try {
                    results.set(it, await metadata.lookupImage(it.title, {}, { resolveNative: () => nativeTitleOf(it) }));
                } catch {
                    results.set(it, null);
                }
            }
        };
        const all = Promise.all(Array.from({ length: Math.min(enrichConcurrency, targets.length) }, worker));
        let timer;
        await Promise.race([all, new Promise((r) => { timer = setTimeout(r, enrichBudgetMs); })]);
        clearTimeout(timer);
        for (const it of targets) {
            const hit = results.get(it);
            if (hit?.image) it.image = hit.image;
            if (hit?.banner && !it.banner) it.banner = hit.banner;
        }
        if (results.size < targets.length) Object.defineProperty(out, 'partial', { value: true });
        return out;
    }

    /** Jalankan fungsi di semua scraper aktif secara paralel. */
    async function fanOut(keyOf, ttlMs, run, candidates = usable()) {
        const active = candidates;
        const settled = await Promise.allSettled(active.map((a) => wrap(keyOf(a), ttlMs, () => run(a))));
        const groups = [];
        const used = [];
        const errors = [];
        const raw = [];
        let stale = false;
        settled.forEach((r, i) => {
            if (r.status === 'fulfilled') {
                groups.push(r.value.value);
                used.push(active[i].id);
                if (r.value.cache === 'stale') {
                    stale = true;
                    errors.push(describeError(r.value.error));
                }
            } else {
                if (isAbort(r.reason)) throw r.reason;
                raw.push(r.reason);
                errors.push(describeError(r.reason));
            }
        });
        return { groups, used, errors, raw, stale, active };
    }

    return {
        adapters: list,
        downloaders: downloadList,
        cache,
        network,

        /** Lookup-only download provider; never participates in catalog/latest fan-out. */
        async kusonimeDownloads(titles, ctx = {}) {
            const provider = downloadById.get('kusonime-downloads');
            const data = { query: '', matchedTitle: '', downloads: [] };
            if (!provider || provider.policy?.tos?.verdict === 'forbidden') {
                return { source: 'kusonime', data, fallback: false, stale: false, errors: [], disabled: true };
            }
            const candidates = [...new Set((Array.isArray(titles) ? titles : [titles])
                .map((value) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100))
                .filter((value) => value.length >= 2 && /\p{Script=Latin}/u.test(value)
                    && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value) && titleKey(value)))].slice(0, 4);
            if (!candidates.length) return { source: 'kusonime', data, fallback: false, stale: false, errors: [] };
            const cacheKey = candidates.map(titleKey).join('|');
            const r = await wrap(`downloads:kusonime:${cacheKey}`, ttl.searchTtlMs, () => provider.findDownloads(candidates, ctx), { stale: 0 });
            return {
                source: 'kusonime',
                data: r.value,
                fallback: false,
                stale: r.cache === 'stale',
                errors: r.error ? [describeError(r.error)] : [],
            };
        },

        async latest(ctx = {}) {
            const candidates = usable().filter((a) => a.supportsLatest !== false && typeof a.latest === 'function');
            const r = await fanOut((a) => `latest:${a.id}`, ttl.latestTtlMs, (a) => a.latest(ctx), candidates);
            const items = mergeLists(r.groups);
            if (items.length) {
                const data = await withSafeImages(items);
                return { source: r.used.join(','), data, fallback: false, stale: r.stale, partial: Boolean(data.partial), errors: r.errors };
            }
            if (metadata) {
                try {
                    const m = await wrap('latest:metadata', ttl.latestTtlMs, () => metadata.latestDonghua(ctx));
                    return { source: 'metadata', provider: m.value.provider, data: m.value.items, fallback: true, stale: m.cache === 'stale', errors: r.errors };
                } catch (err) {
                    if (isAbort(err)) throw err;
                    r.raw.push(err);
                }
            }
            if (!r.active.length && !metadata) throw new AppError('Tidak ada sumber yang aktif.', { status: 503, code: 'NO_SOURCES' });
            throw combineErrors(r.raw, 'Daftar terbaru tidak tersedia: semua sumber sedang bermasalah.');
        },

        /**
         * Feed Sub Indo untuk homepage, dikelompokkan per situs dan tidak digabung lintas sumber.
         * Tidak memakai fallback metadata: tanpa bukti bahasa dari sumber, judul tidak boleh diklaim Sub Indo.
         */
        async latestSubIndo(ctx = {}) {
            const candidates = usable()
                .filter((a) => SUB_INDO_LATEST_SOURCE_IDS.has(a.id)
                    && a.supportsLatest !== false && typeof a.latest === 'function')
                .sort((a, b) => SUB_INDO_LATEST_SOURCE_ORDER.indexOf(a.id) - SUB_INDO_LATEST_SOURCE_ORDER.indexOf(b.id));
            if (!candidates.length) {
                throw new AppError('Tidak ada sumber latest Sub Indo yang aktif.', { status: 503, code: 'NO_SUBINDO_SOURCES' });
            }

            const settled = await Promise.allSettled(candidates.map((a) => wrap(
                `latest:${a.id}`,
                ttl.latestTtlMs,
                () => a.latest(ctx),
            )));
            const sources = [];
            const errors = [];
            let stale = false;

            settled.forEach((result, i) => {
                const adapter = candidates[i];
                if (result.status === 'rejected') {
                    if (isAbort(result.reason)) throw result.reason;
                    const error = describeError(result.reason);
                    errors.push(error);
                    // homeUrl: tautan manual ke situs aslinya (bukan upaya menembus pembatasan).
                    sources.push({ id: adapter.id, name: adapter.name, homeUrl: adapter.baseUrl || '', items: [], stale: false, error });
                    return;
                }

                const value = result.value.value;
                const seen = new Set();
                const items = (Array.isArray(value) ? value : [])
                    .filter((item) => item && item.title)
                    .map((item) => ({ ...item, source: adapter.id }))
                    .filter((item) => {
                        const key = titleKey(item.title) || item.slug;
                        if (!key || seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    })
                    .slice(0, SUB_INDO_LATEST_LIMIT);
                const isStale = result.value.cache === 'stale';
                const error = result.value.error ? describeError(result.value.error) : null;
                if (isStale) stale = true;
                if (error) errors.push(error);
                sources.push({
                    id: adapter.id,
                    name: adapter.name,
                    homeUrl: adapter.baseUrl || '',
                    items,
                    stale: isStale,
                    browse: adapter.supportsBrowse === true && typeof adapter.browse === 'function',
                    ...(error ? { error } : {}),
                });
            });

            const flat = await withSafeImages(sources.flatMap((source) => source.items));
            let offset = 0;
            for (const source of sources) {
                source.items = flat.slice(offset, offset + source.items.length);
                offset += source.items.length;
            }
            return {
                source: candidates.map((a) => a.id).join(','),
                data: sources,
                fallback: false,
                stale,
                partial: stale || errors.length > 0 || Boolean(flat.partial),
                errors,
            };
        },

        /**
         * Katalog satu sumber (halaman "Jelajah"): AnimeKu/Oploverz menyediakan daftar
         * berurutan + paginasi. Bukan klaim Sub Indo — kartu katalog tidak diverifikasi
         * per episode (aturan bukti tetap berlaku di `latestSubIndo`).
         * @param {{source: string, filter?: string, genre?: string, page?: number}} opts
         */
        async browse({ source, filter = '', genre = '', page = 1, q = '', year = '', season = '' } = {}, ctx = {}) {
            const adapter = byId.get(String(source || '').toLowerCase());
            if (!adapter) throw notFound(`Sumber "${source}" tidak dikenal atau sedang dimatikan.`);
            if (adapter.policy?.tos?.verdict === 'forbidden') throw notFound(`Sumber "${source}" tidak diizinkan.`);
            const query = String(q || '').trim();
            if (query) {
                // Pencarian di dalam satu sumber (24 Okt 2026). Hasil satu halaman, tanpa paginasi.
                if (typeof adapter.search !== 'function' || adapter.supportsSearch === false) {
                    throw badRequest(`Sumber ${adapter.name} tidak menyediakan pencarian.`);
                }
                const searchKey = `browse-search:${adapter.id}:${query.toLowerCase()}`;
                const found = await wrap(searchKey, ttl.searchTtlMs, () => adapter.search(query, ctx));
                const items = (Array.isArray(found.value) ? found.value : []).slice(0, 60);
                const options = browseOptionsOf(adapter);
                return {
                    source: adapter.id,
                    data: {
                        items,
                        page: 1,
                        hasNext: false,
                        filters: options.filters,
                        genres: options.genres,
                        seasons: options.seasons,
                        filter,
                        genre,
                        query,
                    },
                    fallback: false,
                    stale: found.cache === 'stale',
                    errors: found.error ? [describeError(found.error)] : [],
                };
            }
            if (filter === 'donghua' && typeof adapter.browseDonghua === 'function') {
                // Donghua per sumber (24 Okt 2026): daftar judul donghua tayang dari metadata
                // lalu dicari di situs sumber. Dipakai AnimeKu yang tidak punya kategori donghua.
                if (!metadata) throw badRequest(`Donghua ${adapter.name} membutuhkan metadata untuk mencocokkan judul.`);
                const feed = await wrap('donghua:titles', ttl.latestTtlMs, () => metadata.latestDonghua(ctx));
                const titles = (feed.value?.items || []).map((item) => item.title).filter(Boolean).slice(0, 8);
                const found = await wrap(`browse:donghua:${adapter.id}`, ttl.searchTtlMs, () => adapter.browseDonghua(titles, ctx));
                const options = browseOptionsOf(adapter);
                return {
                    source: adapter.id,
                    data: {
                        items: Array.isArray(found.value) ? found.value : [],
                        page: 1,
                        hasNext: false,
                        filters: options.filters,
                        genres: options.genres,
                        seasons: options.seasons,
                        filter: 'donghua',
                        genre: '',
                        query: '',
                    },
                    fallback: false,
                    stale: found.cache === 'stale' || feed.cache === 'stale',
                    errors: found.error ? [describeError(found.error)] : [],
                };
            }
            if (adapter.supportsBrowse !== true || typeof adapter.browse !== 'function') {
                throw badRequest(`Sumber ${adapter.name} tidak menyediakan halaman daftar.`);
            }
            const safePage = Math.max(1, Math.min(500, Number.parseInt(page, 10) || 1));
            const safeYear = /^\d{4}$/.test(String(year || '')) ? String(year) : '';
            const safeSeason = /^(winter|spring|summer|fall)$/.test(String(season || '').toLowerCase())
                ? String(season).toLowerCase()
                : '';
            const key = `browse:${adapter.id}:${filter}:${genre}:${safeYear}:${safeSeason}:${safePage}`;
            const r = await wrap(key, ttl.searchTtlMs, () => adapter.browse({
                filter, genre, page: safePage, year: safeYear, season: safeSeason,
            }, ctx));
            return {
                source: adapter.id,
                data: r.value,
                fallback: false,
                stale: r.cache === 'stale',
                errors: r.error ? [describeError(r.error)] : [],
            };
        },

        /**
         * Katalog genre & musim per sumber (24 Okt 2026) untuk panel "Jelajahi Genre" di beranda.
         * Hanya sumber yang menyediakan `genres()`; kegagalan satu sumber tidak menggagalkan yang lain.
         * @returns {Promise<{source: string, data: {sources: object[]}, fallback: boolean, stale: boolean, errors: object[]}>}
         */
        async genres(ctx = {}) {
            const active = usable().filter((a) => a.supportsBrowse === true && typeof a.genres === 'function');
            if (!active.length) throw new AppError('Tidak ada sumber yang menyediakan daftar genre.', { status: 503, code: 'NO_SOURCES' });
            const settled = await Promise.allSettled(active.map((a) => wrap(
                `genres:${a.id}`,
                ttl.searchTtlMs,
                () => a.genres(ctx),
            )));
            const sources = [];
            const errors = [];
            let stale = false;
            settled.forEach((result, i) => {
                const adapter = active[i];
                if (result.status === 'rejected') {
                    if (isAbort(result.reason)) throw result.reason;
                    errors.push(describeError(result.reason));
                    return;
                }
                if (result.value.cache === 'stale') stale = true;
                if (result.value.error) errors.push(describeError(result.value.error));
                const value = result.value.value || {};
                sources.push({
                    id: adapter.id,
                    name: adapter.name,
                    genres: Array.isArray(value.genres) ? value.genres : [],
                    seasons: Array.isArray(value.seasons) ? value.seasons : [],
                });
            });
            if (!sources.length) throw combineErrors(errors, 'Daftar genre tidak tersedia: semua sumber sedang bermasalah.');
            return { source: sources.map((item) => item.id).join(','), data: { sources }, fallback: false, stale, errors };
        },

        async search(q, ctx = {}) {
            const key = q.toLowerCase();
            const candidates = usable().filter((a) => a.supportsSearch !== false && typeof a.search === 'function');
            const r = await fanOut((a) => `search:${a.id}:${key}`, ttl.searchTtlMs, (a) => a.search(q, ctx), candidates);
            if (r.used.length) {
                return { source: r.used.join(','), data: mergeLists(r.groups, 60, { perSource: true }), fallback: false, stale: r.stale, errors: r.errors };
            }
            if (metadata) {
                try {
                    const m = await wrap(`search:metadata:${key}`, ttl.searchTtlMs, () => metadata.search(q, ctx));
                    return { source: 'metadata', provider: m.value.provider, data: m.value.items, fallback: true, stale: m.cache === 'stale', errors: r.errors };
                } catch (err) {
                    if (isAbort(err)) throw err;
                    r.raw.push(err);
                }
            }
            if (!r.active.length && !metadata) throw new AppError('Tidak ada sumber yang aktif.', { status: 503, code: 'NO_SOURCES' });
            throw combineErrors(r.raw, 'Pencarian gagal: semua sumber sedang bermasalah.');
        },

        async detail(slug, ctx = {}) {
            const target = resolveAdapter(slug);
            if (target.kind === 'metadata') {
                if (!metadata) throw notFound('Fallback metadata dimatikan.');
                const m = await wrapFound(`detail:${slug}`, ttl.detailTtlMs, async () => {
                    const a = await metadata.getById(target.metaKind, target.id, ctx);
                    if (!a) throw notFound('Anime tidak ditemukan di API metadata.', target.metaKind);
                    return a;
                });
                return { source: 'metadata', data: m.value, fallback: false, stale: m.cache === 'stale', errors: [] };
            }
            const { adapter, ref } = target;
            try {
                const r = await wrapFound(`detail:${slug}`, ttl.detailTtlMs, () => adapter.getAnime(ref, ctx));
                const [data] = await withSafeImages([r.value]);
                return { source: adapter.id, data, fallback: false, stale: r.cache === 'stale', errors: r.error ? [describeError(r.error)] : [] };
            } catch (err) {
                if (isAbort(err) || err?.code === 'BAD_REQUEST') throw err;
                if (metadata) {
                    try {
                        const hint = adapter.titleHint(ref);
                        const m = await wrap(`find:${titleKey(hint)}`, ttl.detailTtlMs, () => metadata.findByTitle(hint, ctx));
                        if (m.value) {
                            return { source: 'metadata', data: { ...m.value, slug }, fallback: true, stale: false, errors: [describeError(err)] };
                        }
                    } catch (e2) {
                        if (isAbort(e2)) throw e2;
                    }
                }
                throw err;
            }
        },

        /**
         * Jadwal rilis mingguan dari adapter yang punya schedule(): { timezone, days: { 0..6: item[] } }.
         * Per hari: item berjam (urut jam) dulu, lalu item tanpa jam (donghua AnimeXin).
         */
        async schedule(ctx = {}) {
            const active = usable().filter((a) => typeof a.schedule === 'function');
            if (!active.length) throw new AppError('Tidak ada sumber jadwal yang aktif.', { status: 503, code: 'NO_SOURCES' });
            const settled = await Promise.allSettled(active.map((a) => wrap(`schedule:${a.id}`, ttl.scheduleTtlMs, () => a.schedule(ctx))));
            const days = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, []]));
            const used = [];
            const errors = [];
            const raw = [];
            let stale = false;
            settled.forEach((r, i) => {
                if (r.status !== 'fulfilled') {
                    if (isAbort(r.reason)) throw r.reason;
                    raw.push(r.reason);
                    errors.push(describeError(r.reason));
                    return;
                }
                used.push(active[i].id);
                if (r.value.cache === 'stale') {
                    stale = true;
                    errors.push(describeError(r.value.error));
                }
                for (const [day, items] of Object.entries(r.value.value || {})) {
                    if (days[day]) days[day].push(...items);
                }
            });
            if (!used.length) throw combineErrors(raw, 'Jadwal rilis tidak tersedia: semua sumber sedang bermasalah.');
            for (const d of Object.keys(days)) {
                const seen = new Set();
                days[d] = days[d]
                    .filter((it) => it?.title && !seen.has(titleKey(it.title)) && seen.add(titleKey(it.title)))
                    .sort((a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || String(a.time || '').localeCompare(String(b.time || '')));
            }
            return { source: used.join(','), data: { timezone: 'Asia/Jakarta', days }, fallback: false, stale, errors };
        },

        async episode(slug, ep, ctx = {}) {
            if (!Number.isInteger(ep) || ep < 1 || ep > 5000) throw badRequest('Nomor episode tidak valid.');
            const target = resolveAdapter(slug);
            if (target.kind === 'metadata') throw notFound('API metadata tidak menyediakan server streaming / link download.');
            const { adapter, ref } = target;
            const detailKey = `detail:${slug}`;
            const episodeKey = `episode:${slug}:${ep}`;
            let d = await wrapFound(detailKey, ttl.detailTtlMs, () => adapter.getAnime(ref, ctx));
            const run = (anime) => wrapFound(episodeKey, ttl.episodeTtlMs, () => adapter.getEpisode(ref, ep, { ...ctx, anime }));
            let r;
            try {
                r = await run(d.value);
            } catch (err) {
                // Episode baru rilis setelah daftar episode di-cache → muat ulang detail SEKALI (maks tiap 60 dtk).
                const outdated = err?.kind === 'not_found' && d.cache !== 'miss' && d.age > 60000 && !(d.value.latestEpisode >= ep);
                if (!outdated) throw err;
                cache.delete(episodeKey);
                d = await wrapFound(detailKey, ttl.detailTtlMs, () => adapter.getAnime(ref, ctx), { force: true });
                if (!(d.value.latestEpisode >= ep)) throw err;
                r = await run(d.value);
            }
            return { source: adapter.id, data: r.value, fallback: false, stale: r.cache === 'stale', errors: r.error ? [describeError(r.error)] : [] };
        },

        /**
         * Peta Sub Indo per episode untuk daftar episode di watch.html — 24 Okt 2026 (putaran 3).
         *
         * Latar belakang: badge Sub Indo dulu hanya muncul untuk episode yang kebetulan sedang
         * dibuka, sehingga pengguna melihat "hanya episode tertentu yang Sub Indo". Di sini
         * SETIAP episode pada rentang yang diminta diperiksa:
         *   1. baris daftar episode yang sudah membawa bukti bahasa dipakai apa adanya
         *      (Oploverz menulis "… Episode N Subtitle Indonesia" di daftar episodenya);
         *   2. episode lain dibuka halaman episodenya (AnimeKu) — maks 3 permintaan bersamaan,
         *      jadi satu panggilan memeriksa maks 24 episode.
         * Episode yang gagal diperiksa dibiarkan `sub: null` (tanpa badge) — tidak pernah
         * diklaim Sub Indo tanpa bukti, dan kegagalan satu episode tidak menggagalkan yang lain.
         *
         * @param {string} slug slug backend ("animeku~…")
         * @param {{from?: number, to?: number}} [range]
         * @returns {Promise<{source: string, data: {slug: string, from: number, to: number, episodes: {number: number, sub: 'id'|''|null, evidence: string}[]}, fallback: boolean, stale: boolean, errors: object[]}>}
         */
        async episodeSubtitles(slug, { from = 1, to = 1 } = {}, ctx = {}) {
            const start = Math.max(1, Math.trunc(Number(from) || 1));
            const requested = Math.trunc(Number(to) || start);
            const last = Math.min(Math.max(start, requested), start + SUBTITLES.maxEpisodes - 1);
            const target = resolveAdapter(slug);
            if (target.kind === 'metadata') throw notFound('API metadata tidak menyediakan daftar episode.');
            const { adapter } = target;
            const key = `subs:${adapter.id}:${slug}:${start}-${last}`;
            const r = await wrap(key, SUBTITLES.ttlMs, async () => {
                const episodes = [];
                for (let n = start; n <= last; n++) episodes.push({ number: n, sub: null, evidence: '' });
                const byNumber = new Map(episodes.map((item) => [item.number, item]));

                // 1) Bukti dari daftar episode (tanpa permintaan tambahan).
                let rows = [];
                try {
                    rows = (await this.detail(slug, ctx))?.data?.episodeList || [];
                } catch (err) {
                    if (isAbort(err)) throw err;
                    // Daftar episode gagal dimuat → semua diperiksa lewat halaman episode.
                }
                for (const row of Array.isArray(rows) ? rows : []) {
                    const item = byNumber.get(row?.number);
                    if (!item || !(row.sub === 'id' || row.sub === '')) continue;
                    item.sub = row.sub;
                    item.evidence = row.sub === 'id' ? 'episode-list' : '';
                }

                // Episode di luar daftar (mis. belum tayang) tidak perlu diperiksa: badge hanya
                // untuk episode yang benar-benar ada di situs.
                const known = (Array.isArray(rows) ? rows : [])
                    .map((row) => Number(row?.number))
                    .filter((n) => Number.isInteger(n) && n > 0);
                const highest = known.length ? Math.max(...known) : null;
                const reachable = highest
                    ? episodes.filter((item) => item.number <= highest)
                    : episodes;

                // 2) Sisanya: buka halaman episode masing-masing (dibatasi).
                const missing = reachable.filter((item) => item.sub === null).map((item) => item.number);
                await forEachLimit(missing, SUBTITLES.concurrency, async (n) => {
                    try {
                        const result = await this.episode(slug, n, ctx);
                        const data = result?.data || {};
                        const indo = (Array.isArray(data.servers) ? data.servers : []).some((server) => server?.lang === 'id');
                        const item = byNumber.get(n);
                        if (!item) return;
                        item.sub = indo ? 'id' : (textShowsIndonesianSubtitle(data.title) ? 'id' : '');
                        item.evidence = indo ? 'episode-server' : (item.sub === 'id' ? 'episode-title' : '');
                    } catch (err) {
                        if (isAbort(err)) throw err;
                        // Episode belum tayang / halaman gagal dibuka → tetap null (tanpa badge).
                    }
                });

                return { slug, source: adapter.id, from: start, to: last, episodes: reachable };
            }, { stale: 0 });
            return {
                source: adapter.id,
                data: r.value,
                fallback: false,
                stale: false,
                errors: r.error ? [describeError(r.error)] : [],
            };
        },

        /** Ringkasan untuk /api/health & skrip check-sources. */
        health() {
            const robots = network?.robots.snapshot() || {};
            const circuits = network?.circuit.snapshot() || {};
            return {
                // Mode gerbang robots.txt aktif (enforce/warn/off) — transparan untuk operator.
                robotsMode: network?.robotsMode || 'enforce',
                sources: [...list, ...downloadList].map((a) => {
                    const origin = new URL(a.baseUrl).origin;
                    return {
                        id: a.id,
                        name: a.name,
                        baseUrl: origin,
                        tos: a.policy?.tos?.verdict || 'unknown',
                        robots: robots[origin]?.state || 'unchecked',
                        circuit: circuits[a.id]?.state || 'closed',
                        retryAfter: circuits[a.id]?.retryAfter || 0,
                        reason: circuits[a.id]?.reason || '',
                    };
                }),
                metadata: metadata
                    ? { enabled: true, order: metadata.order, circuits: Object.fromEntries(metadata.order.map((p) => [p, circuits[p]?.state || 'closed'])) }
                    : { enabled: false },
                cache: { entries: cache.size, ...cache.stats },
                runtime: {
                    requests: network?.requestManager?.snapshot?.() || null,
                    proxies: network?.proxyManager?.snapshot?.() || null,
                    cookies: network?.cookieManager?.snapshot?.() || null,
                    browser: network?.browserAutomation?.snapshot?.() || null,
                },
            };
        },
    };
}

/** Registry produksi: adapter dari SOURCES.enabled + metadata, berbagi throttle/robots/circuit/cache. */
export function createDefaultRegistry() {
    const cache = new TtlCache({ max: CACHE.maxEntries });
    const network = createNetwork({ cache });
    const adapters = SOURCES.enabled
        .map((id) => {
            const factory = FACTORIES[id];
            if (!factory) {
                console.warn(`[sources] adapter "${id}" tidak dikenal — dilewati.`);
                return null;
            }
            return factory({ network, createClient, baseUrl: SOURCES[id]?.baseUrl, sourceConfig: SOURCES[id] });
        })
        .filter(Boolean);
    const metadata = METADATA.enabled ? createMetadata({ network, createClient, cache }) : null;
    const downloaders = SOURCES.kusonimeDownloads.enabled
        ? [createKusonimeDownloader({ network, createClient, baseUrl: SOURCES.kusonimeDownloads.baseUrl })]
        : [];
    return createRegistry({ adapters, downloaders, metadata, cache, network });
}

export { SourceError };
