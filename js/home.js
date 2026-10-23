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
import { showSkeleton } from './ui/skeleton.js';
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
let subIndoLoadToken = 0;
/** Hasil terakhir supaya tombol "Coba lagi" per panel bisa memperbarui satu sumber saja. */
let subIndoState = null;

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
const subIndoFeedList = $('#subIndoFeedList');
/** Panel yang sedang dibuka penuh. */
const subIndoExpanded = new Set();

/** Ringkasan kecil di bawah intro: situs dan jumlah judul yang tampil. */
function renderSubIndoSummary(sources) {
    const list = Array.isArray(sources) ? sources : [];
    if (!subIndoStatus) return;
    if (!list.length) {
        subIndoStatus.textContent = '';
        if (subIndoFeedList) subIndoFeedList.textContent = 'Tidak ada sumber Sub Indo yang aktif.';
        return;
    }
    const total = list.reduce((sum, source) => sum + (Array.isArray(source.items) ? source.items.length : 0), 0);
    subIndoStatus.textContent = `${list.length} situs · ${total} judul`;
    if (subIndoFeedList) subIndoFeedList.textContent = `Feed: ${list.map((source) => source.name).join(', ')}.`;
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

async function loadSubIndoSection({ refresh = false } = {}) {
    const token = ++subIndoLoadToken;
    showSkeleton(subIndoRoot, 4);
    setSectionNote(subIndoRoot);
    try {
        const result = await getSubIndoHomeSources({ refresh });
        if (token !== subIndoLoadToken) return;
        subIndoState = { sections: panelSections(result.sections) };
        renderSubIndoSources(subIndoState.sections);
        updateSubIndoNote(subIndoState.sections);
    } catch (error) {
        if (token !== subIndoLoadToken || error?.kind === 'abort') return;
        subIndoState = null;
        renderSubIndoSummary([]);
        if (subIndoFeedList) subIndoFeedList.textContent = 'Feed tidak tersedia saat ini.';
        gridMessage(subIndoRoot, {
            icon: 'triangle-alert',
            title: 'Daftar Sub Indo belum tersedia',
            text: friendlyError(error),
            actions: html`<button type="button" class="btn-ext btn-ext--retry" data-action="retry-subindo">${icon('refresh-cw')} Coba Lagi</button>`,
        });
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
    retrySourcesNow();
    loadSubIndoSection({ refresh: true });
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
const genreState = { genre: '', token: 0 };

genreBox.innerHTML = String(html`${GENRES.map((g) => html`<button type="button" class="genre-tag" data-genre="${g.label}" aria-pressed="false" aria-controls="genreResults">${g.label}</button>`)}`);

function markGenre(genre) {
    genreBox.querySelectorAll('.genre-tag').forEach((t) => {
        const on = (t.dataset.genre || '') === genre;
        t.classList.toggle('active', on);
        t.setAttribute('aria-pressed', on ? 'true' : 'false');
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

async function selectGenre(genre) {
    if (!genre || genre === genreState.genre) {
        closeGenre();
        return;
    }
    markGenre(genre);
    genreState.genre = genre;
    const token = ++genreState.token;
    genreTitle.textContent = `Genre: ${genre}`;
    genreSeeAll.href = genreUrl(genre);
    genreResults.hidden = false;
    showSkeleton(genreGrid);
    revealGenreResults();

    const res = await getGenreAnime(genre);
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
        gridMessage(genreGrid, { icon: 'inbox', text: `Tidak ada anime dengan genre "${genre}"` });
    }
}

delegate(genreBox, 'click', '.genre-tag', (_e, tag) => selectGenre(tag.dataset.genre || ''));
$('#genreClose').addEventListener('click', closeGenre);
delegate(genreGrid, 'click', '[data-action="retry-genre"]', () => {
    retrySourcesNow();
    const g = genreState.genre;
    genreState.genre = '';
    selectGenre(g);
});

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
renderScheduleSkeleton(scheduleGrid, { today: wibWeekday() });
whenVisible($('#jadwal'), loadSchedule);


console.info('%cKazanime — data live: AniList → Kitsu → cadangan; donghua & jadwal dari backend scraper', 'color:#ff6b9d;font-weight:bold');
