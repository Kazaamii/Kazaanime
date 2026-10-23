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
import { GENRES, SCHEDULE } from './config.js';
import { genreUrl, watchUrl, latestEpisodeOf } from './routes.js';
import {
    getHeroSlides, getHomeSection, getSubIndoHomeSources, getGenreAnime, getWeeklySchedule, wibWeekday, friendlyError, retrySourcesNow,
} from './api/index.js';
import { getBookmarks, onBookmarksChange } from './services/bookmark.js';
import { icon } from './ui/icons.js';

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

const SUB_INDO_HOME_LIMIT = 12;

function renderSubIndoSources(sources) {
    const list = Array.isArray(sources) ? sources : [];
    subIndoRoot.setAttribute('aria-busy', 'false');
    if (!list.length) {
        gridMessage(subIndoRoot, {
            icon: 'inbox',
            title: 'Belum ada sumber Sub Indo aktif',
            text: 'Aktifkan sumber rilis Sub Indo di konfigurasi backend untuk menampilkan daftar per situs.',
        });
        return;
    }

    subIndoRoot.innerHTML = String(html`${list.map((source, index) => {
        const items = Array.isArray(source.items) ? source.items.slice(0, SUB_INDO_HOME_LIMIT) : [];
        const status = source.error ? 'Perlu diperbarui' : source.stale ? 'Data cache' : items.length ? `${items.length} rilis` : 'Belum ada rilis';
        return html`
            <section class="subindo-source" aria-labelledby="subindo-source-title-${index}">
                <div class="subindo-source-header">
                    <h3 id="subindo-source-title-${index}">${source.name}</h3>
                    <span class="subindo-source-count ${source.stale ? 'is-stale' : ''}">${status}</span>
                </div>
                ${source.stale ? html`<p class="subindo-source-warning">${source.error ? friendlyError(source.error) : 'Menampilkan cache karena pembaruan sumber belum berhasil.'}</p>` : ''}
                <div class="anime-grid" data-subindo-source-grid="${source.id}" aria-busy="false"></div>
            </section>`;
    })}`);

    list.forEach((source) => {
        const grid = [...subIndoRoot.querySelectorAll('[data-subindo-source-grid]')]
            .find((element) => element.dataset.subindoSourceGrid === source.id);
        if (!grid) return;
        const items = Array.isArray(source.items) ? source.items.slice(0, SUB_INDO_HOME_LIMIT) : [];
        if (items.length) {
            renderCards(grid, items, { variant: 'source', isBookmarked, episodeOf: latestEpisodeOf });
        } else if (source.error) {
            gridMessage(grid, { icon: 'triangle-alert', title: 'Sumber belum dapat dimuat', text: friendlyError(source.error) });
        } else {
            gridMessage(grid, { icon: 'inbox', title: 'Belum ada rilis terdeteksi', text: 'Feed terbaru situs ini tidak mengembalikan anime saat ini.' });
        }
    });
}

async function loadSubIndoSection() {
    showSkeleton(subIndoRoot, 4);
    setSectionNote(subIndoRoot);
    try {
        const result = await getSubIndoHomeSources();
        renderSubIndoSources(result.sections);
        const failed = result.sections.filter((source) => source.error).length;
        if (failed) {
            setSectionNote(subIndoRoot, {
                text: `${failed} sumber belum berhasil diperbarui. Setiap sumber tetap ditampilkan pada panelnya sendiri.`,
                onRetry: () => {
                    retrySourcesNow();
                    loadSubIndoSection();
                },
            });
        }
    } catch (error) {
        if (error?.kind === 'abort') return;
        gridMessage(subIndoRoot, {
            icon: 'triangle-alert',
            title: 'Daftar Sub Indo belum tersedia',
            text: friendlyError(error),
            actions: html`<button type="button" class="btn-ext btn-ext--retry" data-action="retry-subindo">${icon('refresh-cw')} Coba Lagi</button>`,
        });
    }
}

delegate(subIndoRoot, 'click', '[data-action="retry-subindo"]', () => {
    retrySourcesNow();
    loadSubIndoSection();
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
/* Bookmark                                                            */
/* ------------------------------------------------------------------ */
const bookmarkSection = $('#bookmarks');
const bookmarkGrid = $('#bookmarkGrid');

function renderBookmarkSection() {
    const user = ctx.getUser();
    bookmarkSection.hidden = !user;
    if (!user) {
        bookmarkGrid.innerHTML = '';
        return;
    }
    const list = getBookmarks();
    if (!list.length) {
        bookmarkGrid.innerHTML = String(html`
            <div class="bookmark-empty">
                <p class="bookmark-empty-icon" aria-hidden="true">${icon('bookmark')}</p>
                <h3>Belum ada bookmark</h3>
                <p>Klik ikon bookmark di pojok kartu anime untuk menambahkannya ke sini.</p>
            </div>`);
        return;
    }
    renderCards(bookmarkGrid, list, { variant: 'bookmark', isBookmarked: () => true });
}

bindCardActions(main, (anime) => ctx.toggleBookmark(anime));
onBookmarksChange(() => {
    renderBookmarkSection();
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
renderBookmarkSection();
Object.keys(GRIDS).forEach((kind) => loadSection(kind));
loadSubIndoSection();
renderScheduleSkeleton(scheduleGrid, { today: wibWeekday() });
whenVisible($('#jadwal'), loadSchedule);

// Datang dari halaman lain lewat index.html#bookmarks: section ini baru tampil setelah JS jalan
if (window.location.hash === '#bookmarks' && !bookmarkSection.hidden) {
    requestAnimationFrame(() => bookmarkSection.scrollIntoView({ block: 'start' }));
}

console.info('%cKazanime — data live: AniList → Kitsu → cadangan; donghua & jadwal dari backend scraper', 'color:#ff6b9d;font-weight:bold');
