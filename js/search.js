/**
 * Kazanime — search.js (entry point search.html)
 *
 * Tiga mode dari query string (lihat routes.js):
 *   ?q=naruto            pencarian gabungan AniList + Kitsu + AnimeKu/Oploverz
 *                        (24 Okt 2026, putaran 7: hasil situs tampil di bagian sendiri
 *                         karena kartunya memutar episode langsung dari situs)
 *   ?browse=ongoing      "Lihat Semua" dari homepage (ongoing|popular|new|donghua)
 *   ?genre=Action        "Lihat Semua" untuk genre
 * + &sort= &format= &source= disimpan di URL (refresh / bagikan link tetap sama).
 *
 * Perbaikan dari file asli:
 *  - Tab "Kitsu" dulu menampilkan SEMUA hasil (filter-nya tidak ada) → tiap tab
 *    sekarang menampilkan hasil sumbernya sendiri, "Semua" = gabungan tanpa duplikat.
 *  - Filter format & tab sumber dulu saling menimpa → sekarang digabung (format
 *    dikirim ke API, tab menyaring hasil).
 *  - Urutan dikirim ke tiap API dengan pemetaan yang benar (lihat api/*.js).
 *  - "Muat Lebih Banyak" hanya meminta sumber yang memang masih punya halaman
 *    berikutnya, hasil baru DITAMBAHKAN tanpa mengacak urutan yang sudah tampil.
 *  - Satu sumber gagal tidak menggagalkan pencarian; keterangan + tombol coba lagi.
 *  - Request lama diabaikan jika user mengganti filter sebelum selesai.
 */
import { initLayout } from './ui/layout.js';
import { renderCards, appendCards, gridMessage, bindCardActions, syncBookmarkButtons } from './ui/card.js';
import { showSkeleton } from './ui/skeleton.js';
import { setSectionNote } from './ui/notice.js';
import { showToast } from './ui/toast.js';
import { getSearchElements } from './ui/navbar.js';
import { html, $, $$, delegate } from './ui/dom.js';
import { parseSearchParams, searchPageUrl, latestEpisodeOf } from './routes.js';
import {
    browseAnime, searchAnime, mergeAnimeLists, friendlyError, retrySourcesNow, SEARCH_SOURCE_ORDER,
} from './api/index.js';
import { sourceLabel } from './api/normalize.js';
import { onBookmarksChange } from './services/bookmark.js';
import { icon } from './ui/icons.js';
import { SITE_SOURCES, SITE_LABELS, siteOfSuggestion, siteResults } from './ui/search-suggest.js';

const ctx = initLayout();
const isBookmarked = (anime) => ctx.isBookmarked(anime);

const grid = $('#searchResultsGrid');
const titleEl = $('#searchResultsTitle');
const subtitleEl = $('#searchResultsSubtitle');
const tabsEl = $('#searchSourceTabs');
const filtersEl = $('#searchFilters');
const loadMoreWrap = $('#searchLoadMore');
const loadMoreBtn = $('#searchLoadMoreBtn');
const siteWrap = $('#searchSiteResults');
const siteGrid = $('#searchSiteGrid');
const siteNote = $('#searchSiteNote');

/** Sumber situs untuk pencarian header → hasil AnimeKu & Oploverz (24 Okt 2026). */
const SITE_SOURCE = 'backend';
/** Batas judul per situs di halaman hasil (dropdown header memakai 3). */
const SITE_SEARCH_LIMIT = 8;

const BROWSE_TITLES = { ongoing: 'Ongoing Anime', popular: 'Anime Populer', new: 'Baru Rilis', donghua: 'Donghua (Anime China)' };
const SHORT_NAMES = { kitsu: 'Kitsu', anilist: 'AniList' };
const isSiteTab = (source) => String(source || '').startsWith('backend:');
const siteOfTab = (source) => (isSiteTab(source) ? String(source).slice('backend:'.length) : '');
const LOAD_MORE_TEXT = 'Muat Lebih Banyak ↓';

const params = parseSearchParams();
const mode = params.q ? 'search' : params.browse ? 'browse' : params.genre ? 'genre' : 'empty';

const state = {
    q: params.q,
    browse: params.browse,
    genre: params.genre,
    sort: params.sort,
    formats: params.formats,
    source: params.source,
    token: 0,
    loading: false,
    // mode pencarian
    page: 1,
    bySource: {},
    sourceSeen: {},
    hasNext: {},
    errors: {},
    merged: [],
    mergedSeen: new Set(),
    /** Hasil AnimeKu & Oploverz (dipisah dari grid metadata). */
    siteItems: [],
    siteError: null,
    // mode jelajah
    items: [],
    itemSeen: new Set(),
    nextPage: 1,
    hasMore: false,
    browseSource: null,
};

/* ------------------------------------------------------------------ */
/* Header, filter, tab, URL                                            */
/* ------------------------------------------------------------------ */
function syncFilterButtons() {
    $$('[data-sort]', filtersEl).forEach((b) => {
        const on = b.dataset.sort === state.sort;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $$('[data-format]', filtersEl).forEach((b) => {
        const on = state.formats.includes(b.dataset.format);
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function syncTabs() {
    $$('.search-source-tab', tabsEl).forEach((t) => {
        const on = t.dataset.source === state.source;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
}

function updateUrl() {
    history.replaceState(null, '', searchPageUrl(state));
}

function setupHeader() {
    tabsEl.hidden = mode !== 'search';
    filtersEl.hidden = mode === 'empty';
    if (mode === 'search') {
        titleEl.textContent = `Hasil Pencarian: "${state.q}"`;
        document.title = `${state.q} - Cari Anime - Kazanime`;
    } else if (mode === 'browse') {
        titleEl.textContent = BROWSE_TITLES[state.browse];
        document.title = `${BROWSE_TITLES[state.browse]} - Kazanime`;
    } else if (mode === 'genre') {
        titleEl.textContent = `Genre: ${state.genre}`;
        document.title = `Genre ${state.genre} - Kazanime`;
    } else {
        titleEl.textContent = 'Cari Anime';
    }
    if (mode !== 'search') {
        // Tanpa kata kunci, "relevansi" = urutan bawaan kategori (trending/populer)
        const relevance = $('[data-sort="relevance"]', filtersEl);
        if (relevance) relevance.innerHTML = String(html`${icon('sparkles')} Default`);
    }
    if (mode === 'browse' && state.browse === 'new') {
        // "Baru Rilis" selalu urut episode terbaru → tombol urutan tidak relevan
        state.sort = 'relevance';
        $$('[data-sort]', filtersEl).forEach((b) => { b.hidden = true; });
        const divider = $('.search-filters-divider', filtersEl);
        if (divider) divider.hidden = true;
    }
    syncFilterButtons();
    syncTabs();
}

function setLoading(loading, append = false) {
    state.loading = loading;
    grid.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (append) {
        loadMoreBtn.disabled = loading;
        loadMoreBtn.textContent = loading ? 'Memuat...' : LOAD_MORE_TEXT;
    }
}

const retryButton = html`<button type="button" class="btn-ext btn-ext--retry" data-action="retry">${icon('refresh-cw')} Coba Lagi</button>`;

/* ------------------------------------------------------------------ */
/* Mode pencarian                                                      */
/* ------------------------------------------------------------------ */
function resetSearch() {
    state.page = 1;
    state.merged = [];
    state.mergedSeen = new Set();
    state.siteItems = [];
    state.siteError = null;
    SEARCH_SOURCE_ORDER.forEach((s) => {
        state.bySource[s] = [];
        state.sourceSeen[s] = new Set();
        state.hasNext[s] = false;
        state.errors[s] = null;
    });
}

function visibleSearchList() {
    if (isSiteTab(state.source)) {
        const site = siteOfTab(state.source);
        return state.siteItems.filter((anime) => siteOfSuggestion(anime) === site);
    }
    return state.source === 'all' ? state.merged : state.bySource[state.source] || [];
}

function searchHasMore() {
    // Hasil situs tidak punya paginasi → tab situs tidak pernah menampilkan "Muat Lebih Banyak".
    if (isSiteTab(state.source)) return false;
    return state.source === 'all'
        ? SEARCH_SOURCE_ORDER.some((s) => state.hasNext[s])
        : Boolean(state.hasNext[state.source]);
}

function renderSearchEmpty() {
    if (state.loading) {
        showSkeleton(grid, 6);
        return;
    }
    const failed = SEARCH_SOURCE_ORDER.filter((s) => state.errors[s]);
    if (isSiteTab(state.source)) {
        const site = SITE_LABELS[siteOfTab(state.source)] || 'situs';
        gridMessage(grid, state.siteError
            ? { icon: 'triangle-alert', title: `Pencarian ${site} gagal`, text: friendlyError(state.siteError), actions: retryButton }
            : { icon: 'inbox', title: `Tidak ada hasil di ${site}`, text: `Judul "${state.q}" belum ada di ${site}. Coba kata kunci lain atau lihat tab AniList/Kitsu.` });
        return;
    }
    if (state.source !== 'all') {
        const err = state.errors[state.source];
        gridMessage(grid, err
            ? { icon: 'triangle-alert', title: `${sourceLabel(state.source)} tidak merespons`, text: friendlyError(err), actions: retryButton }
            : { icon: 'inbox', text: 'Tidak ada hasil dari sumber ini' });
        return;
    }
    if (failed.length === SEARCH_SOURCE_ORDER.length) {
        gridMessage(grid, { icon: 'triangle-alert', title: 'Pencarian gagal', text: friendlyError(state.errors[failed[0]]), actions: retryButton });
        return;
    }
    const q = encodeURIComponent(state.q);
    const fromSites = state.siteItems.length;
    gridMessage(grid, {
        icon: 'search',
        // Bila situs menemukan judulnya, jangan bilang "tidak ditemukan" begitu saja.
        title: fromSites ? `Tidak ada di AniList & Kitsu` : `Tidak ditemukan "${state.q}"`,
        text: fromSites
            ? 'Judulnya tersedia langsung di situs — lihat bagian "Langsung dari AnimeKu & Oploverz" di bawah.'
            : 'Coba kata kunci lain atau cek ejaan judul anime',
        actions: html`
            <a class="btn-ext btn-ext--mal" href="https://myanimelist.net/anime.php?q=${q}" target="_blank" rel="noopener noreferrer">${icon('external-link')} Cari di MAL</a>
            <a class="btn-ext btn-ext--anilist" href="https://anilist.co/search/anime?search=${q}" target="_blank" rel="noopener noreferrer">${icon('external-link')} Cari di AniList</a>`,
    });
}

/**
 * Hasil AnimeKu & Oploverz untuk kata kunci yang sama (24 Okt 2026, putaran 7).
 * Ditampilkan di bagian sendiri: kartunya langsung memutar episode dari situs,
 * sedangkan grid di atas berisi halaman anime dari AniList/Kitsu.
 */
function renderSiteResults() {
    if (!siteWrap || !siteGrid) return;
    const items = mode === 'search' && !isSiteTab(state.source) ? state.siteItems : [];
    const problem = mode === 'search' && !isSiteTab(state.source) ? state.siteError : null;
    // Saat tab situs dipilih, grid utama sudah menampilkan judulnya → panel ini disembunyikan.
    siteWrap.hidden = items.length === 0 && !problem;
    if (!items.length) {
        siteGrid.innerHTML = '';
        if (problem) siteNote.textContent = `Pencarian langsung di AnimeKu & Oploverz belum bisa dimuat (${friendlyError(problem)}).`;
        return;
    }
    renderCards(siteGrid, items, { variant: 'source', isBookmarked, episodeOf: latestEpisodeOf });
    const counts = SITE_SOURCES
        .map((site) => `${SITE_LABELS[site]} (${items.filter((anime) => siteOfSuggestion(anime) === site).length})`)
        .join(' + ');
    siteNote.innerHTML = String(html`Judul yang sudah tersedia di situs — ${counts}. Klik kartu untuk memutar episodenya; urutan/filter di atas hanya berlaku untuk hasil AniList & Kitsu.`);
}

/**
 * @param {{append?: {all: any[], kitsu?: any[], anilist?: any[]}|null}} [opts]
 */
function renderSearch({ append = null } = {}) {
    $$('[data-count]', tabsEl).forEach((el) => {
        const key = el.dataset.count;
        let value;
        if (key === 'all') value = state.merged.length + state.siteItems.length;
        else if (isSiteTab(key)) value = state.siteItems.filter((anime) => siteOfSuggestion(anime) === siteOfTab(key)).length;
        else value = (state.bySource[key] || []).length;
        el.textContent = String(value);
    });

    const failed = SEARCH_SOURCE_ORDER.filter((s) => state.errors[s]);
    const counts = SEARCH_SOURCE_ORDER.map((s) => `${SHORT_NAMES[s]} (${state.bySource[s].length})`).join(' + ');
    const perSite = SITE_SOURCES
        .map((site) => `${SITE_LABELS[site]} (${state.siteItems.filter((anime) => siteOfSuggestion(anime) === site).length})`)
        .join(' + ');
    const siteCount = state.siteItems.length ? ` · ${perSite}` : '';
    if (isSiteTab(state.source)) {
        // Tab situs: dahulukan yang sedang dilihat, katalog tetap disebut sebagai ringkasan.
        const site = SITE_LABELS[siteOfTab(state.source)] || 'situs';
        subtitleEl.textContent = `${site} — ${visibleSearchList().length} judul siap tonton · katalog: ${counts}`
            + (failed.length ? ` · ${failed.map((s) => SHORT_NAMES[s]).join(', ')} tidak merespons` : '');
    } else {
        subtitleEl.textContent = `Ditemukan ${state.merged.length} di katalog${siteCount} — ${counts}`
            + (failed.length ? ` · ${failed.map((s) => SHORT_NAMES[s]).join(', ')} tidak merespons` : '');
    }

    // Urutan/format hanya berlaku untuk AniList & Kitsu → sembunyikan saat tab situs aktif.
    if (filtersEl) filtersEl.hidden = mode === 'search' && isSiteTab(state.source);

    renderSiteResults();

    const list = visibleSearchList();
    if (!list.length) {
        renderSearchEmpty();
    } else if (append && grid.querySelector('.anime-card')) {
        appendCards(grid, append[state.source] || [], { variant: 'search', isBookmarked });
    } else if (isSiteTab(state.source)) {
        // Kartu situs langsung memutar episode dari situs (sama seperti bagian situs).
        renderCards(grid, list, { variant: 'source', isBookmarked, episodeOf: latestEpisodeOf });
    } else {
        renderCards(grid, list, { variant: 'search', isBookmarked });
    }

    setSectionNote(grid, failed.length && list.length
        ? { text: `${failed.map((s) => sourceLabel(s)).join(', ')} tidak merespons — hasil mungkin belum lengkap.`, onRetry: () => { retrySourcesNow(); runSearch(); } }
        : {});
    loadMoreWrap.hidden = !searchHasMore();
}

async function runSearch({ append = false } = {}) {
    const token = ++state.token;
    if (!append) {
        resetSearch();
        showSkeleton(grid, 8);
        setSectionNote(grid);
        subtitleEl.textContent = 'Mencari dari AniList, Kitsu, AnimeKu & Oploverz...';
        loadMoreWrap.hidden = true;
    }
    setLoading(true, append);

    // Halaman pertama juga mencari di AnimeKu & Oploverz (24 Okt 2026, putaran 7).
    // Sumber situs tidak punya paginasi → tidak ikut pada "Muat Lebih Banyak".
    const sources = append
        ? SEARCH_SOURCE_ORDER.filter((s) => state.hasNext[s])
        : [...SEARCH_SOURCE_ORDER, SITE_SOURCE];
    let res;
    try {
        res = await searchAnime(state.q, { page: state.page, sort: state.sort, formats: state.formats, sources });
    } catch (err) {
        if (token !== state.token) return;
        setLoading(false, append);
        if (append) showToast(`Gagal memuat lebih banyak: ${friendlyError(err)}`, 'error');
        else gridMessage(grid, { icon: 'triangle-alert', title: 'Pencarian gagal', text: friendlyError(err), actions: retryButton });
        return;
    }
    if (token !== state.token) return; // filter sudah diganti → abaikan hasil lama

    const fresh = { all: [] };
    for (const s of sources.filter((source) => source !== SITE_SOURCE)) {
        const r = res[s];
        state.errors[s] = r.error && r.error.kind !== 'abort' ? r.error : null;
        state.hasNext[s] = r.hasNext;
        fresh[s] = r.items.filter((anime) => {
            if (state.sourceSeen[s].has(anime.id)) return false;
            state.sourceSeen[s].add(anime.id);
            return true;
        });
        state.bySource[s].push(...fresh[s]);
    }
    if (!append) {
        const siteRes = res[SITE_SOURCE];
        const siteError = siteRes?.error && !['abort', 'disabled'].includes(siteRes.error.kind) ? siteRes.error : null;
        state.siteError = siteError;
        state.siteItems = siteResults(siteRes?.items || [], SITE_SEARCH_LIMIT);
    }
    fresh.all = mergeAnimeLists(fresh, { sort: state.sort, seen: state.mergedSeen });
    state.merged.push(...fresh.all);
    state.page += 1;

    setLoading(false, append);
    renderSearch({ append: append ? fresh : null });
}

/* ------------------------------------------------------------------ */
/* Mode jelajah (browse / genre)                                       */
/* ------------------------------------------------------------------ */
function browseSubtitle(res) {
    const base = `${state.items.length} anime · Sumber: ${sourceLabel(state.browseSource)}`;
    return res?.fallback ? `${base} (sumber online tidak dapat diakses)` : base;
}

async function runBrowse({ append = false } = {}) {
    const token = ++state.token;
    if (!append) {
        state.items = [];
        state.itemSeen = new Set();
        state.nextPage = 1;
        state.hasMore = false;
        state.browseSource = null;
        showSkeleton(grid, 8);
        setSectionNote(grid);
        subtitleEl.textContent = 'Memuat daftar anime...';
        loadMoreWrap.hidden = true;
    }
    setLoading(true, append);

    const kind = mode === 'genre' ? 'genre' : state.browse;
    const res = await browseAnime(kind, {
        page: state.nextPage,
        sort: state.sort,
        formats: state.formats,
        genre: state.genre,
        source: append ? state.browseSource : undefined, // halaman berikutnya dari sumber yang sama
    });
    if (token !== state.token) return;
    setLoading(false, append);

    const fresh = res.items.filter((anime) => {
        if (state.itemSeen.has(anime.id)) return false;
        state.itemSeen.add(anime.id);
        return true;
    });
    if (!append) state.browseSource = res.source;
    state.items.push(...fresh);
    state.hasMore = res.hasNext;
    state.nextPage = res.nextPage;

    if (append && res.error && !res.items.length) {
        showToast(`Gagal memuat lebih banyak: ${friendlyError(res.error)}`, 'error');
        loadMoreWrap.hidden = false;
        return;
    }

    if (!state.items.length) {
        subtitleEl.textContent = '';
        gridMessage(grid, res.error && res.error.kind !== 'empty'
            ? { icon: 'triangle-alert', title: 'Gagal memuat daftar', text: friendlyError(res.error), actions: retryButton }
            : { icon: 'inbox', title: 'Tidak ada anime', text: state.formats.length ? 'Coba hapus filter format.' : 'Belum ada data untuk kategori ini.' });
    } else {
        // "Baru Rilis" (browse=new) & donghua dari backend: kartu membuka episode yang baru tayang
        const toLatest = mode === 'browse' && (state.browse === 'new' || (state.browse === 'donghua' && state.browseSource === 'backend'));
        const episodeOf = toLatest ? latestEpisodeOf : undefined;
        if (append && grid.querySelector('.anime-card')) appendCards(grid, fresh, { isBookmarked, episodeOf });
        else renderCards(grid, state.items, { isBookmarked, episodeOf });
    }

    if (!append) {
        subtitleEl.textContent = state.items.length ? browseSubtitle(res) : '';
        setSectionNote(grid, res.fallback
            ? { text: `Menampilkan data cadangan. ${friendlyError(res.error)}`, onRetry: () => { retrySourcesNow(); runBrowse(); } }
            : {});
    } else {
        subtitleEl.textContent = browseSubtitle();
    }
    loadMoreWrap.hidden = !state.hasMore;
}

/* ------------------------------------------------------------------ */
/* Event                                                               */
/* ------------------------------------------------------------------ */
function reload() {
    if (mode === 'search') runSearch();
    else if (mode === 'browse' || mode === 'genre') runBrowse();
}

delegate(filtersEl, 'click', '.search-filter-btn', (_e, btn) => {
    if (btn.dataset.sort) {
        if (state.sort === btn.dataset.sort) return;
        state.sort = btn.dataset.sort;
    } else if (btn.dataset.format) {
        const f = btn.dataset.format;
        state.formats = state.formats.includes(f) ? state.formats.filter((x) => x !== f) : [...state.formats, f];
    }
    syncFilterButtons();
    updateUrl();
    reload();
});

delegate(tabsEl, 'click', '.search-source-tab', (_e, tab) => {
    if (state.source === tab.dataset.source) return;
    state.source = tab.dataset.source;
    syncTabs();
    updateUrl();
    renderSearch();
});

delegate(grid, 'click', '[data-action="retry"]', () => {
    retrySourcesNow();
    reload();
});

loadMoreBtn.addEventListener('click', () => {
    if (state.loading) return;
    if (mode === 'search') runSearch({ append: true });
    else runBrowse({ append: true });
});

bindCardActions(grid, (anime) => ctx.toggleBookmark(anime));
onBookmarksChange(() => syncBookmarkButtons(isBookmarked, grid));
// Kartu AnimeKu/Oploverz juga punya tombol bookmark (24 Okt 2026, putaran 7).
if (siteGrid) {
    bindCardActions(siteGrid, (anime) => ctx.toggleBookmark(anime));
    onBookmarksChange(() => syncBookmarkButtons(isBookmarked, siteGrid));
}

/* ------------------------------------------------------------------ */
/* Mulai                                                               */
/* ------------------------------------------------------------------ */
setupHeader();
if (mode === 'empty') {
    subtitleEl.textContent = '';
    gridMessage(grid, {
        icon: 'search',
        title: 'Ketik judul anime di kotak pencarian',
        text: 'Minimal 2 huruf, lalu tekan Enter untuk hasil lengkap dari AniList, Kitsu, AnimeKu & Oploverz.',
    });
    if (window.matchMedia?.('(min-width: 769px)').matches) getSearchElements()?.input.focus();
} else {
    updateUrl(); // rapikan parameter yang tidak valid
    reload();
}
