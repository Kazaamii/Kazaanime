/**
 * Kazanime — home.js (entry point index.html)
 *
 * Merangkai homepage dari komponen UI + facade data (js/api/index.js).
 * Tidak ada fetch di sini; semua data datang sebagai objek Anime.
 *
 * Alur:
 *  1. initLayout()  → navbar, footer, modal, autocomplete, status API, auth.
 *  2. Hero + 4 section diminta bersamaan. Di AniList semuanya berasal dari
 *     SATU query gabungan (request dipakai bersama, di-cache 15 menit).
 *     Jika AniList gagal → Jikan → Kitsu → data cadangan statis (+ keterangan
 *     & tombol "Coba lagi").
 *     Donghua (Tahap D): rilis terbaru dari backend scraper (animexin) lebih dulu —
 *     kartunya langsung membuka episode terbaru — lalu AniList CN → data cadangan.
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
import { browseUrl, genreUrl, watchUrl, latestEpisodeOf } from './routes.js';
import {
    getHeroSlides, getHomeSection, getGenreAnime, getWeeklySchedule, wibWeekday, friendlyError, retrySourcesNow,
} from './api/index.js';
import { getBookmarks, onBookmarksChange } from './services/bookmark.js';

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

/** State section Populer (juga dipakai filter genre). */
const popular = { genre: '', token: 0 };

async function loadSection(kind) {
    const grid = GRIDS[kind];
    const token = kind === 'popular' ? ++popular.token : 0;
    showSkeleton(grid);
    setSectionNote(grid);
    const res = await getHomeSection(kind);
    if (kind === 'popular' && (token !== popular.token || popular.genre)) return; // user sudah pindah ke genre
    // "Baru Rilis" & donghua dari backend (rilis terbaru animexin): kartu langsung membuka
    // episode yang baru tayang (label kartu "EP 9" → episode 9)
    const toLatest = kind === 'recent' || (kind === 'donghua' && res.source === 'backend');
    renderCards(grid, res.items, { isBookmarked, episodeOf: toLatest ? latestEpisodeOf : undefined });
    if (res.fallback) {
        setSectionNote(grid, {
            text: `⚠️ Menampilkan data cadangan. ${friendlyError(res.error)}`,
            onRetry: () => {
                retrySourcesNow();
                loadSection(kind);
            },
        });
    }
}

/* ------------------------------------------------------------------ */
/* Genre (memfilter section Populer, sama seperti file asli)           */
/* ------------------------------------------------------------------ */
const genreBox = $('#genreTags');
const popularTitle = $('#popularTitle');
const popularSeeAll = $('#popularSeeAll');

genreBox.innerHTML = String(html`
    <button type="button" class="genre-tag active" data-genre="" aria-pressed="true">Semua</button>
    ${GENRES.map((g) => html`<button type="button" class="genre-tag" data-genre="${g.label}" aria-pressed="false">${g.label}</button>`)}
`);

function markGenre(genre) {
    genreBox.querySelectorAll('.genre-tag').forEach((t) => {
        const on = (t.dataset.genre || '') === genre;
        t.classList.toggle('active', on);
        t.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

/** Hasil genre tampil di section Populer (di atas tombol genre) → gulir ke sana bila tidak terlihat. */
function revealPopular() {
    const section = $('#popular');
    if (section.getBoundingClientRect().top < 0) section.scrollIntoView({ behavior: smooth(), block: 'start' });
}

async function selectGenre(genre) {
    markGenre(genre);
    popular.genre = genre;
    const grid = GRIDS.popular;
    if (!genre) {
        popularTitle.textContent = 'Anime Populer';
        popularSeeAll.href = browseUrl('popular');
        await loadSection('popular'); // dari cache → instan
        return;
    }
    const token = ++popular.token;
    popularTitle.textContent = `Genre: ${genre}`;
    popularSeeAll.href = genreUrl(genre);
    showSkeleton(grid);
    setSectionNote(grid);
    revealPopular();

    const res = await getGenreAnime(genre);
    if (token !== popular.token) return; // klik genre lain sebelum selesai
    if (res.items.length) {
        renderCards(grid, res.items, { isBookmarked });
    } else if (res.error && res.error.kind !== 'empty') {
        gridMessage(grid, {
            icon: '⚠️',
            title: 'Gagal memuat genre',
            text: friendlyError(res.error),
            actions: html`<button type="button" class="btn-ext btn-ext--retry" data-action="retry-genre">🔄 Coba Lagi</button>`,
        });
    } else {
        gridMessage(grid, { icon: '📭', text: `Tidak ada anime dengan genre "${genre}"` });
    }
}

delegate(genreBox, 'click', '.genre-tag', (_e, tag) => selectGenre(tag.dataset.genre || ''));
delegate(GRIDS.popular, 'click', '[data-action="retry-genre"]', () => {
    retrySourcesNow();
    selectGenre(popular.genre);
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
                <p class="bookmark-empty-icon" aria-hidden="true">🔖</p>
                <h3>Belum ada bookmark</h3>
                <p>Klik ikon 🔖 di kartu anime untuk menambahkan bookmark!</p>
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
    backend: `🕒 Jadwal rilis Sub Indo dalam ${SCHEDULE.label} (Samehadaku) · donghua dari AnimeXin (tanpa jam) · klik judul untuk episode terbaru.`,
    anilist: `🕒 Jam tayang dalam ${SCHEDULE.label} (UTC+7) · ${SCHEDULE.perDay} anime terpopuler per hari · sumber: AniList · klik judul untuk menonton.`,
    mal: `🕒 Jam tayang dalam ${SCHEDULE.label}, dikonversi dari jadwal siaran Jepang (sumber: MyAnimeList).`,
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
        scheduleNote.innerHTML = String(html`⚠️ Jadwal contoh (data cadangan). ${friendlyError(res.error)} <button type="button" class="schedule-retry" data-action="retry">🔄 Coba lagi</button>`);
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
renderScheduleSkeleton(scheduleGrid, { today: wibWeekday() });
whenVisible($('#jadwal'), loadSchedule);

// Datang dari halaman lain lewat index.html#bookmarks: section ini baru tampil setelah JS jalan
if (window.location.hash === '#bookmarks' && !bookmarkSection.hidden) {
    requestAnimationFrame(() => bookmarkSection.scrollIntoView({ block: 'start' }));
}

console.info('%c🌸 Kazanime — Tahap D (data live: AniList → Jikan → Kitsu → cadangan; donghua dari backend scraper)', 'color:#ff6b9d;font-weight:bold');
