/**
 * Kazanime — katalog.js (entry point katalog.html, menu "Jelajah")
 *
 * Tiga tab:
 *   AnimeKu  : Terbaru → New Anime Populer → Top Favorit → Coming Soon → Complete
 *   Oploverz : Terbaru → Populer → Rating Tertinggi → Ongoing → Completed → Movie (+ genre)
 *   Donghua  : donghua baru upload (feed Donghua Kazanime; situs tidak punya kategori ini)
 *
 * Setiap bagian adalah baris kartu ringkas (6 judul) dengan tombol
 * **Tampilkan lebih banyak** — membuka sisa judul yang sudah dimuat di tempat, lalu
 * **Muat Lagi** mengambil halaman berikutnya — plus tautan **Lihat Semua** yang membuka
 * daftar penuh bagian itu di halaman yang sama (`?filter=<id>`).
 * Bagian dimuat saat mendekati layar (IntersectionObserver) supaya satu kunjungan tidak
 * menembak enam halaman situs sekaligus — fetcher tetap menghormati jeda 1 detik/host.
 *
 * Kolom pencarian (24 Okt 2026, permintaan pengguna) mencari DI DALAM satu sumber:
 * AnimeKu lewat `/?s=`, Oploverz lewat `/?s=` juga — hasilnya satu blok "Hasil" tanpa
 * paginasi. Pencarian ini memakai endpoint yang sama dengan tombol cari situs, jadi tidak
 * ada klaim Sub Indo per judul.
 *
 * Halaman ini TIDAK mengklaim Sub Indo per judul: itu hanya dinyatakan panel beranda
 * setelah halaman episode diperiksa. State URL:
 * katalog.html?source=animeku&genre=action&filter=baru
 * katalog.html?source=oploverz&genre=slice-of-life&year=2024&season=fall
 * katalog.html?source=oploverz&q=one+piece
 *
 * Filter Tahun & Musim (24 Okt 2026, permintaan pengguna) dikirim ke backend; Oploverz
 * memakainya (`season[]=fall-2024`), AnimeKu tidak punya musim sehingga kedua pilihan
 * disembunyikan saat tab AnimeKu aktif — bukan pura-pura menyaring.
 */
import { initLayout } from './ui/layout.js';
import { renderCards, gridMessage, bindCardActions, syncBookmarkButtons } from './ui/card.js';
import { showSkeleton } from './ui/skeleton.js';
import { browseAnime, friendlyError, getUpcomingAnime } from './api/index.js';
import { getSourceBrowse } from './api/sources.js';
import { withAutoRetry } from './api/retry.js';
import { onBookmarksChange } from './services/bookmark.js';
import { html, $, delegate } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { currentPage, katalogUrl } from './routes.js';

const ctx = initLayout();
const isBookmarked = (anime) => ctx.isBookmarked(anime);

/** Kartu yang tampil per bagian; sisanya lewat tautan "Lihat Semua" (gaya beranda). */
const PREVIEW = 6;

/**
 * Urutan bagian = urutan permintaan pengguna; setiap `id` adalah token filter backend
 * (`baru`, `populer`, ...). Backend yang memetakan token ke halaman situs.
 */
const SOURCES = Object.freeze([
    {
        id: 'animeku',
        label: 'AnimeKu',
        hint: 'Cari di dalam katalog AnimeKu lewat kolom pencarian di atas. Genre diambil dari tautan arsip genre situs (`/genre/<slug>-<token>/`). AnimeKu punya donghua Sub Indo — lihat bagian Donghua di bawah.',
        sections: [
            { id: 'baru', label: 'Terbaru', hint: 'Rilis paling baru dari halaman Baru.' },
            { id: 'populer', label: 'New Anime Populer', hint: 'Halaman Baru diurutkan skor tertinggi — rilis baru yang paling populer.' },
            { id: 'favorit', label: 'Top Favorit', hint: 'Urutan favorit situs (skor tertinggi lebih dulu).' },
            {
                id: 'coming',
                label: 'Coming Soon',
                loader: 'metadata',
                hint: 'Anime yang belum tayang, dari metadata AniList — situs AnimeKu tidak punya halaman Coming Soon.',
            },
            { id: 'selesai', label: 'Complete', hint: 'Seri yang sudah tamat.' },
            {
                id: 'donghua',
                label: 'Donghua di AnimeKu',
                hint: 'AnimeKu mengunggah donghua Sub Indo (mis. Douluo Dalu, Perfect World). Situs tidak memberi kategori donghua yang bisa dipakai — arsip genre/negara memakai token acak dan seri donghua pun dilabeli "Japan" — jadi daftar ini disusun dari judul donghua populer + judul yang sedang tayang (metadata) yang dicari di AnimeKu. Donghua lama di luar daftar itu belum tercakup.',
            },
        ],
    },
    {
        id: 'oploverz',
        label: 'Oploverz (Animeloverz)',
        hint: 'Kolom pencarian di atas mencari langsung di Oploverz. Genre (80), tahun, dan musim tersedia dari form filter situs. Donghua ada di bagian tersendiri di bawah.',
        sections: [
            { id: 'update', label: 'Terbaru', hint: 'Update terakhir dari situs.' },
            { id: 'popular', label: 'Populer', hint: 'Urutan populer situs.' },
            { id: 'rating', label: 'Rating Tertinggi', hint: 'Urutan rating situs.' },
            { id: 'ongoing', label: 'Ongoing', hint: 'Sedang berjalan.' },
            { id: 'completed', label: 'Completed', hint: 'Sudah tamat.' },
            { id: 'movie', label: 'Movie', hint: 'Hanya film.' },
            {
                id: 'donghua',
                label: 'Donghua di Oploverz',
                hint: 'Oploverz tidak punya kategori/negara Donghua, jadi bagian ini dicari lewat judul: 4 benih situs (Perfect World, Battle Through the Heavens, Soul Land, Renegade Immortal) + judul donghua tayang dari metadata, dan hanya kartu yang judulnya cocok yang ditampilkan. Dicek 24 Okt 2026: oploverz.ch tidak memuat judul-judul itu (Perfect World → 404, Douluo/Martial Universe → "Not Found") dan pencarian situsnya fuzzy ("Battle Through the Heavens" menjawab "Kingdom"), jadi bagian ini wajar kosong — itu batas situsnya, bukan data yang disembunyikan.',
            },
        ],
    },
    {
        id: 'donghua',
        label: 'Donghua',
        hint: 'Lima bagian: feed Donghua Kazanime, lalu Donghua di HiAnime, AnimeXin, AnimeKu, dan Oploverz. Tiap bagian menjelaskan batas situsnya masing-masing.',
        sections: [
            {
                id: 'donghua',
                label: 'Donghua Baru Upload',
                loader: 'donghua',
                hint: 'Rilis donghua terbaru beserta nomor episode terakhir.',
            },
            // Sumber donghua paling kaya (dicek 24 Okt 2026): 7 benih judul donghua China,
            // semuanya mengembalikan seri yang cocok. Tidak ada tab HiAnime tersendiri, jadi
            // tautan "Lihat Semua" dimatikan — daftarnya sudah penuh di bagian ini.
            {
                id: 'donghua',
                label: 'Donghua di HiAnime',
                source: 'hianime',
                seeAll: false,
                hint: 'HiAnime punya donghua yang banyak: Soul Land (5 seri), Battle Through the Heavens (3), Douluo Dalu, Perfect World, Renegade Immortal (2), Throne of Seal, dan Shaonian Ge Xing (4, termasuk Anhe Zhuan). Bagian ini mencari tujuh judul itu dan hanya menampilkan kartu yang judulnya cocok — hasil produksi 24 Okt 2026: 17 judul. Subtitle HiAnime berbahasa Inggris.',
            },
            // AnimeXin = situs donghua; seluruh katalognya memang donghua China.
            {
                id: 'donghua',
                label: 'Donghua di AnimeXin',
                source: 'animexin',
                seeAll: false,
                hint: 'AnimeXin adalah situs donghua Sub Indo — seluruh daftar rilisnya donghua China, jadi bagian ini memakai katalog terbarunya apa adanya (tanpa kueri tambahan). Bila situs sedang mengirim challenge ke server Kazanime, bagian ini menampilkan alasannya + tombol Coba Lagi, bukan daftar kosong tanpa keterangan.',
            },
            {
                id: 'donghua',
                label: 'Donghua di AnimeKu',
                source: 'animeku',
                // Tab AnimeKu juga punya bagian ini → "Lihat Semua" menuju ke sana.
                seeAll: 'animeku',
                hint: 'AnimeKu tidak punya kategori donghua (genre donghua 404, negara China kosong), jadi bagian ini hanya berisi judul donghua yang benar-benar ada di pencarian situs — saat ini varian Douluo Dalu. Judul donghua aplikasi lain (Aiyou de Mishi, Aishang Ta de Liyou) tidak ada di AnimeKu.',
            },
            {
                id: 'donghua',
                label: 'Donghua di Oploverz',
                source: 'oploverz',
                seeAll: 'oploverz',
                hint: 'Oploverz tidak memuat donghua sejak 24 Okt 2026 (genres/donghua 404; Perfect World, Soul Land, Battle Through the Heavens, Renegade Immortal → 0 hasil), jadi bagian ini wajar kosong — itu batas situsnya, bukan data yang disembunyikan.',
            },
        ],
    },
]);

const sectionsEl = $('#katalogSections');
const noteEl = $('#katalogNote');
const tabsEl = $('#katalogSourceTabs');
const searchForm = $('#katalogSearch');
const searchInput = $('#katalogSearchInput');
const searchClear = $('#katalogSearchClear');
const genreWrap = $('#katalogGenreWrap');
const genreSelect = $('#katalogGenre');
const yearSelect = $('#katalogYear');
const seasonSelect = $('#katalogSeason');
const titleEl = $('#katalogTitle');
const subtitleEl = $('#katalogSubtitle');

const sourceDef = (id) => SOURCES.find((item) => item.id === id) || SOURCES[0];
const sourceLabel = (id) => sourceDef(id).label;

const readParams = () => {
    const q = new URLSearchParams(window.location.search);
    const source = SOURCES.some((item) => item.id === q.get('source')) ? q.get('source') : SOURCES[0].id;
    // `filter` = "Lihat Semua" untuk satu bagian; hanya bagian yang memang ada di sumber itu.
    const known = new Set(sourceDef(source).sections.map((section) => section.id));
    const filter = known.has(q.get('filter')) ? q.get('filter') : '';
    // `q` = pencarian di dalam sumber (min. 2 karakter, sama seperti validasi backend).
    const keyword = (q.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const query = keyword.length >= 2 ? keyword : '';
    const season = /^(winter|spring|summer|fall)$/.test(String(q.get('season') || '').toLowerCase())
        ? String(q.get('season')).toLowerCase()
        : '';
    const year = /^\d{4}$/.test(String(q.get('year') || '')) ? String(q.get('year')) : '';
    return {
        source,
        genre: (q.get('genre') || '').toLowerCase(),
        filter,
        query,
        year: season ? year : '',
        season: year ? season : '',
    };
};

const initial = readParams();
const state = {
    source: initial.source,
    genre: initial.genre,
    /** Bagian yang dibuka lewat "Lihat Semua" (kosong = semua bagian). */
    filter: initial.filter,
    /** Kata kunci pencarian di dalam sumber (kosong = tampilan bagian biasa). */
    query: initial.query,
    /** Filter tahun & musim (kosong = semua). Hanya Oploverz yang mendukungnya. */
    year: initial.year,
    season: initial.season,
    genres: [],
    seasons: [],
    sections: [],
    loadToken: 0,
};

/** Bagian runtime: data + status muat, bukan bagian dari definisi sumber. */
function makeRuntime(def, index = 0) {
    return {
        def,
        // Kunci DOM unik: beberapa bagian boleh memakai id filter yang sama (mis. lima
        // bagian "donghua" dari sumber berbeda) tanpa saling menimpa.
        key: `${def.id}-${index}`,
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
    if (state.query) q.set('q', state.query);
    else if (state.filter) q.set('filter', state.filter);
    if (state.genre) q.set('genre', state.genre);
    if (state.year) q.set('year', state.year);
    if (state.season) q.set('season', state.season);
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
    if (state.query) {
        const runtime = state.sections[0];
        if (!runtime) return;
        if (!runtime.loaded || (runtime.loading && !runtime.items.length)) {
            setNote(`Mencari “${state.query}” di ${sourceLabel(state.source)}…`);
            return;
        }
        if (runtime.error && !runtime.items.length) {
            setNote(`Pencarian di ${sourceLabel(state.source)} belum bisa dimuat.`, true);
            return;
        }
        setNote(`${runtime.items.length} hasil untuk “${state.query}” di ${sourceLabel(state.source)}`);
        return;
    }
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
    if ((!state.genres.length && !state.seasons.length) || state.query) {
        genreWrap.hidden = true;
        genreSelect.innerHTML = '';
        if (yearSelect) yearSelect.hidden = true;
        if (seasonSelect) seasonSelect.hidden = true;
        return;
    }
    genreWrap.hidden = false;
    genreSelect.innerHTML = String(html`
        <option value=""${state.genre ? '' : ' selected'}>Semua genre</option>
        ${state.genres.map((genre) => html`<option value="${genre.id}"${genre.id === state.genre ? ' selected' : ''}>${genre.label}</option>`)}`);
    // Oploverz punya `season[]` (mis. fall-2026) → tahun dari daftar musim situs.
    // AnimeKu tidak punya musim: kedua pilihan disembunyikan, bukan dibuat tidak berfungsi.
    const years = [...new Set(state.seasons.map((item) => item.year).filter((year) => Number.isInteger(year)))]
        .sort((a, b) => b - a);
    const hasSeasons = years.length > 0;
    if (yearSelect) {
        yearSelect.hidden = !hasSeasons;
        if (hasSeasons) {
            yearSelect.innerHTML = String(html`
                <option value=""${state.year ? '' : ' selected'}>Semua tahun</option>
                ${years.map((year) => html`<option value="${year}"${String(year) === state.year ? ' selected' : ''}>${year}</option>`)}`);
        }
    }
    if (seasonSelect) {
        seasonSelect.hidden = !hasSeasons;
        if (hasSeasons) seasonSelect.value = state.season;
    }
}

/** Judul halaman; mode "Lihat Semua" menampilkan satu bagian + tautan kembali. */
function renderHeader() {
    const def = sourceDef(state.source);
    if (searchInput) {
        searchInput.placeholder = `Cari di ${def.label}…`;
        if (document.activeElement !== searchInput) searchInput.value = state.query;
    }
    if (searchClear) searchClear.hidden = !state.query;
    if (state.query) {
        if (titleEl) titleEl.textContent = `Cari “${state.query}” di ${def.label}`;
        if (subtitleEl) {
            subtitleEl.innerHTML = String(html`<a class="see-all katalog-back" href="${katalogUrl({ source: state.source, genre: state.genre })}">${icon('chevron-left')} Semua bagian</a>
                <span>Hasil pencarian langsung dari halaman cari ${def.label}. Tidak ada klaim Sub Indo sampai episodenya diperiksa.</span>`);
        }
        return;
    }
    const focus = state.filter ? def.sections.find((section) => section.id === state.filter) : null;
    if (titleEl) titleEl.textContent = focus ? `${focus.label} — ${def.label}` : `Jelajah ${def.label}`;
    if (!subtitleEl) return;
    if (focus) {
        subtitleEl.innerHTML = String(html`<a class="see-all katalog-back" href="${katalogUrl({ source: state.source, genre: state.genre })}">${icon('chevron-left')} Semua bagian</a>
            <span>${focus.hint || 'Daftar lengkap bagian ini.'} Tidak ada klaim Sub Indo sampai episodenya diperiksa.</span>`);
        return;
    }
    subtitleEl.textContent = `Bagian tetap: ${def.sections.map((section) => section.label).join(' → ')}. `
        + 'Kartu di sini tidak diklaim Sub Indo sampai episodenya diperiksa.';
}

/** Satu blok bagian (kepala + grid + tombol). */
function sectionHTML(runtime, index) {
    const def = runtime.def;
    return html`
        <section class="katalog-block" data-section="${runtime.key}" aria-labelledby="katalog-block-${index}">
            <div class="katalog-block-head">
                <div class="katalog-block-title">
                    <h3 id="katalog-block-${index}">${def.label}</h3>
                    ${def.hint ? html`<p class="katalog-block-hint">${def.hint}</p>` : ''}
                </div>
                <div class="katalog-block-actions">
                    <span class="katalog-block-count" data-count hidden></span>
                    <a class="see-all" data-see-all href="${katalogUrl({ source: typeof def.seeAll === 'string' ? def.seeAll : state.source, filter: def.id, genre: state.genre })}" hidden>
                        Lihat Semua ${icon('chevron-right')}
                    </a>
                    <button type="button" class="katalog-expand" data-expand aria-expanded="false" hidden>Tampilkan lebih banyak</button>
                </div>
            </div>
            <div class="anime-grid katalog-block-grid" data-grid aria-busy="false"></div>
            <div class="katalog-block-foot" data-foot hidden>
                <button type="button" class="btn-load-more" data-more>Muat Lagi ↓</button>
            </div>
        </section>`;
}

function sectionNode(runtime) {
    return sectionsEl?.querySelector(`[data-section="${runtime.key}"]`) || null;
}

/** Gambar ulang satu bagian sesuai status (cuplikan/daftar penuh/error/kosong). */
function paintSection(runtime) {
    const node = sectionNode(runtime);
    if (!node) return;
    const grid = node.querySelector('[data-grid]');
    const seeAll = node.querySelector('[data-see-all]');
    const expandBtn = node.querySelector('[data-expand]');
    const countEl = node.querySelector('[data-count]');
    const foot = node.querySelector('[data-foot]');
    const moreBtn = node.querySelector('[data-more]');

    // Halaman `?filter=` = daftar penuh; di tampilan biasa tombol Expand membuka sisa judul.
    // Mode pencarian tidak punya halaman berikutnya, jadi tautan "Lihat Semua" disembunyikan.
    const searching = Boolean(state.query);
    const focused = !searching && Boolean(state.filter);
    const expanded = focused || runtime.expanded;
    const visible = expanded ? runtime.items : runtime.items.slice(0, PREVIEW);
    const hasMore = runtime.items.length > PREVIEW || runtime.hasNext;

    if (countEl) {
        countEl.hidden = !runtime.loaded;
        countEl.textContent = runtime.loaded ? `${runtime.items.length}${runtime.hasNext ? '+' : ''} judul` : '';
    }
    if (seeAll) {
        // `seeAll: false` = bagian ini tidak punya halaman "Lihat Semua" (mis. HiAnime/AnimeXin,
        // yang tidak punya tab sendiri di Jelajah).
        seeAll.hidden = runtime.def.seeAll === false || focused || searching || !runtime.loaded || !hasMore;
        seeAll.setAttribute('aria-label', `Lihat semua ${runtime.def.label}`);
    }
    if (expandBtn) {
        expandBtn.hidden = focused || !runtime.loaded || !hasMore;
        expandBtn.textContent = runtime.expanded
            ? 'Tampilkan lebih sedikit'
            : `Tampilkan lebih banyak (${runtime.items.length}${runtime.hasNext ? '+' : ''})`;
        expandBtn.setAttribute('aria-expanded', runtime.expanded ? 'true' : 'false');
    }
    // Muat Lagi muncul saat daftar sudah dibuka penuh (expand atau ?filter=).
    if (foot) foot.hidden = !expanded || !runtime.hasNext;

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
            actions: html`<button type="button" class="btn-ext btn-ext--retry" data-retry="${runtime.key}">Coba Lagi</button>`,
        });
        return;
    }
    if (!runtime.items.length) {
        gridMessage(grid, searching
            ? {
                icon: 'search',
                title: `Tidak ada hasil untuk “${state.query}”`,
                text: `Halaman cari ${sourceLabel(state.source)} tidak mengembalikan judul. Coba kata kunci lain (judul Romaji/Inggris) atau ejaan yang lebih singkat.`,
            }
            : {
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
        // Dua jenis bagian tidak datang dari halaman situs:
        //  - metadata : Coming Soon (AnimeKu/Oploverz tidak punya halaman itu);
        //  - donghua  : rilis donghua dari feed Donghua Kazanime.
        // Keduanya mengembalikan objek Anime yang sudah dinormalisasi.
        const mode = runtime.def.loader || 'browse';
        // Bagian "Donghua" boleh menunjuk sumber lain (HiAnime, AnimeXin, …) selain tab aktif.
        // Tanpa `def.source`, perilakunya sama seperti sebelumnya (mengikuti tab).
        const browseSource = runtime.def.source || state.source;
        // Bagian itu memakai sumber berbeda dari tabnya: genre/tahun/musim tab tidak berlaku di
        // sana (dan filter= donghua di backend memang mengabaikannya), jadi jangan dikirim dan
        // jangan menyerap daftar genre situs lain ke kartu filter tab ini.
        const crossSource = browseSource !== state.source;
        // Auto refresh (24 Okt 2026): kegagalan sementara (timeout/jaringan/5xx/circuit)
        // dicoba sekali lagi sebelum panel menampilkan "Coba Lagi".
        const res = mode === 'metadata'
            ? await withAutoRetry(() => getUpcomingAnime({ page: runtime.page + 1, perPage: PREVIEW * 2 }))
            : mode === 'donghua'
                ? await withAutoRetry(() => browseAnime('donghua', { page: runtime.page + 1 }))
                : await withAutoRetry((attempt) => getSourceBrowse(browseSource, {
                    // Saat mencari, id bagian sintetis ("hasil") bukan filter situs — jangan dikirim.
                    filter: state.query ? '' : runtime.def.id,
                    genre: crossSource ? '' : state.genre,
                    year: crossSource ? '' : state.year,
                    season: crossSource ? '' : state.season,
                    q: state.query,
                    page: runtime.page + 1,
                    // "Coba Lagi" melewati cache + circuit breaker frontend, sama seperti panel beranda.
                    refresh: refresh || attempt > 1,
                }), {
                    // Catatan di atas daftar: pengguna tahu bagian ini sedang dicoba ulang.
                    onRetry: () => setNote('Jaringan lambat — mencoba sekali lagi…'),
                });
        if (token !== runtime.token || sourceToken !== state.loadToken) return;
        const paged = mode !== 'browse';
        runtime.page = paged ? runtime.page + 1 : res.page;
        runtime.hasNext = Boolean(res.hasNext);
        runtime.loaded = true;
        runtime.error = paged && !res.items.length && res.error ? friendlyError(res.error) : '';
        if (!paged && !crossSource && (res.genres.length || res.seasons.length)) {
            const grew = (res.genres.length && !state.genres.length) || (res.seasons.length && !state.seasons.length);
            if (res.genres.length) state.genres = res.genres;
            if (res.seasons.length) state.seasons = res.seasons;
            if (grew) renderGenre();
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
            const runtime = state.sections.find((item) => item.key === entry.target.dataset.section);
            if (runtime && !runtime.loaded && !runtime.loading) loadSection(runtime);
            observer.unobserve(entry.target);
        }
    }, { rootMargin: '400px 0px' })
    : null;

function buildSections() {
    if (!sectionsEl) return;
    const source = sourceDef(state.source);
    const defs = state.query
        ? [{
            id: 'hasil',
            label: `Hasil untuk “${state.query}”`,
            hint: `Ditemukan lewat pencarian ${source.label}. Klik kartu untuk membuka detail; tidak ada klaim Sub Indo di sini.`,
        }]
        : source.sections;
    const focused = state.filter ? defs.filter((section) => section.id === state.filter) : defs;
    state.sections = (focused.length ? focused : defs).map((def, index) => makeRuntime(def, index));
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
    state.filter = '';
    state.year = '';
    state.season = '';
    state.genres = [];
    state.seasons = [];
    // Kata kunci dipertahankan: mengganti tab = mencari kata yang sama di sumber lain.
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
    state.query = '';
    state.loadToken += 1;
    renderHeader();
    renderGenre();
    syncUrl();
    buildSections();
}

/**
 * Terapkan kata kunci pencarian: URL + header + blok hasil. `q` kosong = kembali
 * ke tampilan bagian biasa. Dipakai form, tombol hapus, dan tombol Enter.
 */
function applyQuery(value) {
    const next = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (next === state.query) return;
    state.query = next.length >= 2 ? next : '';
    state.filter = '';
    state.loadToken += 1;
    renderHeader();
    renderGenre();
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

if (searchForm && searchInput) {
    searchForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = searchInput.value.trim();
        if (value.length < 2) {
            searchInput.setCustomValidity('Kata kunci minimal 2 karakter.');
            searchInput.reportValidity();
            return;
        }
        searchInput.setCustomValidity('');
        applyQuery(value);
    });
    searchInput.addEventListener('input', () => searchInput.setCustomValidity(''));
    if (searchClear) {
        searchClear.addEventListener('click', () => {
            searchInput.value = '';
            applyQuery('');
            searchInput.focus();
        });
    }
}

if (genreSelect) {
    genreSelect.addEventListener('change', () => switchGenre(genreSelect.value));
}

/** Tahun/musim mengubah hasil: muat ulang semua bagian sumber yang sedang aktif. */
function applySeasonFilters() {
    state.loadToken += 1;
    renderGenre();
    syncUrl();
    buildSections();
}

yearSelect?.addEventListener('change', () => {
    state.year = yearSelect.value;
    if (!state.year) state.season = '';
    applySeasonFilters();
});
seasonSelect?.addEventListener('change', () => {
    state.season = seasonSelect.value;
    applySeasonFilters();
});

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
        const runtime = state.sections.find((item) => item.key === button.dataset.retry);
        if (runtime) loadSection(runtime, { reset: true, refresh: true });
    });
    bindCardActions(sectionsEl, (anime) => ctx.toggleBookmark(anime));
    onBookmarksChange(() => syncBookmarkButtons(isBookmarked, sectionsEl));
}
