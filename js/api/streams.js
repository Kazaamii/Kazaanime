/**
 * Kazanime — api/streams.js
 * Sumber video & link download untuk SATU episode.
 *
 *  - Server scraping : backend (server/sources/ — AnimeXin, Samehadaku) lewat
 *                      GET /api/anime/:slug/episode/:ep → server embed + link download
 *                      dari situs sumber. Anime yang dibuka dari AniList/MAL/Kitsu (tanpa slug)
 *                      dicarikan padanannya di backend lewat judul (findBackendMatch).
 *                      Urutan putar (scraping dulu / statis dulu) diatur PLAYER.serverOrder.
 *  - Server statis   : config.STREAMING_SERVERS (MegaPlay, Vidnest, TryEmbed), URL embed dibangun dari
 *                      id anime (AniList / MAL / Kitsu). Tanpa request jaringan — cadangan otomatis.
 *  - Slot penyedia   : (22 Okt 2026) entri STREAMING_SERVERS ber-`provider` (ReAnime, AniZone) diisi
 *                      dari GET /api/stream/servers lewat withProviderServers(); posisinya tetap.
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
 * @property {string[]} origins      origin yang boleh mengirim postMessage untuk server ini
 * @property {'embed'|'hls'} [kind]  'hls' = player video bawaan (AniZone), selain itu iframe
 * @property {string[]|null} [mirrors] URL cadangan penyedia yang sama (dicoba berurutan sebelum pindah server)
 * @property {string} [direct]       (hls) URL CDN untuk HLS native Safari/iOS
 * @property {{label:string, lang:string, url:string, default:boolean}[]} [subtitles] (hls) track WebVTT
 * @property {string} [provider]     slot penyedia ('reanime' | 'anizone')
 * @property {boolean} [pending]     slot penyedia yang hasilnya belum datang
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
        if (s.provider) {
            // Slot penyedia: diisi withProviderServers() setelah backend menjawab.
            return {
                id: s.id, provider: s.provider, name: s.name, flag: '', description: s.description || '', badge: '',
                url: null, available: false, pending: true, reason: 'Server ini sedang dicari…',
                source: 'static', lang: s.lang || '', origins: [...(s.origins || [])], kind: 'embed', mirrors: null,
            };
        }
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

/**
 * Isi slot penyedia (ReAnime, AniZone) dengan hasil GET /api/stream/servers.
 * @param {StreamServer[]} list hasil listStreamServers()
 * @param {{servers: object[], status: Record<string,string>, error?: unknown}|null} result
 *   null = masih menunggu (slot tetap "mencari…")
 * @returns {StreamServer[]}
 */
export function withProviderServers(list, result) {
    if (!result) return list;
    return list.map((s) => {
        if (!s.provider) return s;
        const hit = (result.servers || []).find((x) => x.provider === s.provider);
        if (!hit) {
            const st = result.status?.[s.provider];
            const reason = st === 'not_found'
                ? 'Anime/episode ini belum tersedia di server ini'
                : result.error?.kind === 'disabled' ? 'Server ini membutuhkan backend (npm run dev / Vercel)' : 'Server ini sedang tidak bisa dipakai';
            return { ...s, pending: false, available: false, reason };
        }
        return {
            ...s,
            ...hit,
            id: s.id,
            name: s.name,
            description: s.description,
            source: 'static',
            pending: false,
            available: true,
            reason: '',
            lang: hit.lang || s.lang,
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
export async function findBackendMatches(anime, { titles: extra, signal } = {}) {
    const titles = titleList(extra?.length ? extra : anime);
    if (!titles.length) return [];
    // Kata kunci: judul lengkap dulu, lalu judul tanpa penanda season (pencarian WordPress = semua kata
    // wajib ada). Pencocokan tetap memakai judul LENGKAP, jadi season lain tidak ikut tercocokkan.
    const queries = uniqueTitles([...titles, ...titles.map(stripSeasonSuffix)]).slice(0, MAX_SEARCH_TITLES);
    const settled = await Promise.allSettled(queries.map((q) => backend.searchBackend(q, { signal })));
    const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!ok.length) throw settled[0].reason;
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
    return out;
}

const LANG_RANK = { id: 0, multi: 1, en: 2 };

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
 * @returns {Promise<{servers: StreamServer[], downloads: DownloadGroup[], source: string|null, slug?: string|null, matchedTitle?: string, disabled?: boolean, error?: ApiError}>}
 */
export async function getEpisodeExtras(anime, ep, { slug, titles, signal } = {}) {
    // (22 Okt 2026) Tanpa slug: SEMUA situs sumber yang punya anime ini dipakai bersamaan.
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
        let targets;
        let matchedTitle = '';
        if (own) {
            targets = [own];
        } else {
            const matches = await findBackendMatches(anime, { titles, signal });
            if (!matches.length) return empty('Anime ini belum ada di sumber scraping (Samehadaku / Otakudesu / AnimeXin / Anichin / hianime.ro).');
            targets = matches.map((m) => m.slug);
            matchedTitle = matches[0].title;
        }
        const settled = await Promise.allSettled(targets.map((t) => backend.getBackendEpisode(t, ep, { signal })));
        const ok = settled.map((r, i) => (r.status === 'fulfilled' ? { ...r.value, slug: targets[i] } : null)).filter(Boolean);
        if (!ok.length) {
            const errs = settled.map((r) => r.reason);
            if (errs.some((e) => e?.kind === 'abort')) throw errs.find((e) => e?.kind === 'abort');
            // 404 dari API Kazanime (body JSON) = episode belum ada di situs sumber → bukan gangguan
            if (errs.every((e) => e?.kind === 'http' && e.status === 404 && e.payload)) {
                return { ...empty(errs[0].message || `Episode ${ep} belum ada di sumber scraping.`), slug: targets[0], matchedTitle };
            }
            throw errs.find((e) => !(e?.kind === 'http' && e.status === 404)) || errs[0];
        }
        // Server: Sub Indo → Multi → Inggris (stabil: urutan situs & urutan asli dipertahankan), tanpa URL ganda.
        const seenUrl = new Set();
        const servers = ok.flatMap((m) => m.servers)
            .filter((x) => x.url && !seenUrl.has(x.url) && seenUrl.add(x.url))
            .map((x, i) => ({ x, i }))
            .sort((a, b) => ((LANG_RANK[a.x.lang] ?? 3) - (LANG_RANK[b.x.lang] ?? 3)) || (a.i - b.i))
            .map(({ x }) => x);
        const downloads = ok.flatMap((m) => m.downloads)
            .map((d, i) => ({ d, i }))
            .sort((a, b) => ((a.d.subtitle === 'Sub Indo' ? 0 : 1) - (b.d.subtitle === 'Sub Indo' ? 0 : 1)) || (a.i - b.i))
            .map(({ d }) => d);
        return { servers, downloads, source: ok.map((m) => m.source).join(', '), sources: ok.map((m) => m.source), slug: ok[0].slug, matchedTitle };
    } catch (err) {
        if (err?.kind === 'disabled') return disabled;
        throw err;
    }
}
