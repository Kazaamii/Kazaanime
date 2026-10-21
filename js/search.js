/**
 * Kazanime — search.js (entry point search.html)
 *
 * Tiga mode dari query string (lihat routes.js):
 *   ?q=naruto            pencarian gabungan MyAnimeList + Kitsu + AniList
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

const ctx = initLayout();
const isBookmarked = (anime) => ctx.isBookmarked(anime);

const grid = $('#searchResultsGrid');
const titleEl = $('#searchResultsTitle');
const subtitleEl = $('#searchResultsSubtitle');
const tabsEl = $('#searchSourceTabs');
const filtersEl = $('#searchFilters');
const loadMoreWrap = $('#searchLoadMore');
const loadMoreBtn = $('#searchLoadMoreBtn');

const BROWSE_TITLES = { ongoing: 'Ongoing Anime', popular: 'Anime Populer', new: 'Baru Rilis', donghua: '🐉 Donghua (Anime China)' };
const SHORT_NAMES = { mal: 'MAL', kitsu: 'Kitsu', anilist: 'AniList' };
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
        if (relevance) relevance.textContent = '✨ Default';
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

const retryButton = html`<button type="button" class="btn-ext btn-ext--retry" data-action="retry">🔄 Coba Lagi</button>`;

/* ------------------------------------------------------------------ */
/* Mode pencarian                                                      */
/* ------------------------------------------------------------------ */
function resetSearch() {
    state.page = 1;
    state.merged = [];
    state.mergedSeen = new Set();
    SEARCH_SOURCE_ORDER.forEach((s) => {
        state.bySource[s] = [];
        state.sourceSeen[s] = new Set();
        state.hasNext[s] = false;
        state.errors[s] = null;
    });
}

function visibleSearchList() {
    return state.source === 'all' ? state.merged : state.bySource[state.source] || [];
}

function searchHasMore() {
    return state.source === 'all'
        ? SEARCH_SOURCE_ORDER.some((s) => state.hasNext[s])
        : Boolean(state.hasNext[state.source]);
}

function renderSearchEmpty() {
    const failed = SEARCH_SOURCE_ORDER.filter((s) => state.errors[s]);
    if (state.source !== 'all') {
        const err = state.errors[state.source];
        gridMessage(grid, err
            ? { icon: '⚠️', title: `${sourceLabel(state.source)} tidak merespons`, text: friendlyError(err), actions: retryButton }
            : { icon: '📭', text: 'Tidak ada hasil dari sumber ini' });
        return;
    }
    if (failed.length === SEARCH_SOURCE_ORDER.length) {
        gridMessage(grid, { icon: '⚠️', title: 'Pencarian gagal', text: friendlyError(state.errors[failed[0]]), actions: retryButton });
        return;
    }
    const q = encodeURIComponent(state.q);
    gridMessage(grid, {
        icon: '🔍',
        title: `Tidak ditemukan "${state.q}"`,
        text: 'Coba kata kunci lain atau cek ejaan judul anime',
        actions: html`
            <a class="btn-ext btn-ext--mal" href="https://myanimelist.net/anime.php?q=${q}" target="_blank" rel="noopener noreferrer">🔷 Cari di MAL</a>
            <a class="btn-ext btn-ext--anilist" href="https://anilist.co/search/anime?search=${q}" target="_blank" rel="noopener noreferrer">💙 Cari di AniList</a>`,
    });
}

/**
 * @param {{append?: {all: any[], mal?: any[], kitsu?: any[], anilist?: any[]}|null}} [opts]
 */
function renderSearch({ append = null } = {}) {
    $$('[data-count]', tabsEl).forEach((el) => {
        const key = el.dataset.count;
        el.textContent = String(key === 'all' ? state.merged.length : (state.bySource[key] || []).length);
    });

    const failed = SEARCH_SOURCE_ORDER.filter((s) => state.errors[s]);
    const counts = SEARCH_SOURCE_ORDER.map((s) => `${SHORT_NAMES[s]} (${state.bySource[s].length})`).join(' + ');
    subtitleEl.textContent = `Ditemukan ${state.merged.length} anime — ${counts}`
        + (failed.length ? ` · ${failed.map((s) => SHORT_NAMES[s]).join(', ')} tidak merespons` : '');

    const list = visibleSearchList();
    if (!list.length) {
        renderSearchEmpty();
    } else if (append && grid.querySelector('.anime-card')) {
        appendCards(grid, append[state.source] || [], { variant: 'search', isBookmarked });
    } else {
        renderCards(grid, list, { variant: 'search', isBookmarked });
    }

    setSectionNote(grid, failed.length && list.length
        ? { text: `⚠️ ${failed.map((s) => sourceLabel(s)).join(', ')} tidak merespons — hasil mungkin belum lengkap.`, onRetry: () => { retrySourcesNow(); runSearch(); } }
        : {});
    loadMoreWrap.hidden = !searchHasMore();
}

async function runSearch({ append = false } = {}) {
    const token = ++state.token;
    if (!append) {
        resetSearch();
        showSkeleton(grid, 8);
        setSectionNote(grid);
        subtitleEl.textContent = 'Mencari dari MyAnimeList + Kitsu + AniList...';
        loadMoreWrap.hidden = true;
    }
    setLoading(true, append);

    const sources = append ? SEARCH_SOURCE_ORDER.filter((s) => state.hasNext[s]) : SEARCH_SOURCE_ORDER;
    let res;
    try {
        res = await searchAnime(state.q, { page: state.page, sort: state.sort, formats: state.formats, sources });
    } catch (err) {
        if (token !== state.token) return;
        setLoading(false, append);
        if (append) showToast(`Gagal memuat lebih banyak: ${friendlyError(err)}`, 'error');
        else gridMessage(grid, { icon: '⚠️', title: 'Pencarian gagal', text: friendlyError(err), actions: retryButton });
        return;
    }
    if (token !== state.token) return; // filter sudah diganti → abaikan hasil lama

    const fresh = { all: [] };
    for (const s of sources) {
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
            ? { icon: '⚠️', title: 'Gagal memuat daftar', text: friendlyError(res.error), actions: retryButton }
            : { icon: '📭', title: 'Tidak ada anime', text: state.formats.length ? 'Coba hapus filter format.' : 'Belum ada data untuk kategori ini.' });
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
            ? { text: `⚠️ Menampilkan data cadangan. ${friendlyError(res.error)}`, onRetry: () => { retrySourcesNow(); runBrowse(); } }
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

/* ------------------------------------------------------------------ */
/* Mulai                                                               */
/* ------------------------------------------------------------------ */
setupHeader();
if (mode === 'empty') {
    subtitleEl.textContent = '';
    gridMessage(grid, {
        icon: '🔍',
        title: 'Ketik judul anime di kotak pencarian',
        text: 'Minimal 2 huruf, lalu tekan Enter untuk hasil lengkap dari MyAnimeList, Kitsu & AniList.',
    });
    if (window.matchMedia?.('(min-width: 769px)').matches) getSearchElements()?.input.focus();
} else {
    updateUrl(); // rapikan parameter yang tidak valid
    reload();
}
