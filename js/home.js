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
import { getSourceBrowse, getSourceGenres } from './api/sources.js';

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

async function loadSubIndoSection({ refresh = false, retry = true } = {}) {
    const token = ++subIndoLoadToken;
    // Status teks selalu terlihat (termasuk di layar kecil) supaya bagian ini tidak
    // pernah tampil "kosong" tanpa penjelasan saat jaringan lambat.
    if (subIndoStatus && !subIndoState) subIndoStatus.textContent = 'Memuat katalog AnimeKu & Oploverz…';
    showSkeleton(subIndoRoot, 4);
    setSectionNote(subIndoRoot);
    try {
        const result = await getSubIndoHomeSources({ refresh });
        if (token !== subIndoLoadToken) return;
        const sections = panelSections(result.sections);
        if (!sections.length) throw new Error('Backend tidak mengirim panel Sub Indo.');
        subIndoState = { sections };
        writeSubIndoCache(sections);
        renderSubIndoSources(sections);
        updateSubIndoNote(sections);
    } catch (error) {
        if (token !== subIndoLoadToken || error?.kind === 'abort') return;
        // Jaringan ponsel sering putus sebentar: satu percobaan ulang otomatis sebelum
        // menyerah ke cache/pesan error. Status tetap terlihat selama percobaan ini.
        if (retry && (error?.kind === 'timeout' || error?.kind === 'network')) {
            if (subIndoStatus) subIndoStatus.textContent = 'Jaringan lambat — mencoba sekali lagi…';
            await new Promise((resolve) => setTimeout(resolve, 800));
            if (token !== subIndoLoadToken) return;
            return loadSubIndoSection({ refresh: true, retry: false });
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
/* Menu genre situs (24 Okt 2026): deretan ±70 tombol dipindah ke panel yang bisa dibuka. */
const genreMenuBtn = $('#genreMenuBtn');
const genreMenu = $('#genreMenu');
const genreMenuBody = $('#genreMenuBody');
const genreMenuSearch = $('#genreMenuSearch');
const genreMenuClose = $('#genreMenuClose');
const genreMenuCount = $('#genreMenuCount');
const genreMenuEmpty = $('#genreMenuEmpty');
/**
 * Filter aktif: genre (label AniList atau kunci `sumber:token`), tahun, musim
 * (winter/spring/summer/fall), urutan. `siteGenres` diisi dari `/api/anime/genres`.
 */
const genreState = {
    genre: '', source: '', year: '', season: '', sort: 'popularity', token: 0, siteGenres: [],
};

const SEASON_LABELS = { winter: 'Winter', spring: 'Spring', summer: 'Summer', fall: 'Fall' };
/**
 * Padanan id genre situs ↔ label AniList, dipakai agar tombol tidak kembar
 * (AnimeKu memakai istilah Indonesia: "aksi" = "Action", dst.).
 */
const SITE_GENRE_ALIASES = {
    aksi: 'action',
    petualangan: 'adventure',
    komedi: 'comedy',
    drama: 'drama',
    ecchi: 'ecchi',
    fantasi: 'fantasy',
    horor: 'horror',
    isekai: 'isekai',
    mecha: 'mecha',
    musik: 'music',
    misteri: 'mystery',
    olahraga: 'sports',
    psikologis: 'psychological',
    romantis: 'romance',
    'slice-of-life': 'slice of life',
    supernatural: 'supernatural',
    thriller: 'thriller',
    action: 'action',
};
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
const tagKey = (tag) => (tag.dataset.source
    ? `${tag.dataset.source}:${tag.dataset.genre || ''}`
    : (tag.dataset.genre || ''));

/** Semua tombol genre: chip AniList di beranda + tombol situs di dalam menu. */
function genreTagNodes() {
    const menuTags = genreMenuBody ? [...genreMenuBody.querySelectorAll('.genre-tag')] : [];
    return [...genreBox.querySelectorAll('.genre-tag'), ...menuTags];
}

function markGenre(key) {
    genreTagNodes().forEach((tag) => {
        const on = tagKey(tag) === key;
        tag.classList.toggle('active', on);
        tag.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function closeGenre() {
    genreState.genre = '';
    genreState.source = '';
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

/**
 * Tombol genre dari situs (24 Okt 2026): Oploverz ±80 genre, AnimeKu hasil panen
 * tautan `/genre/<slug>-<token>/`. Genre yang labelnya sudah ada di daftar AniList
 * dilewati agar tidak ada tombol kembar; sisanya ditampilkan semua (permintaan pengguna).
 */
function renderSiteGenres() {
    if (!genreMenuBody) return;
    genreMenuBody.querySelector('[data-site-genres]')?.remove();
    const known = new Set(GENRES.map((genre) => genre.label.toLowerCase()));
    const groups = [];
    let total = 0;
    for (const source of genreState.siteGenres) {
        const list = source.genres.filter((genre) => {
            // Kunci: padanan AniList bila ada ("aksi" → "action"), kalau tidak labelnya sendiri.
            const key = SITE_GENRE_ALIASES[genre.id] || genre.label.toLowerCase();
            if (known.has(key)) return false;
            known.add(key);
            return true;
        });
        if (!list.length) continue;
        total += list.length;
        groups.push(html`<div class="genre-group">
            <span class="genre-group-label">${source.name}</span>
            <span class="genre-group-tags">${list.map((genre) => html`<button type="button" class="genre-tag genre-tag--site" data-source="${source.id}" data-genre="${genre.id}" aria-pressed="false" aria-controls="genreResults">${genre.label}</button>`)}</span>
        </div>`);
    }
    if (!groups.length) {
        // Tidak ada genre situs: tombol menu tidak ditampilkan supaya tidak membuka panel kosong.
        if (genreMenuBtn) genreMenuBtn.hidden = true;
        return;
    }
    genreMenuBody.insertAdjacentHTML('beforeend', String(html`<div class="genre-group-list" data-site-genres>${groups}</div>`));
    if (genreMenuBtn) genreMenuBtn.hidden = false;
    if (genreMenuCount) {
        genreMenuCount.textContent = String(total);
        genreMenuCount.hidden = false;
    }
    filterGenreMenu(genreMenuSearch?.value || '');
}

/**
 * Buka/tutup panel genre situs. Fokus pindah ke kotak cari saat dibuka supaya
 * pengguna ponsel tidak perlu menggulir daftar panjang untuk menemukan genre.
 */
function setGenreMenuOpen(open) {
    if (!genreMenu || !genreMenuBtn) return;
    genreMenu.hidden = !open;
    genreMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
        genreMenuSearch?.focus({ preventScroll: true });
        return;
    }
    if (genreMenuSearch && genreMenuSearch.value) {
        genreMenuSearch.value = '';
        filterGenreMenu('');
    }
}

/** Saring tombol genre situs berdasarkan kata kunci; grup kosong disembunyikan. */
function filterGenreMenu(term) {
    if (!genreMenuBody) return;
    const needle = String(term || '').trim().toLowerCase();
    let shown = 0;
    genreMenuBody.querySelectorAll('.genre-group').forEach((group) => {
        let visible = 0;
        group.querySelectorAll('.genre-tag').forEach((tag) => {
            const match = !needle || (tag.textContent || '').toLowerCase().includes(needle);
            tag.hidden = !match;
            if (match) visible += 1;
        });
        group.hidden = visible === 0;
        shown += visible;
    });
    if (genreMenuEmpty) genreMenuEmpty.hidden = shown > 0;
}

/** Muat daftar genre situs; gagal = tombol AniList tetap bisa dipakai (tanpa pesan). */
async function loadSiteGenres() {
    try {
        const res = await getSourceGenres();
        genreState.siteGenres = res.sources.filter((source) => source.id === 'oploverz' || source.id === 'animeku');
        renderSiteGenres();
    } catch {
        // Diamkan: daftar genre AniList sudah tampil lebih dulu.
    }
}

/**
 * Genre dari situs sumber (Oploverz/AnimeKu) lewat katalog backend.
 * @param {string} source id sumber
 * @param {string} id     id genre situs (mis. "aksi", "slice-of-life")
 * @param {string} label  label tampilan
 */
async function selectSiteGenre(source, id, label, { keepOpen = false } = {}) {
    const key = `${source}:${id}`;
    if (!keepOpen && key === genreState.genre) {
        closeGenre();
        return;
    }
    markGenre(key);
    genreState.genre = key;
    genreState.source = source;
    const token = ++genreState.token;
    const def = genreState.siteGenres.find((item) => item.id === source);
    const filters = genreFilterLabel();
    genreTitle.textContent = `Genre: ${label}${filters ? ` · ${filters}` : ''} — ${def?.name || source}`;
    genreSeeAll.href = katalogUrl({
        source, genre: id, year: genreState.year, season: genreState.season,
    });
    genreResults.hidden = false;
    showSkeleton(genreGrid);
    revealGenreResults();

    // Urutan mengikuti kontrol "Urutkan": Oploverz punya token order di form `/series/`;
    // AnimeKu tidak punya token order untuk arsip genre, jadi urutan skor dilakukan di sini.
    const SITE_ORDER = { oploverz: { popularity: 'popular', score: 'rating', newest: 'update' } };
    const res = await getSourceBrowse(source, {
        genre: id,
        year: genreState.year,
        season: genreState.season,
        filter: SITE_ORDER[source]?.[genreState.sort] || '',
    });
    if (token !== genreState.token) return;
    let items = res.items;
    if (source === 'animeku' && genreState.sort === 'score') {
        items = [...items].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    }
    if (items.length) {
        renderCards(genreGrid, items, { isBookmarked });
        const notes = [];
        if (source === 'animeku' && (genreState.year || genreState.season)) {
            notes.push('AnimeKu tidak punya filter tahun/musim — semua tahun ditampilkan.');
        }
        if (res.hasNext) notes.push('Sebagian hasil ada di halaman berikutnya — buka "Lihat Semua" untuk daftar penuh.');
        notes.push(`Katalog ${def?.name || source} ditampilkan apa adanya.`);
        setSectionNote(genreGrid, { text: notes.join(' ') });
    } else if (res.error && res.error.kind !== 'empty') {
        gridMessage(genreGrid, {
            icon: 'triangle-alert',
            title: 'Gagal memuat genre situs',
            text: friendlyError(res.error),
            actions: html`<button type="button" class="btn-ext btn-ext--retry" data-action="retry-genre">${icon('refresh-cw')} Coba Lagi</button>`,
        });
    } else {
        gridMessage(genreGrid, { icon: 'inbox', text: `Tidak ada anime genre "${label}" di ${def?.name || source}` });
    }
}

/** Perubahan filter: muat ulang genre yang sedang terbuka (bila ada). */
function applyGenreFilters() {
    updateGenreReset();
    if (!genreState.genre) return;
    if (genreState.source) {
        const id = genreState.genre.split(':').slice(1).join(':');
        const source = genreState.siteGenres.find((item) => item.id === genreState.source);
        const label = source?.genres.find((genre) => genre.id === id)?.label || id;
        selectSiteGenre(genreState.source, id, label, { keepOpen: true });
        return;
    }
    selectGenre(genreState.genre, { keepOpen: true });
}

function handleGenreTag(tag) {
    if (!tag) return;
    if (tag.dataset.source) {
        selectSiteGenre(tag.dataset.source, tag.dataset.genre || '', (tag.textContent || '').trim());
        return;
    }
    selectGenre(tag.dataset.genre || '');
}

delegate(genreBox, 'click', '.genre-tag', (_e, tag) => handleGenreTag(tag));
// Genre situs ada di dalam menu: klik tombol = pilih genre + tutup menu.
delegate(genreMenuBody, 'click', '.genre-tag', (_e, tag) => {
    setGenreMenuOpen(false);
    handleGenreTag(tag);
});

genreMenuBtn?.addEventListener('click', () => {
    setGenreMenuOpen(Boolean(genreMenu?.hidden));
});
genreMenuClose?.addEventListener('click', () => {
    setGenreMenuOpen(false);
    genreMenuBtn?.focus({ preventScroll: true });
});
genreMenuSearch?.addEventListener('input', () => filterGenreMenu(genreMenuSearch.value));
genreMenuSearch?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        setGenreMenuOpen(false);
        genreMenuBtn?.focus({ preventScroll: true });
    }
});
// Klik di luar menu menutup panel (perilaku menu pada umumnya, termasuk di ponsel).
document.addEventListener('click', (event) => {
    if (!genreMenu || genreMenu.hidden) return;
    if (genreMenu.contains(event.target) || genreMenuBtn?.contains(event.target)) return;
    setGenreMenuOpen(false);
});
document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !genreMenu || genreMenu.hidden) return;
    setGenreMenuOpen(false);
    genreMenuBtn?.focus({ preventScroll: true });
});
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
    const key = genreState.genre;
    const source = genreState.source;
    genreState.genre = '';
    if (source) {
        const id = key.split(':').slice(1).join(':');
        const def = genreState.siteGenres.find((item) => item.id === source);
        selectSiteGenre(source, id, def?.genres.find((genre) => genre.id === id)?.label || id, { keepOpen: true });
        return;
    }
    selectGenre(key, { keepOpen: true });
});

// Daftar genre situs dimuat menyusul agar tombol AniList tampil tanpa menunggu backend.
void loadSiteGenres();

/* ------------------------------------------------------------------ */
/* Donghua dari situs sumber: AnimeKu & Oploverz (24 Okt 2026)         */
/* Permintaan pengguna: "tambahkan Data Donghua dari kedua itu di      */
/* Oploverz dan AnimeKu, jangan AniList saja". Panel di atas grid       */
/* metadata; grid AniList tetap jadi pelengkap untuk judul yang belum   */
/* ada di kedua situs.                                                 */
/* ------------------------------------------------------------------ */
const donghuaSites = $('#donghuaSites');
const donghuaNote = $('#donghuaNote');
const DONGHUA_SITE_IDS = ['animeku', 'oploverz'];
const DONGHUA_SITE_LABELS = { animeku: 'AnimeKu', oploverz: 'Oploverz' };
const DONGHUA_SITE_LIMIT = 12;

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
        retrySourcesNow();
        loadDonghuaSites();
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
    setDonghuaNote(note);
}

/** Muat donghua dari kedua situs sumber (paralel, kegagalan satu tidak menggagalkan yang lain). */
async function loadDonghuaSites() {
    if (!donghuaSites) return;
    donghuaSites.setAttribute('aria-busy', 'true');
    donghuaSites.innerHTML = String(html`<section class="subindo-source donghua-site is-loading">
        <div class="subindo-source-header"><h3>Donghua dari situs</h3><span class="subindo-source-count">memuat…</span></div>
        <div class="anime-grid">${skeletonCards(4)}</div>
    </section>`);
    setDonghuaNote('');
    const panels = await Promise.all(DONGHUA_SITE_IDS.map(async (id) => {
        const name = DONGHUA_SITE_LABELS[id] || id;
        try {
            const res = await getSourceBrowse(id, { filter: 'donghua' });
            const items = (Array.isArray(res.items) ? res.items : []).slice(0, DONGHUA_SITE_LIMIT);
            return { id, name, items };
        } catch (error) {
            if (error?.kind !== 'abort') console.info(`[donghua] ${id} gagal dimuat:`, error?.message || error);
            return { id, name, items: [], error };
        }
    }));
    donghuaSites.setAttribute('aria-busy', 'false');
    renderDonghuaPanels(panels);
}

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
