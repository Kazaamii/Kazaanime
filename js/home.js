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
import { getBookmarks, onBookmarksChange } from './services/bookmark.js';
import { icon } from './ui/icons.js';
import { evidenceSummary, isPolicyStop, issuesSummary, safeHomeUrl, sourceDiagnosis, sourceStatusLabel } from './ui/subindo-state.js';

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

const SUB_INDO_HOME_LIMIT = SUB_INDO.resultLimit;
const subIndoStatus = $('#subIndoStatus');
const subIndoFeedList = $('#subIndoFeedList');

/** Ringkasan kecil di bawah intro: situs, judul terverifikasi, episode diperiksa. */
function renderSubIndoSummary(sources, result = {}) {
    const list = Array.isArray(sources) ? sources : [];
    if (!subIndoStatus) return;
    if (!list.length) {
        subIndoStatus.textContent = '';
        if (subIndoFeedList) subIndoFeedList.textContent = 'Tidak ada sumber Sub Indo yang aktif.';
        return;
    }
    const total = list.reduce((sum, source) => sum + (Array.isArray(source.items) ? source.items.length : 0), 0);
    const checked = list.reduce((sum, source) => sum + (Number(source.checked) || 0), 0);
    const failed = list.filter((source) => source.timedOut || source.error || source.failedChecks).length;
    const incomplete = Boolean(result.timedOut) || failed > 0;
    const incompleteText = incomplete
        ? (failed >= list.length ? 'semua sumber belum lengkap' : 'sebagian belum lengkap')
        : '';
    subIndoStatus.textContent = [
        `${list.length} situs`,
        `${total} judul terverifikasi`,
        checked ? `${checked} episode diperiksa` : '',
        incompleteText,
    ].filter(Boolean).join(' · ');
    if (subIndoFeedList) {
        subIndoFeedList.textContent = `Feed: ${list.map((source) => source.name).join(', ')}.`;
    }
}

/** Baris status per sumber: episode diperiksa, kegagalan, dan yang tanpa bukti Sub Indo. */
function subIndoSourceMeta(source) {
    const bits = [];
    if (Number(source.checked) > 0) bits.push(`${source.checked} episode diperiksa`);
    if (Number(source.failedChecks) > 0) bits.push(`${source.failedChecks} gagal`);
    if (Number(source.unproven) > 0) bits.push(`${source.unproven} tanpa bukti`);
    if (source.timedOut) bits.push('batas waktu');
    if (source.stale) bits.push('data cache');
    const proof = evidenceSummary(source.items);
    if (proof) bits.push(`bukti: ${proof}`);
    return bits.join(' · ');
}

/**
 * Keterangan global di bawah panel: sebab kegagalan yang sama digabung sekali
 * (mis. "challenge keamanan" untuk dua situs) supaya tidak diulang per panel.
 */
function updateSubIndoNote(sections) {
    const summary = issuesSummary(sections);
    if (!summary.count) {
        setSectionNote(subIndoRoot);
        return;
    }
    setSectionNote(subIndoRoot, {
        text: summary.text,
        onRetry: () => {
            retrySourcesNow();
            loadSubIndoSection({ refresh: true });
        },
    });
}

/**
 * Panel tanpa judul terverifikasi: satu baris ringkas (ikon + diagnosis +
 * tindakan) menggantikan kotak kosong besar yang isinya mengulang kepala panel.
 * Tautan "Buka situs" hanya membuka situs di tab baru — tidak ada upaya
 * menembus pembatasan otomatis.
 */
function renderSubIndoEmpty(grid, source) {
    const policyStop = isPolicyStop(source);
    // "Tanpa bukti" bukan kegagalan teknis: tidak perlu tombol coba lagi, cukup dijelaskan.
    const trouble = Boolean(source.error || source.failedChecks || source.timedOut);
    const homeUrl = safeHomeUrl(source.homeUrl);
    const iconName = policyStop
        ? 'lock'
        : source.error
            ? 'triangle-alert'
            : source.timedOut
                ? 'hourglass'
                : 'inbox';
    grid.innerHTML = String(html`
        <p class="subindo-empty${policyStop ? ' is-policy' : ''}">
            <span class="subindo-empty-icon" aria-hidden="true">${icon(iconName)}</span>
            <span class="subindo-empty-text">${sourceDiagnosis(source)}</span>
            <span class="subindo-empty-actions">
                ${homeUrl ? html`<a class="subindo-empty-link" href="${homeUrl}" target="_blank" rel="noopener noreferrer">${icon('external-link')} Buka situs</a>` : ''}
                ${trouble ? html`<button type="button" class="subindo-retry" data-action="retry-subindo-source" data-source="${source.id}">${icon('refresh-cw')} Coba lagi</button>` : ''}
            </span>
        </p>`);
    grid.setAttribute('aria-busy', 'false');
}

function renderSubIndoSources(sources, result = {}) {
    const list = Array.isArray(sources) ? sources : [];
    subIndoRoot.setAttribute('aria-busy', 'false');
    renderSubIndoSummary(list, result);
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
        const trouble = Boolean(source.error || source.failedChecks || source.timedOut);
        const status = sourceStatusLabel(source, items.length);
        // Tanpa judul, diagnosis tampil sekali di baris ringkas (renderSubIndoEmpty);
        // jangan ulangi kalimat yang sama di kepala panel.
        const warnings = [];
        if (items.length) {
            if (source.error) warnings.push(friendlyError(source.error));
            if (source.timedOut) warnings.push('Pemeriksaan dihentikan karena batas waktu. Hasil yang tampil sudah terverifikasi.');
            if (source.failedChecks) warnings.push('Sebagian episode terbaru belum dapat diperiksa; judul tanpa bukti tidak ditampilkan.');
            if (source.stale) warnings.push('Menampilkan cache karena feed belum berhasil diperbarui.');
        }
        const meta = subIndoSourceMeta(source);
        return html`
            <section class="subindo-source${items.length ? '' : ' is-empty'}" aria-labelledby="subindo-source-title-${index}">
                <div class="subindo-source-header">
                    <h3 id="subindo-source-title-${index}">${source.name}</h3>
                    <span class="subindo-source-count ${trouble || source.stale ? 'is-stale' : ''}">${status}</span>
                    ${source.browse ? html`<a class="subindo-source-more" href="${katalogUrl({ source: source.id })}">Lihat semua</a>` : ''}
                </div>
                ${meta ? html`<p class="subindo-source-meta">${meta}</p>` : ''}
                ${warnings.length ? html`<p class="subindo-source-warning">${warnings.join(' ')}
                    ${trouble ? html`<button type="button" class="subindo-retry" data-action="retry-subindo-source" data-source="${source.id}">${icon('refresh-cw')} Coba lagi</button>` : ''}
                </p>` : ''}
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
        subIndoState = result;
        renderSubIndoSources(result.sections, result);
        updateSubIndoNote(result.sections);
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

delegate(subIndoRoot, 'click', '[data-action="retry-subindo"]', () => {
    retrySourcesNow();
    loadSubIndoSection({ refresh: true });
});

/**
 * Coba lagi SATU panel sumber: katalog diambil ulang tanpa cache (refresh),
 * lalu hanya episode situs itu yang diperiksa; panel lain tetap memakai hasil
 * yang sudah ada.
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
        // refresh: katalog diambil ulang karena sumber yang gagal tidak punya item di cache lama.
        const result = await getSubIndoHomeSources({ sourceIds: [id], refresh: true });
        const updated = result.sections.find((source) => source.id === id);
        if (!updated) {
            // Sumber tidak lagi ada di feed backend: kembalikan panel lama, jangan biarkan skeleton.
            if (subIndoState) renderSubIndoSources(subIndoState.sections, subIndoState);
            return;
        }
        if (!subIndoState) return;
        const sections = subIndoState.sections.map((source) => (source.id === id ? updated : source));
        subIndoState = {
            ...subIndoState,
            sections,
            timedOut: sections.some((source) => source.timedOut),
        };
        renderSubIndoSources(sections, subIndoState);
        updateSubIndoNote(sections);
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
