/**
 * Kazanime — routes.js
 * Pembuat & pembaca URL antar halaman. Semua link ke watch/search WAJIB
 * dibuat lewat fungsi di sini supaya format query string konsisten.
 *
 *   watch.html?title=...&ep=1&mal=...&anilist=...[&kitsu=...][&slug=...&src=...][&alt=...]
 *     alt = judul alternatif latin (romaji) → dipakai mencari anime yang sama di situs sumber scraping
 *     ep=latest = buka episode terbaru setelah detail dimuat (tautan dari Jadwal Rilis)
 *   search.html?q=...[&sort=score][&format=TV,MOVIE][&source=mal]   → mode pencarian
 *   search.html?browse=ongoing                                     → "Lihat Semua" (ongoing|popular|new|donghua)
 *   search.html?genre=Action                                       → "Lihat Semua" untuk genre
 */
import { GENRES, PLAYER } from './config.js';

export const PAGES = Object.freeze({
    home: 'index.html',
    watch: 'watch.html',
    search: 'search.html',
});

export const BROWSE_KINDS = Object.freeze(['ongoing', 'popular', 'new', 'donghua']);
export const SEARCH_SORTS = Object.freeze(['relevance', 'score', 'popularity', 'newest']);
export const SEARCH_FORMATS = Object.freeze(['TV', 'MOVIE', 'OVA', 'ONA']);
export const SEARCH_SOURCES = Object.freeze(['all', 'mal', 'kitsu', 'anilist']);

const toPositiveInt = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/** Nomor episode yang valid (1 … PLAYER.maxEpisode), selain itu null. */
export function toEpisodeNumber(v) {
    const n = toPositiveInt(v);
    return n && n <= PLAYER.maxEpisode ? n : null;
}

/** Judul alternatif yang berguna untuk pencarian di situs sumber: huruf latin, beda dari judul utama. */
function altTitleOf(anime) {
    const alt = String(anime.titleAlt || '').replace(/\s+/g, ' ').trim();
    if (!alt || alt.toLowerCase() === String(anime.title || '').trim().toLowerCase()) return '';
    if (!/[a-z]/i.test(alt) || /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(alt)) return '';
    return alt.slice(0, 150);
}

/** Episode tujuan kartu "Baru Rilis": episode terbaru yang sudah tayang (selain itu episode 1). */
export const latestEpisodeOf = (anime) => anime.latestEpisode || 1;

/**
 * URL halaman nonton.
 * @param {import('./api/normalize.js').Anime} anime
 * @param {number|'latest'} [ep=1]  'latest' = episode terbaru (ditentukan watch.html setelah detail dimuat)
 * @param {{src?: string|null, slug?: string|null}} [keep] pertahankan asal backend (slug + situs) dari URL sebelumnya
 */
export function watchUrl(anime, ep = 1, keep = {}) {
    const p = new URLSearchParams();
    if (anime.title) p.set('title', anime.title);
    p.set('ep', ep === 'latest' ? 'latest' : String(toEpisodeNumber(ep) || 1));
    if (anime.ids?.mal) p.set('mal', String(anime.ids.mal));
    if (anime.ids?.anilist) p.set('anilist', String(anime.ids.anilist));
    if (anime.ids?.kitsu) p.set('kitsu', String(anime.ids.kitsu));
    const slug = keep.slug || anime.slug;
    const src = keep.src || (anime.source?.startsWith('backend:') ? anime.source.slice('backend:'.length) : '');
    if (slug) p.set('slug', slug);
    if (src) p.set('src', src);
    const alt = altTitleOf(anime);
    if (alt) p.set('alt', alt);
    return `${PAGES.watch}?${p.toString()}`;
}

/** Baca parameter watch.html (dengan validasi tipe). */
export function parseWatchParams(search = window.location.search) {
    const p = new URLSearchParams(search);
    return {
        title: (p.get('title') || '').trim().slice(0, 200),
        ep: toEpisodeNumber(p.get('ep')) || 1,
        latest: p.get('ep') === 'latest',
        mal: toPositiveInt(p.get('mal')),
        anilist: toPositiveInt(p.get('anilist')),
        kitsu: (p.get('kitsu') || '').replace(/[^0-9]/g, '') || null,
        slug: (p.get('slug') || '').replace(/[^a-zA-Z0-9._~-]/g, '').slice(0, 160) || null,
        src: (p.get('src') || '').replace(/[^a-z0-9-]/g, '').slice(0, 40) || null,
        alt: (p.get('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 150),
    };
}

/** URL halaman pencarian. */
export function searchUrl(query) {
    const p = new URLSearchParams({ q: query });
    return `${PAGES.search}?${p.toString()}`;
}

/** URL "Lihat Semua" untuk satu kategori homepage. */
export function browseUrl(kind) {
    return `${PAGES.search}?browse=${encodeURIComponent(kind)}`;
}

/** URL "Lihat Semua" untuk satu genre. */
export function genreUrl(label) {
    return `${PAGES.search}?genre=${encodeURIComponent(label)}`;
}

/**
 * Baca parameter search.html. Nilai yang tidak dikenal diabaikan (bukan error).
 * @returns {{q:string, browse:string|null, genre:string|null, sort:string, formats:string[], source:string}}
 */
export function parseSearchParams(search = window.location.search) {
    const p = new URLSearchParams(search);
    const browse = p.get('browse');
    const genreParam = (p.get('genre') || '').trim().toLowerCase();
    const genre = GENRES.find((g) => g.label.toLowerCase() === genreParam)?.label || null;
    const sort = p.get('sort');
    const source = p.get('source');
    const formats = (p.get('format') || '')
        .split(',')
        .map((f) => f.trim().toUpperCase())
        .filter((f, i, arr) => SEARCH_FORMATS.includes(f) && arr.indexOf(f) === i);
    return {
        q: (p.get('q') || '').trim().slice(0, 100),
        browse: BROWSE_KINDS.includes(browse) ? browse : null,
        genre,
        sort: SEARCH_SORTS.includes(sort) ? sort : 'relevance',
        formats,
        source: SEARCH_SOURCES.includes(source) ? source : 'all',
    };
}

/**
 * Susun query string search.html dari state (dipakai history.replaceState
 * agar refresh/bagikan link tetap membuka filter yang sama).
 */
export function searchPageUrl({ q = '', browse = null, genre = null, sort = 'relevance', formats = [], source = 'all' } = {}) {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    else if (browse) p.set('browse', browse);
    else if (genre) p.set('genre', genre);
    if (sort && sort !== 'relevance') p.set('sort', sort);
    if (formats.length) p.set('format', formats.join(','));
    if (q && source && source !== 'all') p.set('source', source);
    const qs = p.toString();
    return qs ? `${PAGES.search}?${qs}` : PAGES.search;
}

/** URL section di homepage (dipakai navbar dari halaman lain). */
export function homeSectionUrl(sectionId) {
    return sectionId ? `${PAGES.home}#${sectionId}` : PAGES.home;
}

/** Nama halaman aktif dari <body data-page="...">. */
export function currentPage() {
    return document.body?.dataset.page || 'home';
}
