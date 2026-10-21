/**
 * Kazanime — routes.js
 * Pembuat & pembaca URL antar halaman. Semua link ke watch/search WAJIB
 * dibuat lewat fungsi di sini supaya format query string konsisten.
 *
 *   watch.html?title=...&ep=1&mal=...&anilist=...[&kitsu=...][&slug=...&src=...]
 *   search.html?q=...            → mode pencarian
 *   search.html?browse=ongoing   → mode "Lihat Semua" (ongoing|popular|new|donghua)
 */

export const PAGES = Object.freeze({
    home: 'index.html',
    watch: 'watch.html',
    search: 'search.html',
});

const toPositiveInt = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * URL halaman nonton.
 * @param {import('./api/normalize.js').Anime} anime
 * @param {number} [ep=1]
 */
export function watchUrl(anime, ep = 1) {
    const p = new URLSearchParams();
    p.set('title', anime.title);
    p.set('ep', String(toPositiveInt(ep) || 1));
    if (anime.ids?.mal) p.set('mal', String(anime.ids.mal));
    if (anime.ids?.anilist) p.set('anilist', String(anime.ids.anilist));
    if (anime.ids?.kitsu) p.set('kitsu', String(anime.ids.kitsu));
    if (anime.slug) p.set('slug', anime.slug);
    if (anime.source?.startsWith('backend:')) p.set('src', anime.source.slice('backend:'.length));
    return `${PAGES.watch}?${p.toString()}`;
}

/** Baca parameter watch.html (dengan validasi tipe). */
export function parseWatchParams(search = window.location.search) {
    const p = new URLSearchParams(search);
    return {
        title: (p.get('title') || '').trim().slice(0, 200),
        ep: toPositiveInt(p.get('ep')) || 1,
        mal: toPositiveInt(p.get('mal')),
        anilist: toPositiveInt(p.get('anilist')),
        kitsu: (p.get('kitsu') || '').replace(/[^0-9]/g, '') || null,
        slug: (p.get('slug') || '').replace(/[^a-zA-Z0-9._~-]/g, '').slice(0, 160) || null,
        src: (p.get('src') || '').replace(/[^a-z0-9-]/g, '').slice(0, 40) || null,
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

/** Baca parameter search.html. */
export function parseSearchParams(search = window.location.search) {
    const p = new URLSearchParams(search);
    const browse = p.get('browse');
    return {
        q: (p.get('q') || '').trim().slice(0, 100),
        browse: ['ongoing', 'popular', 'new', 'donghua'].includes(browse) ? browse : null,
    };
}

/** URL section di homepage (dipakai navbar dari halaman lain). */
export function homeSectionUrl(sectionId) {
    return sectionId ? `${PAGES.home}#${sectionId}` : PAGES.home;
}

/** Nama halaman aktif dari <body data-page="...">. */
export function currentPage() {
    return document.body?.dataset.page || 'home';
}
