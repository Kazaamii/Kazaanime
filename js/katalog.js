/**
 * Kazanime — katalog.js (entry point katalog.html, menu "Jelajah")
 *
 * Dua situs, dua susunan bagian:
 *   AnimeKu  : Terbaru → New Anime Populer → Top Favorit → Coming Soon → Complete
 *   Oploverz : Terbaru → Populer → Rating Tertinggi → Ongoing → Completed → Movie (+ genre)
 *
 * Setiap bagian adalah baris kartu ringkas (6 judul) dengan tombol **Expand** untuk
 * menampilkan seluruh judul yang sudah dimuat dan **Muat Lagi** untuk halaman berikutnya.
 * Bagian dimuat saat mendekati layar (IntersectionObserver) supaya satu kunjungan tidak
 * menembak enam halaman situs sekaligus — fetcher tetap menghormati jeda 1 detik/host.
 *
 * Halaman ini TIDAK mengklaim Sub Indo per judul: itu hanya dinyatakan panel beranda
 * setelah halaman episode diperiksa. State URL: katalog.html?source=animeku&genre=action
 */
import { initLayout } from './ui/layout.js';
import { renderCards, gridMessage, bindCardActions, syncBookmarkButtons } from './ui/card.js';
import { showSkeleton } from './ui/skeleton.js';
import { friendlyError } from './api/index.js';
import { getSourceBrowse } from './api/sources.js';
import { onBookmarksChange } from './services/bookmark.js';
import { html, $, delegate } from './ui/dom.js';
import { currentPage } from './routes.js';

const ctx = initLayout();
const isBookmarked = (anime) => ctx.isBookmarked(anime);

/** Judul yang tampil sebelum tombol Expand ditekan. */
const PREVIEW = 6;

/**
 * Urutan bagian = urutan permintaan pengguna; setiap `id` adalah token filter backend
 * (`baru`, `populer`, ...). Backend yang memetakan token ke halaman situs.
 */
const SOURCES = Object.freeze([
    {
        id: 'animeku',
        label: 'AnimeKu',
        hint: 'AnimeKu tidak menyediakan halaman genre; bagian di bawah mengikuti menu situsnya.',
        sections: [
            { id: 'baru', label: 'Terbaru', hint: 'Rilis paling baru dari halaman Baru.' },
            { id: 'populer', label: 'New Anime Populer', hint: 'Daftar Favorit diurutkan skor tertinggi pada halaman ini.' },
            { id: 'favorit', label: 'Top Favorit', hint: 'Urutan favorit situs (skor tertinggi lebih dulu).' },
            { id: 'coming', label: 'Coming Soon', hint: 'Seri ongoing yang belum punya episode.' },
            { id: 'selesai', label: 'Complete', hint: 'Seri yang sudah tamat.' },
        ],
    },
    {
        id: 'oploverz',
        label: 'Oploverz (Animeloverz)',
        hint: 'Genre tersedia; situs tidak punya kategori Donghua, jadi hanya jenis yang benar-benar ada yang tampil.',
        sections: [
            { id: 'update', label: 'Terbaru', hint: 'Update terakhir dari situs.' },
            { id: 'popular', label: 'Populer', hint: 'Urutan populer situs.' },
            { id: 'rating', label: 'Rating Tertinggi', hint: 'Urutan rating situs.' },
            { id: 'ongoing', label: 'Ongoing', hint: 'Sedang berjalan.' },
            { id: 'completed', label: 'Completed', hint: 'Sudah tamat.' },
            { id: 'movie', label: 'Movie', hint: 'Hanya film.' },
        ],
    },
]);

const sectionsEl = $('#katalogSections');
const noteEl = $('#katalogNote');
const tabsEl = $('#katalogSourceTabs');
const genreWrap = $('#katalogGenreWrap');
const genreSelect = $('#katalogGenre');
const titleEl = $('#katalogTitle');
const subtitleEl = $('#katalogSubtitle');

const sourceDef = (id) => SOURCES.find((item) => item.id === id) || SOURCES[0];
const sourceLabel = (id) => sourceDef(id).label;

const readParams = () => {
    const q = new URLSearchParams(window.location.search);
    const source = SOURCES.some((item) => item.id === q.get('source')) ? q.get('source') : SOURCES[0].id;
    return { source, genre: (q.get('genre') || '').toLowerCase() };
};

const initial = readParams();
const state = {
    source: initial.source,
    genre: initial.genre,
    genres: [],
    sections: [],
    loadToken: 0,
};

/** Bagian runtime: data + status muat, bukan bagian dari definisi sumber. */
function makeRuntime(def) {
    return {
        def,
        items: [],
        page: 0,
        hasNext: false,
        loaded: false,
        loading: false,
        expanded: false,
        error: '',
        token: 0,
    };
}

const dedupeKey = (anime) => String(anime?.slug || anime?.title || '');

/** Tulis state ke URL tanpa menambah riwayat (refresh tetap sama). */
function syncUrl() {
    const q = new URLSearchParams();
    q.set('source', state.source);
    if (state.genre) q.set('genre', state.genre);
    const next = `${window.location.pathname}?${q.toString()}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
        window.history.replaceState({ page: currentPage() }, '', next);
    }
}

function setNote(text, isError = false) {
    if (!noteEl) return;
    noteEl.textContent = text;
    noteEl.classList.toggle('is-error', Boolean(isError));
}

function updateNote() {
    const loaded = state.sections.filter((item) => item.loaded);
    const total = state.sections.reduce((sum, item) => sum + item.items.length, 0);
    const failed = state.sections.filter((item) => item.error).length;
    if (!loaded.length && failed) {
        setNote(`Katalog ${sourceLabel(state.source)} belum bisa dimuat.`, true);
        return;
    }
    if (!loaded.length) {
        setNote(`Memuat ${sourceLabel(state.source)}…`);
        return;
    }
    const bits = [`${loaded.length}/${state.sections.length} bagian`, `${total} judul dimuat`];
    if (state.genre) bits.push(`genre: ${state.genres.find((g) => g.id === state.genre)?.label || state.genre}`);
    if (failed) bits.push(`${failed} bagian gagal dimuat`);
    setNote(bits.join(' · '), Boolean(failed));
}

/** Tab sumber: satu tombol per situs. */
function renderTabs() {
    if (!tabsEl) return;
    tabsEl.innerHTML = String(html`${SOURCES.map((source) => html`
        <button type="button" class="search-source-tab${source.id === state.source ? ' active' : ''}"
            role="tab" aria-selected="${source.id === state.source ? 'true' : 'false'}" data-source="${source.id}">
            <span class="src-dot src-dot--backend" aria-hidden="true"></span>${source.label}
        </button>`)}`);
}

/** Pemilih genre: hanya sumber yang mengirim `genres` (Oploverz) yang menampilkannya. */
function renderGenre() {
    if (!genreWrap || !genreSelect) return;
    if (!state.genres.length) {
        genreWrap.hidden = true;
        genreSelect.innerHTML = '';
        return;
    }
    genreWrap.hidden = false;
    genreSelect.innerHTML = String(html`
        <option value=""${state.genre ? '' : ' selected'}>Semua genre</option>
        ${state.genres.map((genre) => html`<option value="${genre.id}"${genre.id === state.genre ? ' selected' : ''}>${genre.label}</option>`)}`);
}

function renderHeader() {
    const def = sourceDef(state.source);
    if (titleEl) titleEl.textContent = `Jelajah ${def.label}`;
    if (subtitleEl) {
        subtitleEl.textContent = `Bagian tetap: ${def.sections.map((section) => section.label).join(' → ')}. `
            + 'Kartu di sini tidak diklaim Sub Indo sampai episodenya diperiksa.';
    }
}

/** Satu blok bagian (kepala + grid + tombol). */
function sectionHTML(runtime, index) {
    const def = runtime.def;
    return html`
        <section class="katalog-block" data-section="${def.id}" aria-labelledby="katalog-block-${index}">
            <div class="katalog-block-head">
                <div class="katalog-block-title">
                    <h3 id="katalog-block-${index}">${def.label}</h3>
                    ${def.hint ? html`<p class="katalog-block-hint">${def.hint}</p>` : ''}
                </div>
                <div class="katalog-block-actions">
                    <span class="katalog-block-count" data-count hidden></span>
                    <button type="button" class="katalog-expand" data-expand aria-expanded="false" hidden>Expand</button>
                </div>
            </div>
            <div class="anime-grid katalog-block-grid" data-grid aria-busy="false"></div>
            <div class="katalog-block-foot" data-foot hidden>
                <button type="button" class="btn-load-more" data-more>Muat Lagi ↓</button>
            </div>
        </section>`;
}

function sectionNode(runtime) {
    return sectionsEl?.querySelector(`[data-section="${runtime.def.id}"]`) || null;
}

/** Gambar ulang satu bagian sesuai status (ringkas/expanded/error/kosong). */
function paintSection(runtime) {
    const node = sectionNode(runtime);
    if (!node) return;
    const grid = node.querySelector('[data-grid]');
    const expandBtn = node.querySelector('[data-expand]');
    const countEl = node.querySelector('[data-count]');
    const foot = node.querySelector('[data-foot]');
    const moreBtn = node.querySelector('[data-more]');

    const visible = runtime.expanded ? runtime.items : runtime.items.slice(0, PREVIEW);
    const canExpand = runtime.items.length > PREVIEW || runtime.hasNext;

    if (countEl) {
        countEl.hidden = !runtime.loaded;
        countEl.textContent = runtime.loaded ? `${runtime.items.length}${runtime.hasNext ? '+' : ''} judul` : '';
    }
    if (expandBtn) {
        expandBtn.hidden = !canExpand;
        expandBtn.textContent = runtime.expanded ? 'Ringkas' : `Expand (${runtime.items.length}${runtime.hasNext ? '+' : ''})`;
        expandBtn.setAttribute('aria-expanded', runtime.expanded ? 'true' : 'false');
    }
    if (foot) foot.hidden = !runtime.expanded || !runtime.hasNext;

    if (!grid) return;
    if (runtime.loading && !runtime.items.length) {
        showSkeleton(grid, PREVIEW);
        return;
    }
    grid.setAttribute('aria-busy', 'false');
    if (runtime.error && !runtime.items.length) {
        gridMessage(grid, {
            icon: 'triangle-alert',
            title: `${runtime.def.label} belum bisa dimuat`,
            text: runtime.error,
            actions: html`<button type="button" class="btn-ext btn-ext--retry" data-retry="${runtime.def.id}">Coba Lagi</button>`,
        });
        return;
    }
    if (!runtime.items.length) {
        gridMessage(grid, {
            icon: 'inbox',
            title: `Belum ada judul di bagian ${runtime.def.label}`,
            text: 'Situs tidak mengembalikan judul untuk bagian ini saat halaman diperiksa.',
        });
        return;
    }
    renderCards(grid, visible, { variant: 'catalog', isBookmarked, episodeOf: () => 'latest' });
    if (moreBtn) moreBtn.textContent = runtime.loading ? 'Memuat…' : 'Muat Lagi ↓';
    if (moreBtn) moreBtn.disabled = runtime.loading;
}

function paintAll() {
    state.sections.forEach(paintSection);
    updateNote();
}

/** Muat satu bagian (`page` berikutnya bila sudah ada isinya). */
async function loadSection(runtime, { reset = false, refresh = false } = {}) {
    if (runtime.loading) return;
    if (reset) {
        runtime.items = [];
        runtime.page = 0;
        runtime.hasNext = false;
        runtime.loaded = false;
        runtime.error = '';
        runtime.expanded = false;
    }
    runtime.loading = true;
    const token = ++runtime.token;
    const sourceToken = state.loadToken;
    paintSection(runtime);
    updateNote();

    try {
        const res = await getSourceBrowse(state.source, {
            filter: runtime.def.id,
            genre: state.genre,
            page: runtime.page + 1,
            // "Coba Lagi" melewati cache + circuit breaker frontend, sama seperti panel beranda.
            refresh,
        });
        if (token !== runtime.token || sourceToken !== state.loadToken) return;
        runtime.page = res.page;
        runtime.hasNext = res.hasNext;
        runtime.loaded = true;
        runtime.error = '';
        if (res.genres.length && !state.genres.length) {
            state.genres = res.genres;
            renderGenre();
        }
        const seen = new Set(runtime.items.map(dedupeKey));
        for (const anime of res.items) {
            const key = dedupeKey(anime);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            runtime.items.push(anime);
        }
    } catch (err) {
        if (token !== runtime.token || sourceToken !== state.loadToken) return;
        runtime.error = friendlyError(err);
        runtime.loaded = true;
    } finally {
        if (token === runtime.token && sourceToken === state.loadToken) {
            runtime.loading = false;
            paintSection(runtime);
            updateNote();
        }
    }
}

/** Amati blok: bagian dimuat saat mendekati viewport (satu per satu). */
const observer = typeof window !== 'undefined' && 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const runtime = state.sections.find((item) => item.def.id === entry.target.dataset.section);
            if (runtime && !runtime.loaded && !runtime.loading) loadSection(runtime);
            observer.unobserve(entry.target);
        }
    }, { rootMargin: '400px 0px' })
    : null;

function buildSections() {
    if (!sectionsEl) return;
    state.sections = sourceDef(state.source).sections.map(makeRuntime);
    sectionsEl.innerHTML = String(html`${state.sections.map((runtime, index) => sectionHTML(runtime, index))}`);
    sectionsEl.setAttribute('aria-busy', 'false');
    state.sections.forEach((runtime) => {
        if (observer) observer.observe(sectionNode(runtime));
    });
    // Bagian pertama langsung dimuat supaya halaman tidak kosong sebelum di-scroll.
    if (state.sections[0]) loadSection(state.sections[0]);
}

function switchSource(id) {
    if (!id || id === state.source) return;
    state.source = id;
    state.genre = '';
    state.genres = [];
    state.loadToken += 1;
    renderTabs();
    renderHeader();
    renderGenre();
    syncUrl();
    buildSections();
}

function switchGenre(genre) {
    if (genre === state.genre) return;
    state.genre = genre;
    state.loadToken += 1;
    syncUrl();
    buildSections();
}

renderTabs();
renderHeader();
renderGenre();
buildSections();

if (tabsEl) {
    delegate(tabsEl, 'click', '[data-source]', (event, button) => {
        event.preventDefault();
        switchSource(button.dataset.source);
    });
}

if (genreSelect) {
    genreSelect.addEventListener('change', () => switchGenre(genreSelect.value));
}

if (sectionsEl) {
    delegate(sectionsEl, 'click', '[data-expand]', (event, button) => {
        event.preventDefault();
        const runtime = state.sections.find((item) => sectionNode(item)?.contains(button));
        if (!runtime) return;
        runtime.expanded = !runtime.expanded;
        paintSection(runtime);
        updateNote();
    });
    delegate(sectionsEl, 'click', '[data-more]', (event, button) => {
        event.preventDefault();
        const runtime = state.sections.find((item) => sectionNode(item)?.contains(button));
        if (!runtime || runtime.loading || !runtime.hasNext) return;
        loadSection(runtime);
    });
    delegate(sectionsEl, 'click', '[data-retry]', (event, button) => {
        event.preventDefault();
        const runtime = state.sections.find((item) => item.def.id === button.dataset.retry);
        if (runtime) loadSection(runtime, { reset: true, refresh: true });
    });
    bindCardActions(sectionsEl, (anime) => ctx.toggleBookmark(anime));
    onBookmarksChange(() => syncBookmarkButtons(isBookmarked, sectionsEl));
}
