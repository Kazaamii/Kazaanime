/**
 * Kazanime — home.js (entry point index.html)
 *
 * Merangkai homepage dari komponen UI + facade data (js/api/index.js).
 * Tidak ada fetch di sini; semua data datang sebagai objek Anime.
 *
 * Alur:
 *  1. initLayout()  → navbar, footer, modal, autocomplete, status API, auth.
 *  2. Hero + section metadata diminta bersamaan. Di AniList semuanya berasal dari
 *     SATU query gabungan (request dipakai bersama, di-cache 15 menit).
 *     Jika AniList gagal → Kitsu → data cadangan statis (+ keterangan
 *     & tombol "Coba lagi").
 *     Donghua (Tahap D): rilis terbaru dari backend scraper lebih dulu.
 *     Anime Jepang Sub Indo memakai feed backend terpisah per situs, tanpa merge.
 *  3. Jadwal dimuat hanya saat section-nya mendekati layar (lazy).
 *  4. Bookmark/login mengubah tombol & section Bookmark tanpa request jaringan.
 */
import { initLayout } from './ui/layout.js';
import { createHeroSlider } from './ui/hero.js';
import { renderCards, bindCardActions, syncBookmarkButtons, gridMessage } from './ui/card.js';
import { renderSchedule, renderScheduleSkeleton } from './ui/schedule.js';
import { setSectionNote } from './ui/notice.js';
import { showSkeleton, skeletonCards } from './ui/skeleton.js';
import { html, $, delegate } from './ui/dom.js';
import { GENRES, SCHEDULE, SUB_INDO } from './config.js';
import { genreUrl, watchUrl, latestEpisodeOf, katalogUrl } from './routes.js';
import {
    getHeroSlides, getHomeSection, getSubIndoHomeSources, getGenreAnime, getWeeklySchedule, wibWeekday, friendlyError, retrySourcesNow,
} from './api/index.js';
import { onBookmarksChange } from './services/bookmark.js';
import { icon } from './ui/icons.js';
import { isPolicyStop, safeHomeUrl, sourceDiagnosis, sourceStatusLabel } from './ui/subindo-state.js';
import { panelSections } from './api/subindo.js';
import { withAutoRetry } from './api/retry.js';
import { getSourceBrowse } from './api/sources.js';

const ctx = initLayout();
const isBookmarked = (anime) => ctx.isBookmarked(anime);
const main = $('#main');
const smooth = () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */
const hero = createHeroSlider($('#hero'), {
    isBookmarked,
    onBookmark: (anime) => ctx.toggleBookmark(anime),
});
getHeroSlides()
    .then((res) => hero.setSlides(res.items))
    .catch(() => hero.setSlides([]));

/* ------------------------------------------------------------------ */
/* Section daftar anime                                                */
/* ------------------------------------------------------------------ */
const GRIDS = {
    ongoing: $('#ongoingGrid'),
    popular: $('#popularGrid'),
    recent: $('#newReleaseGrid'),
    donghua: $('#donghuaGrid'),
};
const subIndoRoot = $('#subindoSources');
const subIndoRefreshBtn = $('#subIndoRefresh');
let subIndoLoadToken = 0;
/** Hasil terakhir supaya tombol "Coba lagi" per panel bisa memperbarui satu sumber saja. */
let subIndoState = null;
/** Kapan panel Sub Indo terakhir benar-benar berhasil dimuat (untuk auto refresh). */
let subIndoLastOkAt = 0;
/**
 * Salinan hasil terakhir di localStorage (24 Okt 2026). Kalau feed live gagal
 * (jaringan mobile lambat/timeout), panel tetap terisi judul — bukan kotak kosong.
 */
const SUB_INDO_CACHE_KEY = 'kz:subindo-last';

function readSubIndoCache() {
    try {
        const raw = window.localStorage.getItem(SUB_INDO_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.sections) || !parsed.sections.length) return null;
        return parsed;
    } catch {
        return null; // localStorage diblokir / isinya rusak
    }
}

function writeSubIndoCache(sections) {
    try {
        const slim = (Array.isArray(sections) ? sections : [])
            .map((source) => ({
                id: source.id,
                name: source.name,
                homeUrl: source.homeUrl,
                browse: Boolean(source.browse),
                total: Number(source.total) || (source.items || []).length,
                items: (Array.isArray(source.items) ? source.items : []).slice(0, SUB_INDO.resultLimit),
            }))
            .filter((source) => source.items.length);
        if (!slim.length) return;
        window.localStorage.setItem(SUB_INDO_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), sections: slim }));
    } catch {
        // Mode privat / kuota penuh: cache dilewati, tidak mengganggu render.
    }
}

async function loadSection(kind) {
    const grid = GRIDS[kind];
    showSkeleton(grid);
    setSectionNote(grid);
    const res = await getHomeSection(kind);
    // "Baru Rilis" & donghua dari backend (rilis terbaru AnimeXin/Anichin): kartu langsung membuka
    // episode yang baru tayang (label kartu "EP 9" → episode 9)
    const toLatest = kind === 'recent' || (kind === 'donghua' && res.source === 'backend');
    renderCards(grid, res.items, { isBookmarked, episodeOf: toLatest ? latestEpisodeOf : undefined });
    if (res.fallback) {
        setSectionNote(grid, {
            text: `Menampilkan data cadangan. ${friendlyError(res.error)}`,
            onRetry: () => {
                retrySourcesNow();
                loadSection(kind);
            },
        });
    }
}

// Panel Sub Indo: katalog langsung dari situs, tanpa verifikasi episode (24 Okt 2026).
// Cuplikan 6 kartu dulu; tombol "Tampilkan lebih banyak" membuka sisa judul dari situs itu.
const SUB_INDO_HOME_LIMIT = SUB_INDO.previewLimit;
const subIndoStatus = $('#subIndoStatus');
/** Panel yang sedang dibuka penuh. */
const subIndoExpanded = new Set();

/** Ringkasan kecil di bawah intro: situs dan jumlah judul yang tampil. */
function renderSubIndoSummary(sources) {
    const list = Array.isArray(sources) ? sources : [];
    if (!subIndoStatus) return;
    if (!list.length) {
        subIndoStatus.textContent = 'Tidak ada sumber Sub Indo yang aktif.';
        return;
    }
    const total = list.reduce((sum, source) => sum + (Array.isArray(source.items) ? source.items.length : 0), 0);
    // Nama situs cukup di status: paragraf intro dihapus 24 Okt 2026 (permintaan pengguna).
    subIndoStatus.textContent = `${list.map((source) => source.name).join(' · ')} — ${list.length} situs · ${total} judul`;
}

/**
 * Panel tanpa judul: satu baris ringkas (ikon + diagnosis + tindakan) menggantikan
 * kotak kosong besar. Tautan "Buka situs" hanya membuka situs di tab baru — tidak ada
 * upaya menembus pembatasan otomatis.
 */
function renderSubIndoEmpty(grid, source) {
    const policyStop = isPolicyStop(source);
    const homeUrl = safeHomeUrl(source.homeUrl);
    const iconName = policyStop ? 'lock' : source.error ? 'triangle-alert' : 'inbox';
    grid.innerHTML = String(html`
        <p class="subindo-empty${policyStop ? ' is-policy' : ''}">
            <span class="subindo-empty-icon" aria-hidden="true">${icon(iconName)}</span>
            <span class="subindo-empty-text">${sourceDiagnosis(source)}</span>
            <span class="subindo-empty-actions">
                ${homeUrl ? html`<a class="subindo-empty-link" href="${homeUrl}" target="_blank" rel="noopener noreferrer">${icon('external-link')} Buka situs</a>` : ''}
                ${source.error ? html`<button type="button" class="subindo-retry" data-action="retry-subindo-source" data-source="${source.id}">${icon('refresh-cw')} Coba lagi</button>` : ''}
            </span>
        </p>`);
    grid.setAttribute('aria-busy', 'false');
}

/** Render semua panel sumber + kartu di dalamnya. */
function renderSubIndoSources(sources) {
    const list = Array.isArray(sources) ? sources : [];
    subIndoRoot.setAttribute('aria-busy', 'false');
    renderSubIndoSummary(list);
    if (!list.length) {
        gridMessage(subIndoRoot, {
            icon: 'inbox',
            title: 'Belum ada sumber Sub Indo aktif',
            text: 'Aktifkan sumber rilis Sub Indo di konfigurasi backend untuk menampilkan daftar per situs.',
        });
        return;
    }

    subIndoRoot.innerHTML = String(html`${list.map((source, index) => {
        const all = Array.isArray(source.items) ? source.items : [];
        const expanded = subIndoExpanded.has(source.id);
        const canExpand = all.length > SUB_INDO_HOME_LIMIT;
        const trouble = Boolean(source.error);
        const status = sourceStatusLabel(source, all.length);
        return html`
            <section class="subindo-source${all.length ? '' : ' is-empty'}" data-subindo-source="${source.id}" aria-labelledby="subindo-source-title-${index}">
                <div class="subindo-source-header">
                    <h3 id="subindo-source-title-${index}">${source.name}</h3>
                    <span class="subindo-source-count ${trouble || source.stale ? 'is-stale' : ''}">${status}</span>
                    ${source.browse ? html`<a class="see-all subindo-source-more" href="${katalogUrl({ source: source.id })}">Lihat Semua ${icon('chevron-right')}</a>` : ''}
                </div>
                ${source.browse ? html`<form class="subindo-search" data-subindo-search="${source.id}" role="search" autocomplete="off">
                    <label class="sr-only" for="subindo-search-${index}">Cari di ${source.name}</label>
                    <input id="subindo-search-${index}" type="search" name="q" class="subindo-search-input"
                        placeholder="Cari di ${source.name}…" minlength="2" maxlength="100" enterkeyhint="search">
                    <button type="submit" class="subindo-search-btn" aria-label="Cari di ${source.name}">${icon('search')}</button>
                </form>` : ''}
                ${trouble && all.length ? html`<p class="subindo-source-warning">${friendlyError(source.error)}${source.stale ? ' Menampilkan cache.' : ''}
                    <button type="button" class="subindo-retry" data-action="retry-subindo-source" data-source="${source.id}">${icon('refresh-cw')} Coba lagi</button>
                </p>` : ''}
                <div class="anime-grid" data-subindo-source-grid="${source.id}" aria-busy="false"></div>
                ${canExpand ? html`<div class="subindo-source-foot">
                    <button type="button" class="btn-load-more subindo-expand" data-action="expand-subindo-source" data-source="${source.id}" aria-expanded="${expanded ? 'true' : 'false'}">
                        ${expanded ? 'Tampilkan lebih sedikit' : `Tampilkan lebih banyak (${all.length})`}
                    </button>
                </div>` : ''}
            </section>`;
    })}`);

    list.forEach((source) => {
        const grid = [...subIndoRoot.querySelectorAll('[data-subindo-source-grid]')]
            .find((element) => element.dataset.subindoSourceGrid === source.id);
        if (!grid) return;
        const all = Array.isArray(source.items) ? source.items : [];
        const items = subIndoExpanded.has(source.id) ? all : all.slice(0, SUB_INDO_HOME_LIMIT);
        if (items.length) {
            renderCards(grid, items, { variant: 'source', isBookmarked, episodeOf: latestEpisodeOf });
        } else {
            renderSubIndoEmpty(grid, source);
        }
    });
}

async function loadSubIndoSection({ refresh = false, retry = true, quiet = false } = {}) {
    const token = ++subIndoLoadToken;
    // `quiet` = muat ulang otomatis saat panel SUDAH terisi: layar tidak dikosongkan,
    // hasil baru menggantikan setelah datang (24 Okt 2026).
    if (!quiet || !subIndoState) {
        // Status teks selalu terlihat (termasuk di layar kecil) supaya bagian ini tidak
        // pernah tampil "kosong" tanpa penjelasan saat jaringan lambat.
        if (subIndoStatus && !subIndoState) subIndoStatus.textContent = 'Memuat katalog AnimeKu & Oploverz…';
        showSkeleton(subIndoRoot, 4);
        setSectionNote(subIndoRoot);
    }
    try {
        const result = await getSubIndoHomeSources({ refresh });
        if (token !== subIndoLoadToken) return;
        const sections = panelSections(result.sections);
        if (!sections.length) throw new Error('Backend tidak mengirim panel Sub Indo.');
        subIndoState = { sections };
        subIndoLastOkAt = Date.now();
        autoRetryStreak = 0;
        writeSubIndoCache(sections);
        renderSubIndoSources(sections);
        updateSubIndoNote(sections);
        // Sebagian situs gagal (bukan gagal total): beri kesempatan muat ulang otomatis.
        if (sections.every((source) => source.error || source.stale)) scheduleAutoRefresh();
    } catch (error) {
        if (token !== subIndoLoadToken || error?.kind === 'abort') return;
        // Jaringan ponsel sering putus sebentar: satu percobaan ulang otomatis sebelum
        // menyerah ke cache/pesan error. Status tetap terlihat selama percobaan ini.
        if (retry && (error?.kind === 'timeout' || error?.kind === 'network')) {
            if (subIndoStatus) subIndoStatus.textContent = 'Jaringan lambat — mencoba sekali lagi…';
            await new Promise((resolve) => setTimeout(resolve, 800));
            if (token !== subIndoLoadToken) return;
            return loadSubIndoSection({ refresh: true, retry: false, quiet });
        }
        // Muat ulang latar (auto refresh) gagal padahal panel sudah terisi: biarkan yang tampil,
        // cukup beri catatan + tombol coba lagi. Panel tidak boleh berubah jadi kotak kosong.
        if (quiet && subIndoState?.sections?.some((source) => source.items?.length)) {
            setSectionNote(subIndoRoot, {
                text: `Katalog live belum bisa dimuat (${friendlyError(error)}). Data yang tampil berasal dari permintaan sebelumnya.`,
                onRetry: () => loadSubIndoSection({ refresh: true }),
            });
            scheduleAutoRefresh();
            return;
        }
        // Fallback: hasil sukses terakhir dari perangkat ini (mobile sering timeout).
        const cached = readSubIndoCache();
        if (cached?.sections?.length) {
            const sections = cached.sections.map((source) => ({ ...source, error: null, stale: true }));
            subIndoState = { sections };
            renderSubIndoSources(sections);
            const when = cached.savedAt
                ? new Date(cached.savedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
                : '';
            setSectionNote(subIndoRoot, {
                text: `Katalog live belum bisa dimuat (${friendlyError(error)}). Menampilkan data tersimpan${when ? ` dari ${when}` : ''}.`,
                onRetry: () => loadSubIndoSection({ refresh: true }),
            });
            scheduleAutoRefresh();
            return;
        }
        subIndoState = null;
        renderSubIndoSummary([]);
        gridMessage(subIndoRoot, {
            icon: 'triangle-alert',
            title: 'Daftar Sub Indo belum tersedia',
            text: friendlyError(error),
            actions: html`<button type="button" class="btn-ext btn-ext--retry" data-action="retry-subindo">${icon('refresh-cw')} Coba Lagi</button>`,
        });
        scheduleAutoRefresh();
    }
}

/** Tombol "Muat ulang" global di kepala bagian: ambil ulang katalog tanpa cache. */
async function refreshSubIndoSection() {
    if (subIndoRefreshBtn?.disabled) return;
    if (subIndoRefreshBtn) {
        subIndoRefreshBtn.disabled = true;
        subIndoRefreshBtn.classList.add('is-busy');
        subIndoRefreshBtn.setAttribute('aria-busy', 'true');
    }
    retrySourcesNow();
    autoRetryStreak = 0;
    try {
        await loadSubIndoSection({ refresh: true, retry: false });
    } finally {
        if (subIndoRefreshBtn) {
            subIndoRefreshBtn.disabled = false;
            subIndoRefreshBtn.classList.remove('is-busy');
            subIndoRefreshBtn.removeAttribute('aria-busy');
        }
    }
}

/**
 * Catatan global di bawah panel: sebab kegagalan jaringan/kebijakan yang sama
 * digabung sekali (mis. "challenge keamanan" untuk dua situs).
 */
function updateSubIndoNote(sections) {
    const groups = new Map();
    (Array.isArray(sections) ? sections : []).forEach((source) => {
        if (!source?.error) return;
        const message = friendlyError(source.error);
        const names = groups.get(message) || [];
        names.push(String(source.name || source.id || 'sumber'));
        groups.set(message, names);
    });
    if (!groups.size) {
        setSectionNote(subIndoRoot);
        return;
    }
    const text = `Penyebab: ${[...groups].map(([message, names]) => `${message} (${names.join(', ')})`).join(' · ')}`;
    setSectionNote(subIndoRoot, {
        text,
        onRetry: () => {
            retrySourcesNow();
            loadSubIndoSection({ refresh: true });
        },
    });
}

delegate(subIndoRoot, 'click', '[data-action="retry-subindo"]', () => {
    refreshSubIndoSection();
});

subIndoRefreshBtn?.addEventListener('click', () => {
    refreshSubIndoSection();
});

/** Buka/tutup sisa judul satu panel (tanpa request baru: semua sudah dimuat). */
/**
 * Pencarian di dalam satu situs (24 Okt 2026): panel beranda hanya mengirim kata kunci
 * ke halaman Jelajah dengan tab sumber itu — hasil lengkap dirender di sana.
 */
delegate(subIndoRoot, 'submit', '[data-subindo-search]', (event, form) => {
    event.preventDefault();
    const id = String(form.dataset.subindoSearch || '').toLowerCase();
    const input = form.querySelector('input[name="q"]');
    const value = String(input?.value || '').replace(/\s+/g, ' ').trim();
    if (!id || value.length < 2) {
        if (input) {
            input.setCustomValidity('Kata kunci minimal 2 karakter.');
            input.reportValidity();
        }
        return;
    }
    if (input) input.setCustomValidity('');
    window.location.href = katalogUrl({ source: id, q: value });
});

delegate(subIndoRoot, 'input', 'input[name="q"]', (event, input) => input.setCustomValidity(''));

delegate(subIndoRoot, 'click', '[data-action="expand-subindo-source"]', (event, button) => {
    const id = String(button.dataset.source || '').toLowerCase();
    if (!id || !subIndoState) return;
    if (subIndoExpanded.has(id)) subIndoExpanded.delete(id);
    else subIndoExpanded.add(id);
    renderSubIndoSources(subIndoState.sections);
});

/**
 * Coba lagi SATU panel sumber: katalog situs itu diambil ulang tanpa cache;
 * panel lain tetap memakai hasil yang sudah ada.
 */
async function retrySubIndoSource(sourceId) {
    const id = String(sourceId || '').trim().toLowerCase();
    if (!id || !subIndoState) {
        retrySourcesNow();
        loadSubIndoSection({ refresh: true });
        return;
    }
    const grid = [...subIndoRoot.querySelectorAll('[data-subindo-source-grid]')]
        .find((element) => element.dataset.subindoSourceGrid === id);
    if (grid) showSkeleton(grid, 4);
    retrySourcesNow();
    try {
        const result = await getSubIndoHomeSources({ sourceIds: [id], refresh: true });
        const updated = panelSections(result.sections).find((source) => source.id === id);
        if (!updated) {
            // Sumber tidak lagi ada di feed backend: kembalikan panel lama, jangan biarkan skeleton.
            if (subIndoState) renderSubIndoSources(subIndoState.sections);
            return;
        }
        if (!subIndoState) return;
        subIndoState = {
            ...subIndoState,
            sections: subIndoState.sections.map((source) => (source.id === id ? updated : source)),
        };
        renderSubIndoSources(subIndoState.sections);
        updateSubIndoNote(subIndoState.sections);
    } catch (error) {
        if (error?.kind === 'abort') return;
        if (grid) {
            gridMessage(grid, {
                icon: 'triangle-alert',
                title: 'Gagal memuat ulang sumber',
                text: friendlyError(error),
            });
        }
    }
}

delegate(subIndoRoot, 'click', '[data-action="retry-subindo-source"]', (event, button) => {
    retrySubIndoSource(button.dataset.source);
});

/* ------------------------------------------------------------------ */
/* Genre — di bagian atas beranda (22 Okt 2026). Hasil tampil LANGSUNG  */
/* di bawah tombol genre (dulu memfilter section Populer yang kini      */
/* letaknya jauh di bawah). Klik genre aktif / tombol tutup = sembunyi. */
/* ------------------------------------------------------------------ */
const genreBox = $('#genreTags');
const genreResults = $('#genreResults');
const genreGrid = $('#genreGrid');
const genreTitle = $('#genreResultsTitle');
const genreSeeAll = $('#genreSeeAll');
const genreYear = $('#genreYear');
const genreSeason = $('#genreSeason');
const genreSort = $('#genreSort');
const genreReset = $('#genreFilterReset');
/**
 * Filter aktif: genre (label AniList), tahun, musim (winter/spring/summer/fall), urutan.
 *
 * 24 Okt 2026 (putaran 8) — genre AnimeKu/Animeloverz tidak lagi dimuat di beranda
 * (permintaan pengguna: "hapus Genre dari Animeloverz ... dan Animeku, muncul hanya di
 * halaman katalog saja"). Beranda hanya menampilkan chip genre AniList; genre per situs
 * ada di katalog.html yang sudah punya pemilih genre sendiri.
 */
const genreState = {
    genre: '', year: '', season: '', sort: 'popularity', token: 0,
};

const SEASON_LABELS = { winter: 'Winter', spring: 'Spring', summer: 'Summer', fall: 'Fall' };
const CURRENT_YEAR = new Date().getFullYear();
const FIRST_YEAR = 1990;

genreBox.innerHTML = String(html`${GENRES.map((g) => html`<button type="button" class="genre-tag" data-genre="${g.label}" aria-pressed="false" aria-controls="genreResults">${g.label}</button>`)}`);

/** Tahun: tahun depan (anime musim dingin diumumkan lebih awal) sampai 1990. */
if (genreYear) {
    const years = [];
    for (let year = CURRENT_YEAR + 1; year >= FIRST_YEAR; year -= 1) years.push(year);
    genreYear.innerHTML = String(html`<option value="">Semua tahun</option>${years.map((year) => html`<option value="${year}">${year}</option>`)}`);
}

function updateGenreReset() {
    if (!genreReset) return;
    genreReset.hidden = !(genreState.year || genreState.season || genreState.sort !== 'popularity');
}

function genreFilterLabel() {
    const bits = [];
    if (genreState.year) bits.push(genreState.year);
    if (genreState.season) bits.push(SEASON_LABELS[genreState.season] || genreState.season);
    if (genreState.sort === 'score') bits.push('rating tertinggi');
    else if (genreState.sort === 'newest') bits.push('terbaru');
    return bits.join(' · ');
}

/** Kunci genre untuk tombol: `sumber:token` (situs) atau label (AniList). */
const tagKey = (tag) => tag.dataset.genre || '';

/** Tombol genre AniList di beranda (genre situs ada di <select>, bukan tombol). */
function genreTagNodes() {
    return [...genreBox.querySelectorAll('.genre-tag')];
}

/** Tandai chip AniList yang aktif. */
function markGenre(key) {
    genreTagNodes().forEach((tag) => {
        const on = tagKey(tag) === key;
        tag.classList.toggle('active', on);
        tag.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function closeGenre() {
    genreState.genre = '';
    genreState.token++;
    markGenre('');
    genreResults.hidden = true;
    genreGrid.innerHTML = '';
}

/** Hasil genre di bawah tombol: gulir sedikit bila bagian bawahnya di luar layar. */
function revealGenreResults() {
    const r = genreResults.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.75) genreResults.scrollIntoView({ behavior: smooth(), block: 'nearest' });
}

/**
 * Ambil & render satu genre dengan filter Tahun/Musim/Urutan yang sedang aktif.
 * @param {string} genre label genre (mis. "Action")
 */
async function selectGenre(genre, { keepOpen = false } = {}) {
    if (!genre || (!keepOpen && genre === genreState.genre)) {
        closeGenre();
        return;
    }
    markGenre(genre);
    genreState.genre = genre;
    const token = ++genreState.token;
    const extra = genreFilterLabel();
    genreTitle.textContent = extra ? `Genre: ${genre} · ${extra}` : `Genre: ${genre}`;
    genreSeeAll.href = genreUrl(genre);
    genreResults.hidden = false;
    showSkeleton(genreGrid);
    revealGenreResults();

    const res = await getGenreAnime(genre, {
        year: genreState.year,
        season: genreState.season,
        sort: genreState.sort,
    });
    if (token !== genreState.token) return; // klik genre lain / ditutup sebelum selesai
    if (res.items.length) {
        renderCards(genreGrid, res.items, { isBookmarked });
        if (res.fallback) setSectionNote(genreGrid, { text: `Menampilkan data cadangan. ${friendlyError(res.error)}` });
        else setSectionNote(genreGrid);
    } else if (res.error && res.error.kind !== 'empty') {
        gridMessage(genreGrid, {
            icon: 'triangle-alert',
            title: 'Gagal memuat genre',
            text: friendlyError(res.error),
            actions: html`<button type="button" class="btn-ext btn-ext--retry" data-action="retry-genre">${icon('refresh-cw')} Coba Lagi</button>`,
        });
    } else {
        const filters = genreFilterLabel();
        gridMessage(genreGrid, {
            icon: 'inbox',
            text: filters
                ? `Tidak ada anime genre "${genre}" untuk filter ${filters}. Coba tahun/musim lain.`
                : `Tidak ada anime dengan genre "${genre}"`,
        });
    }
}

/* Genre situs (AnimeKu/Animeloverz) sengaja TIDAK dimuat di beranda — hanya di
 * katalog.html yang punya pemilih genre per sumber (24 Okt 2026, putaran 8). */

/** Perubahan filter: muat ulang genre yang sedang terbuka (bila ada). */
function applyGenreFilters() {
    updateGenreReset();
    if (!genreState.genre) return;
    selectGenre(genreState.genre, { keepOpen: true });
}

function handleGenreTag(tag) {
    if (!tag) return;
    selectGenre(tag.dataset.genre || '');
}

delegate(genreBox, 'click', '.genre-tag', (_e, tag) => handleGenreTag(tag));


$('#genreClose').addEventListener('click', closeGenre);
genreYear?.addEventListener('change', () => {
    genreState.year = genreYear.value;
    applyGenreFilters();
});
genreSeason?.addEventListener('change', () => {
    genreState.season = genreSeason.value;
    applyGenreFilters();
});
genreSort?.addEventListener('change', () => {
    genreState.sort = genreSort.value || 'popularity';
    applyGenreFilters();
});
genreReset?.addEventListener('click', () => {
    genreState.year = '';
    genreState.season = '';
    genreState.sort = 'popularity';
    if (genreYear) genreYear.value = '';
    if (genreSeason) genreSeason.value = '';
    if (genreSort) genreSort.value = 'popularity';
    applyGenreFilters();
});
delegate(genreGrid, 'click', '[data-action="retry-genre"]', () => {
    retrySourcesNow();
    selectGenre(genreState.genre, { keepOpen: true });
});

// Genre situs tidak ada di beranda (putaran 8): pemilih genre AnimeKu/Animeloverz
// hanya ada di katalog.html.

/* ------------------------------------------------------------------ */
/* Donghua dari situs sumber: AnimeKu & Oploverz (24 Okt 2026)         */
/* Permintaan pengguna: "tambahkan Data Donghua dari kedua itu di      */
/* Oploverz dan AnimeKu, jangan AniList saja". Panel di atas grid       */
/* metadata; grid AniList tetap jadi pelengkap untuk judul yang belum   */
/* ada di kedua situs.                                                 */
/* ------------------------------------------------------------------ */
const donghuaSites = $('#donghuaSites');
const donghuaNote = $('#donghuaNote');
const donghuaRefreshBtn = $('#donghuaRefresh');
const DONGHUA_SITE_IDS = ['animeku', 'oploverz'];
const DONGHUA_SITE_LABELS = { animeku: 'AnimeKu', oploverz: 'Oploverz' };
const DONGHUA_SITE_LIMIT = 12;
/**
 * Cadangan hasil sukses terakhir (24 Okt 2026). Auto refresh boleh gagal berkali-kali,
 * tetapi bagian Donghua tidak boleh berubah jadi kotak kosong di layar pengguna.
 */
const DONGHUA_CACHE_KEY = 'kz:donghua-last';
let donghuaLoadToken = 0;
/** Hasil terakhir yang tampil di layar (dipakai saat muat ulang latar / coba lagi). */
let donghuaState = null;
/** Kapan salah satu panel terakhir berhasil dimuat (untuk auto refresh). */
let donghuaLastOkAt = 0;
/** true setelah bagian ini diminta tampil; auto refresh tidak boleh memuat lebih awal. */
let donghuaStarted = false;

function readDonghuaCache() {
    try {
        const raw = window.localStorage.getItem(DONGHUA_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.panels)) return null;
        const panels = parsed.panels
            .filter((panel) => panel && typeof panel.id === 'string' && Array.isArray(panel.items) && panel.items.length)
            .map((panel) => ({
                id: panel.id,
                name: panel.name || DONGHUA_SITE_LABELS[panel.id] || panel.id,
                items: panel.items.slice(0, DONGHUA_SITE_LIMIT),
                error: null,
            }));
        return panels.length ? { savedAt: Number(parsed.savedAt) || 0, panels } : null;
    } catch {
        return null; // localStorage diblokir / isinya rusak
    }
}

function writeDonghuaCache(panels) {
    try {
        const slim = (Array.isArray(panels) ? panels : [])
            .filter((panel) => panel && Array.isArray(panel.items) && panel.items.length)
            .map((panel) => ({ id: panel.id, name: panel.name, items: panel.items.slice(0, DONGHUA_SITE_LIMIT) }));
        if (!slim.length) return;
        window.localStorage.setItem(DONGHUA_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), panels: slim }));
    } catch {
        // Mode privat / kuota penuh: cache dilewati, tidak mengganggu render.
    }
}

function setDonghuaNote(text, { retry = false } = {}) {
    if (!donghuaNote) return;
    if (!text) {
        donghuaNote.textContent = '';
        return;
    }
    if (!retry) {
        donghuaNote.textContent = text;
        return;
    }
    donghuaNote.innerHTML = String(html`${text} <button type="button" class="donghua-retry" data-action="retry-donghua">${icon('refresh-cw')} Coba lagi</button>`);
    donghuaNote.querySelector('[data-action="retry-donghua"]')?.addEventListener('click', () => {
        void refreshDonghuaSites();
    }, { once: true });
}

/** Panel donghua satu situs: kepala ringkas + grid kartu dari katalog situs itu. */
function renderDonghuaPanels(panels) {
    if (!donghuaSites) return;
    const filled = panels.filter((panel) => panel.items.length);
    if (!filled.length) {
        donghuaSites.innerHTML = '';
        const failed = panels.some((panel) => panel.error);
        setDonghuaNote(
            failed
                ? 'Donghua dari AnimeKu & Oploverz belum bisa dimuat. Daftar di bawah memakai metadata AniList.'
                : 'Belum ada judul donghua di katalog AnimeKu & Oploverz saat ini. Daftar di bawah memakai metadata AniList.',
            { retry: failed },
        );
        return;
    }
    donghuaSites.innerHTML = String(html`${filled.map((source) => html`
        <section class="subindo-source donghua-site" data-donghua-source="${source.id}">
            <div class="subindo-source-header">
                <h3>${source.name}</h3>
                <span class="subindo-source-count">${source.items.length} judul</span>
                <a class="see-all subindo-source-more" href="${katalogUrl({ source: source.id, filter: 'donghua' })}">Lihat Semua ${icon('chevron-right')}</a>
            </div>
            <div class="anime-grid" data-donghua-grid="${source.id}" aria-busy="false"></div>
        </section>`)}`);
    filled.forEach((source) => {
        const grid = donghuaSites.querySelector(`[data-donghua-grid="${source.id}"]`);
        renderCards(grid, source.items, { variant: 'source', isBookmarked, episodeOf: latestEpisodeOf });
    });
    const missing = panels
        .filter((panel) => !panel.items.length)
        .map((panel) => (panel.error ? `${panel.name} gagal dimuat` : `Donghua ${panel.name} belum ada di katalognya`));
    const note = missing.length
        ? `${missing.join(' · ')}. Daftar di bawah dari metadata AniList.`
        : 'Donghua tayang dari katalog AnimeKu & Oploverz. Daftar di bawah dari metadata AniList sebagai pelengkap.';
    // Situs yang gagal tetap bisa dicoba lagi tanpa menunggu halaman dimuat ulang.
    setDonghuaNote(note, { retry: panels.some((panel) => panel.error && !panel.items.length) });
}

/**
 * Satu panel situs dengan percobaan ulang otomatis (24 Okt 2026).
 * Percobaan kedua memakai `refresh` supaya circuit breaker yang baru terbuka akibat
 * timeout tadi tidak langsung menolak permintaan ulang.
 */
async function fetchDonghuaPanel(id, { refresh = false, retry = true } = {}) {
    const name = DONGHUA_SITE_LABELS[id] || id;
    try {
        const res = await withAutoRetry(
            (attempt) => getSourceBrowse(id, { filter: 'donghua', refresh: refresh || attempt > 1 }),
            {
                attempts: retry ? 2 : 1,
                onRetry: () => setDonghuaNote(`Jaringan lambat — menghubungkan ulang ke ${name}…`),
            },
        );
        return {
            id,
            name,
            items: (Array.isArray(res.items) ? res.items : []).slice(0, DONGHUA_SITE_LIMIT),
            // Kegagalan sebagian dari backend (mis. feed metadata mati) tetap dianggap gagal:
            // panel menawarkan "Coba lagi", bukan pura-pura "situs kosong".
            error: res.error || null,
        };
    } catch (error) {
        if (error?.kind !== 'abort') console.info(`[donghua] ${id} gagal dimuat:`, error?.message || error);
        return { id, name, items: [], error };
    }
}

/**
 * Muat donghua dari kedua situs sumber (paralel, kegagalan satu tidak menggagalkan yang lain).
 * `quiet` dipakai auto refresh: panel yang sudah terisi tidak dikosongkan lebih dulu.
 */
async function loadDonghuaSites(options = {}) {
    const { refresh = false, retry = true, quiet = false } = options && typeof options === 'object' ? options : {};
    if (!donghuaSites) return;
    donghuaStarted = true;
    const token = ++donghuaLoadToken;
    if (!quiet || !donghuaState) {
        donghuaSites.setAttribute('aria-busy', 'true');
        donghuaSites.innerHTML = String(html`<section class="subindo-source donghua-site is-loading">
            <div class="subindo-source-header"><h3>Donghua dari situs</h3><span class="subindo-source-count">memuat…</span></div>
            <div class="anime-grid">${skeletonCards(4)}</div>
        </section>`);
        setDonghuaNote('');
    }
    const panels = await Promise.all(DONGHUA_SITE_IDS.map((id) => fetchDonghuaPanel(id, { refresh, retry })));
    if (token !== donghuaLoadToken) return;
    donghuaSites.setAttribute('aria-busy', 'false');
    const filled = panels.filter((panel) => panel.items.length);
    if (filled.length) {
        donghuaLastOkAt = Date.now();
        autoRetryStreak = 0;
        writeDonghuaCache(panels);
        donghuaState = { panels };
        renderDonghuaPanels(panels);
        return;
    }
    // Semua panel kosong. Bila penyebabnya kegagalan (bukan situs yang memang kosong),
    // pakai hasil terakhir perangkat ini agar bagian Donghua tidak kosong melompong.
    const failed = panels.filter((panel) => panel.error);
    if (failed.length && quiet && donghuaState?.panels?.some((panel) => panel.items.length)) {
        // Auto refresh gagal padahal panel sudah tampil: pertahankan hasil sebelumnya.
        setDonghuaNote(
            `Katalog live AnimeKu & Oploverz belum bisa dimuat (${friendlyError(failed[0].error)}).`
            + ' Panel menampilkan data dari permintaan sebelumnya.',
            { retry: true },
        );
        scheduleAutoRefresh();
        return;
    }
    if (failed.length) {
        const cached = readDonghuaCache();
        if (cached?.panels?.length) {
            // `stale: true` membuat auto refresh tahu data ini belum segar → dicoba lagi
            // pada jadwal berikutnya (15 dtk / 45 dtk / 2 mnt, lalu tiap 5 menit).
            const stalePanels = cached.panels.map((panel) => ({ ...panel, stale: true }));
            donghuaState = { panels: stalePanels, savedAt: cached.savedAt };
            renderDonghuaPanels(stalePanels);
            const when = cached.savedAt
                ? new Date(cached.savedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
                : '';
            setDonghuaNote(
                `Katalog live AnimeKu & Oploverz belum bisa dimuat (${friendlyError(failed[0].error)}).`
                + ` Menampilkan data tersimpan${when ? ` dari ${when}` : ''}.`,
                { retry: true },
            );
            scheduleAutoRefresh();
            return;
        }
    }
    donghuaState = { panels };
    renderDonghuaPanels(panels);
    if (failed.length) scheduleAutoRefresh();
}

/** Tombol "Muat ulang" di kepala bagian Donghua (permintaan manual, tanpa cache). */
async function refreshDonghuaSites() {
    if (donghuaRefreshBtn?.disabled) return;
    if (donghuaRefreshBtn) {
        donghuaRefreshBtn.disabled = true;
        donghuaRefreshBtn.classList.add('is-busy');
        donghuaRefreshBtn.setAttribute('aria-busy', 'true');
    }
    retrySourcesNow();
    autoRetryStreak = 0;
    try {
        await loadDonghuaSites({ refresh: true });
    } finally {
        if (donghuaRefreshBtn) {
            donghuaRefreshBtn.disabled = false;
            donghuaRefreshBtn.classList.remove('is-busy');
            donghuaRefreshBtn.removeAttribute('aria-busy');
        }
    }
}

donghuaRefreshBtn?.addEventListener('click', () => {
    void refreshDonghuaSites();
});

/* ------------------------------------------------------------------ */
/* Auto refresh AnimeKu & Oploverz (24 Okt 2026)                       */
/* Permintaan pengguna: "tambahkan auto refresh nya untuk animeloverz  */
/* dan animeku agar tidak gagal memuat".                               */
/*  1. Tiap panel memakai percobaan ulang otomatis (js/api/retry.js):   */
/*     timeout/jaringan/5xx/circuit dicoba sekali lagi sebelum gagal.   */
/*  2. Bagian yang gagal atau datanya lebih tua dari 15 menit dimuat    */
/*     ulang sendiri saat jaringan kembali, tab dibuka lagi, atau tiap   */
/*     5 menit — tanpa mengosongkan panel yang sudah terisi (quiet).    */
/*  3. Setelah gagal, percobaan ulang dijeda 15 dtk → 45 dtk → 2 mnt.   */
/*  4. Hasil sukses terakhir disimpan dan dipakai bila situs benar-benar */
/*     tidak bisa dihubungi.                                           */
/* ------------------------------------------------------------------ */
const AUTO_REFRESH_STALE_MS = 15 * 60 * 1000;
const AUTO_REFRESH_TICK_MS = 5 * 60 * 1000;
const AUTO_REFRESH_MIN_GAP_MS = 45 * 1000;
/** Jeda percobaan ulang setelah gagal; berhenti setelah tiga kali (tick 5 menit tetap jalan). */
const AUTO_RETRY_PLAN_MS = [15000, 45000, 120000];
let autoRefreshAt = 0;
let autoRetryStreak = 0;
let autoRetryTimer = 0;

/** Panel dianggap belum termuat: belum ada data, semua gagal, atau hanya berisi cache. */
function sectionNeedsRefresh(state, lastOkAt, entriesOf, now = Date.now()) {
    if (!state) return true;
    if (lastOkAt && now - lastOkAt > AUTO_REFRESH_STALE_MS) return true;
    const entries = entriesOf(state);
    return entries.length > 0 && entries.every((entry) => entry.error || entry.stale);
}

/** Muat ulang bagian AnimeKu/Oploverz yang gagal atau basi (tanpa mengosongkan layar). */
function autoRefreshSources({ ignoreGap = false } = {}) {
    if (typeof document !== 'undefined' && document.hidden) return;
    const now = Date.now();
    if (!ignoreGap && now - autoRefreshAt < AUTO_REFRESH_MIN_GAP_MS) return;
    let touched = false;
    // Bagian donghua baru boleh dimuat setelah section-nya benar-benar diminta tampil.
    if (donghuaStarted && sectionNeedsRefresh(donghuaState, donghuaLastOkAt, (state) => state.panels, now)) {
        touched = true;
        void loadDonghuaSites({ refresh: true, quiet: Boolean(donghuaState) });
    }
    if (sectionNeedsRefresh(subIndoState, subIndoLastOkAt, (state) => state.sections, now)) {
        touched = true;
        void loadSubIndoSection({ refresh: true, quiet: Boolean(subIndoState) });
    }
    if (touched) autoRefreshAt = now;
}

/** Jadwalkan muat ulang otomatis setelah kegagalan (maks 3 kali, jeda bertambah). */
function scheduleAutoRefresh() {
    if (autoRetryTimer || autoRetryStreak >= AUTO_RETRY_PLAN_MS.length) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const delay = AUTO_RETRY_PLAN_MS[autoRetryStreak];
    autoRetryStreak += 1;
    autoRetryTimer = setTimeout(() => {
        autoRetryTimer = 0;
        autoRefreshSources({ ignoreGap: true });
    }, delay);
}

window.addEventListener('online', () => {
    // Sambungan kembali: permintaan yang tadi timeout/gagal langsung dicoba lagi.
    autoRefreshAt = 0;
    autoRetryStreak = 0;
    autoRefreshSources({ ignoreGap: true });
});

document.addEventListener('visibilitychange', () => {
    // Tab dibuka lagi setelah lama di latar: data lama boleh dimuat ulang diam-diam.
    if (!document.hidden) autoRefreshSources({ ignoreGap: true });
});

setInterval(() => autoRefreshSources(), AUTO_REFRESH_TICK_MS);

/* ------------------------------------------------------------------ */
/* Bookmark: pindah ke bookmark.html (24 Okt 2026)                      */
/* ------------------------------------------------------------------ */
/* Daftar bookmark tidak lagi dirender di beranda; halaman bookmark.html yang mengurus
 * pencarian/urutan. Beranda hanya menyinkronkan status tombol bookmark di kartu. */
bindCardActions(main, (anime) => ctx.toggleBookmark(anime));
onBookmarksChange(() => {
    syncBookmarkButtons(isBookmarked, main);
    hero.refresh();
});

/* ------------------------------------------------------------------ */
/* Jadwal rilis (WIB, lazy)                                            */
/* ------------------------------------------------------------------ */
const scheduleGrid = $('#scheduleGrid');
const scheduleNote = $('#scheduleNote');

const SCHEDULE_NOTES = {
    backend: `Jadwal rilis Samehadaku dalam ${SCHEDULE.label} · donghua dari Anichin (jam perkiraan) & AnimeXin · klik judul untuk episode terbaru.`,
    anilist: `Jam tayang dalam ${SCHEDULE.label} (UTC+7) · ${SCHEDULE.perDay} anime terpopuler per hari · sumber: AniList · klik judul untuk menonton.`,
};

async function loadSchedule() {
    renderScheduleSkeleton(scheduleGrid, { today: wibWeekday() });
    scheduleNote.textContent = 'Memuat jadwal tayang...';
    const res = await getWeeklySchedule();

    const byDay = {};
    Object.entries(res.byDay).forEach(([day, items]) => {
        byDay[day] = items.map((it) => {
            if (Array.isArray(it) || !it.anime) return it;
            // Jadwal backend: tanpa nomor episode → buka episode terbaru (ditentukan halaman nonton)
            if (it.latest) return { ...it, href: watchUrl(it.anime, 'latest') };
            // Episode yang belum tayang → tautkan ke episode sebelumnya (yang sudah ada)
            const ep = it.episode ? (it.aired ? it.episode : Math.max(1, it.episode - 1)) : 1;
            return { ...it, href: watchUrl(it.anime, ep) };
        });
    });
    renderSchedule(scheduleGrid, byDay, { today: res.today, timeLabel: SCHEDULE.label });

    if (res.source === 'fallback') {
        scheduleNote.innerHTML = String(html`${icon('triangle-alert')} Jadwal contoh (data cadangan). ${friendlyError(res.error)} <button type="button" class="schedule-retry" data-action="retry">${icon('refresh-cw')} Coba lagi</button>`);
        scheduleNote.querySelector('[data-action="retry"]').addEventListener('click', () => {
            retrySourcesNow();
            loadSchedule();
        }, { once: true });
    } else {
        scheduleNote.textContent = SCHEDULE_NOTES[res.source] || '';
    }
}

function whenVisible(el, callback) {
    if (!el || !('IntersectionObserver' in window)) {
        callback();
        return;
    }
    const observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
            observer.disconnect();
            callback();
        }
    }, { rootMargin: '600px 0px' });
    observer.observe(el);
}

/* ------------------------------------------------------------------ */
/* Mulai                                                               */
/* ------------------------------------------------------------------ */
Object.keys(GRIDS).forEach((kind) => loadSection(kind));
loadSubIndoSection();
// Panel donghua situs dimuat saat bagiannya mendekati layar: dua permintaan katalog
// (AnimeKu & Oploverz) tidak boleh berebut jaringan dengan hero/section di awal halaman.
whenVisible($('#donghua'), loadDonghuaSites);
renderScheduleSkeleton(scheduleGrid, { today: wibWeekday() });
whenVisible($('#jadwal'), loadSchedule);


console.info('%cKazanime — data live: AniList → Kitsu → cadangan; donghua & jadwal dari backend scraper', 'color:#ff6b9d;font-weight:bold');
