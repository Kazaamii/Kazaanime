/**
 * Kazanime — watch.js (entry point watch.html)
 *
 * Halaman nonton = SATU implementasi player untuk seluruh situs. Modal player
 * (#playerModal) dan "streaming page" di file asli — dua salinan logika yang
 * saling override — digabung ke sini dan ke ui/player.js.
 *
 * Alur:
 *  1. initLayout() → navbar, footer, modal, autocomplete, status API, auth.
 *  2. Parameter URL (title, ep, anilist, mal, kitsu, slug, src) → anime sementara:
 *     judul, label episode, bookmark & platform legal tampil instan.
 *  3. Tombol server tampil "Server 1, 2, …" sesuai urutan putar + badge bahasa/jenis subtitle
 *     (nama penyedia/situs sumber tidak ditampilkan).
 *     Server hasil SCRAPING didahulukan (PLAYER.serverOrder = 'scrape-first'): untuk setiap
 *     episode player menunggu backend (AnimeXin / Samehadaku) dulu — anime dari AniList/MAL/
 *     Kitsu dicarikan padanannya lewat judul + judul alternatif — maks. PLAYER.scrapeWaitMs.
 *     Tidak ada di situs sumber / gagal / kelamaan → server Multi Sub (AniZone) dicoba lebih dulu,
 *     lalu server bahasa lain bila tersedia; tanpa id → menunggu detail dulu.
 *     'static-first' = perilaku Tahap D (server statis dulu, kecuali URL membawa slug).
 *  4. getWatchData() → detail + jumlah episode tayang + rekomendasi
 *     (AniList: 1 request; cadangan Kitsu → data dari URL).
 *  5. Ganti episode tanpa reload; URL ikut diperbarui (replaceState) → bisa di-share.
 *  6. Auto-next lewat postMessage player, penanda episode yang sudah ditonton,
 *     server/link download per-episode; paket full-series Kusonime dicari terpisah dari metadata judul.
 *
 * Tidak ada fetch di sini: data dari js/api, tampilan dari js/ui.
 */
import { initLayout } from './ui/layout.js';
import { createPlayer } from './ui/player.js';
import { openAdGuide } from './ui/ad-guide.js';
import { filterAdServers, checkHosts } from './services/adblock.js';
import { createEpisodeList } from './ui/episode-list.js';
import { renderDownloads } from './ui/download-list.js';
import { renderCards, bindCardActions, syncBookmarkButtons, gridMessage } from './ui/card.js';
import { showSkeleton } from './ui/skeleton.js';
import { setSectionNote } from './ui/notice.js';
import { showToast } from './ui/toast.js';
import { html, $, placeholderImage } from './ui/dom.js';
import { PAGES, genreUrl, parseWatchParams, watchUrl } from './routes.js';
import { DAY_NAMES, GENRES, LEGAL_PLATFORMS, PLAYER, SCHEDULE, STORAGE_KEYS } from './config.js';
import { airedEpisodeCount, formatLabel, seasonLabel, statusLabel, titleKey } from './api/normalize.js';
import {
    friendlyError, getAiSubtitlePart, getEpisodeExtras, getEpisodeSubtitles, getKusonimeDownloads, getRecommendations, getStreamServers, getWatchData, isBackendEnabled, listStreamServers, provisionalAnime,
    retrySourcesNow, SUB_INDO_SOURCES, withProviderServers,
} from './api/index.js';
import { onBookmarksChange } from './services/bookmark.js';
import { getWatchedEpisodes, markWatched } from './services/history.js';
import { storage } from './services/storage.js';
import { icon } from './ui/icons.js';

const ctx = initLayout();
const isBookmarked = (a) => ctx.isBookmarked(a);
const params = parseWatchParams();
/** @type {import('./api/index.js').AnimeRef} */
const ref = { title: params.title, alt: params.alt, anilist: params.anilist, mal: params.mal, kitsu: params.kitsu, slug: params.slug, src: params.src };

const els = {
    wrapper: $('#playerWrapper'),
    title: $('#watchTitle'),
    altTitle: $('#watchAltTitle'),
    epLabel: $('#watchEpisodeLabel'),
    meta: $('#watchMeta'),
    bookmarkBtn: $('#watchBookmarkBtn'),
    info: $('#watchInfo'),
    poster: $('#watchPoster'),
    synopsis: $('#watchSynopsis'),
    genres: $('#watchGenres'),
    downloads: $('#downloadList'),
    kusonimeDownloads: $('#kusonimeDownloadList'),
    platforms: $('#platformsGrid'),
    platformsSection: $('#platformsSection'),
    nextAiring: $('#watchNextAiring'),
    autoNext: $('#autoNextToggle'),
    prev: $('#btnPrevEp'),
    next: $('#btnNextEp'),
    nextServer: $('#btnNextServer'),
    externalPlayer: $('#btnExternalPlayer'),
    recs: $('#recommendationGrid'),
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
/** @type {import('./api/normalize.js').Anime} */
let anime = provisionalAnime(ref);
let ep = params.ep;
/** URL ep=latest (tautan Jadwal Rilis): episode ditentukan setelah detail dimuat. */
let wantLatest = params.latest;
/** Episode yang bisa dipilih: undefined = memuat · null = tidak diketahui · 0 = belum tayang · n */
let total;
let detailLoaded = false;
let detailToken = 0;
/** Server hasil scraping backend (AnimeXin / Samehadaku) untuk episode aktif. */
let backendServers = [];
/** @type {AbortController|null} */
let extrasCtrl = null;
/** Kusonime package lookup follows anime detail, not the per-episode extras lifecycle. */
let kusonimeCtrl = null;
let kusonimeLoadToken = 0;
/**
 * Episode yang sedang MENUNGGU hasil scraping sebelum diputar (scrape-first).
 * Selama menunggu, server cadangan tidak dimulai — bila sumber menyediakan Multi Sub, itulah yang
 * diprioritaskan; bila tidak, server lain tetap bisa diputar.
 */
let holdFor = null;
/** Episode yang pencarian scraping-nya sudah selesai TANPA server (atau batas tunggu habis). */
let scrapeDoneFor = null;
let holdTimer = 0;
/** Judul yang terakhir dipakai mencari padanan di backend (dicari ulang bila detail membawa judul baru). */
let scrapedTitles = '';
/** Pencarian/permintaan server backend sedang berjalan. */
let extrasBusy = false;
/** Pernah dapat server Sub Indo (AnimeKu/Animeloverz) untuk anime ini? */
let subIndoSeen = false;
/** Sudah mencoba ulang karena Sub Indo hilang pada episode ini? */
let subIndoRetryFor = null;
/** Detail membawa judul baru saat pencarian masih berjalan → cari lagi bila hasilnya kosong. */
let rescrapePending = false;
/**
 * Server dari penyedia berbasis id/judul (ReAnime, AniZone) untuk episode aktif (22 Okt 2026).
 * null = masih dicari (slot tampil "mencari…").
 * @type {{servers: object[], status: Record<string,string>, error?: unknown}|null}
 */
let providerResult = null;
/** @type {AbortController|null} */
let providerCtrl = null;
/** id AniList + judul yang dipakai permintaan penyedia terakhir (diminta ulang bila detail membawa data baru). */
let providerKey = '';

const smooth = () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
const urlFor = (n) => watchUrl(anime, n, { src: ref.src, slug: ref.slug });
/** Anime berasal dari backend scraper (URL membawa slug) → daftar episode situs sumber = yang bisa diputar. */
const fromBackendSource = () => Boolean(ref.slug) && isBackendEnabled();
/** Server hasil scraping diputar lebih dulu (PLAYER.serverOrder, atau anime dari kartu backend). */
const scrapeFirst = () => isBackendEnabled() && (Boolean(ref.slug) || PLAYER.serverOrder !== 'static-first');
const staticServers = () => listStreamServers(anime, ep);

/** Badge & keterangan bahasa dan jenis subtitle untuk tombol server. */
const LANG_BADGE = { id: 'Sub Indo', en: 'Sub Eng', multi: 'Multi Sub' };
const LANG_DESC = { id: 'Subtitle Indonesia', en: 'Subtitle Inggris', multi: 'Beberapa pilihan subtitle' };
const SUBTITLE_TYPE_BADGE = { hard: 'Hardsub', soft: 'Softsub' };
const SUBTITLE_TYPE_DESC = { hard: 'Jenis subtitle: hardsub', soft: 'Jenis subtitle: softsub' };

/**
 * Situs asal server backend: `backend:animeku` / `animeku~slug` → `animeku`.
 * @param {{source?: string}|null} server
 */
const siteOf = (server) => String(server?.source || '').replace(/^backend:/, '').split('~')[0].toLowerCase();
/**
 * Server dari AnimeKu/Oploverz = situs yang katalognya Sub Indo (24 Okt 2026).
 * Server-server ini ditaruh paling depan supaya episode langsung diputar dengan Sub Indo
 * yang sudah tersedia di kedua situs itu — bukan server Multi Sub/Sub Eng lebih dulu.
 */
const isSubIndoSource = (server) => SUB_INDO_SOURCES.includes(siteOf(server));

/**
 * Isi daftar server untuk pemutaran.
 *
 * 24 Okt 2026 (putaran 8) — permintaan pengguna: *"untuk pilihan server sub indo tolong di buat 2
 * dan tuliskan dari web Animeloverz dan animeku jadi ada tombol server terpisah"*. Karena itu:
 *  - dua tombol Sub Indo memakai NAMA SITUS: "AnimeKu" dan "Animeloverz" (bukan "Server 1/2");
 *  - satu tombol per situs (server pertama dari situs itu) supaya jumlahnya tepat dua;
 *  - server lain tetap memakai nomor "Server N" seperti sebelumnya.
 * @param {import('./api/streams.js').StreamServer[]} list
 */
function numbered(list) {
    // Putaran 11: SEMUA daftar server melewati titik ini sebelum tampil, jadi di sini pula
    // URL jaringan iklan dibuang dan host berisiko ditandai ⚠ (tetap bisa dipilih).
    const safe = guardAdServers(list);
    let counter = 0;
    return safe.map((s) => {
        const site = isSubIndoSource(s) ? PLAYER.siteLabels[siteOf(s)] : '';
        if (!site) counter += 1;
        const name = site || `Server ${counter}`;
        return {
            ...s,
            name,
            flag: '',
            badge: [LANG_BADGE[s.lang], SUBTITLE_TYPE_BADGE[s.subtitleType]].filter(Boolean).join(' · '),
            description: [
                LANG_DESC[s.lang],
                SUBTITLE_TYPE_DESC[s.subtitleType],
                site ? `diputar langsung dari ${site}` : '',
                s.source === 'static' ? 'server cadangan' : '',
            ].filter(Boolean).join(' • ') || name,
        };
    });
}

/** Satu server per situs Sub Indo (server pertama) supaya tombolnya tepat dua. */
function firstPerSite(list) {
    const seen = new Set();
    return list.filter((server) => {
        const site = siteOf(server);
        if (seen.has(site)) return false;
        seen.add(site);
        return true;
    });
}

/**
 * Urutan putar (24 Okt 2026):
 *   scrape-first: server AnimeKu & Oploverz (Sub Indo) → server Multi Sub (scraper/AniZone)
 *                 → hasil scraping bahasa lain → server cadangan → server Sub Eng.
 *   static-first: server cadangan dulu, lalu semua server hasil scraping
 */
/** Host yang ada di daftar blokir iklan (hasil /api/ads/check) — hanya penanda, bukan blokir. */
let adRiskHosts = new Set();
/** Ringkasan jumlah server yang dibuang karena URL-nya iklan (ditampilkan sekali per episode). */
let adBlockedCount = 0;

const hostOf = (value) => {
    try { return new URL(String(value || '')).hostname.toLowerCase(); } catch { return ''; }
};

const servers = () => {
    const fallback = withProviderServers(staticServers(), providerResult);
    if (!scrapeFirst()) return numbered([...fallback, ...backendServers]);
    // Dua tombol Sub Indo: AnimeKu & Animeloverz (satu server per situs).
    const subIndo = firstPerSite(backendServers.filter(isSubIndoSource));
    const rest = backendServers.filter((server) => !isSubIndoSource(server));
    const multi = [...rest.filter((s) => s.lang === 'multi'), ...fallback.filter((s) => s.lang === 'multi')];
    const local = rest.filter((s) => s.lang !== 'en' && s.lang !== 'multi');
    const otherFallback = fallback.filter((s) => s.lang !== 'multi' && s.lang !== 'en');
    const english = [...rest.filter((s) => s.lang === 'en'), ...fallback.filter((s) => s.lang === 'en')];
    return numbered([...subIndo, ...multi, ...local, ...otherFallback, ...english]);
};

/**
 * Putaran 11: buang server yang URL-nya jaringan iklan/gateway klik (mis. `…/iclick?…`
 * yang dulu memunculkan halaman JSON di dalam pemutar) dan beri tanda pada host yang ada di
 * daftar blokir AdGuard DNS. Server bertanda TETAP bisa dipilih — host video sah kadang
 * terdaftar, jadi memblokir otomatis berisiko menghilangkan server yang berfungsi.
 * @param {any[]} list
 */
function guardAdServers(list) {
    const { servers: kept, blocked } = filterAdServers(list);
    if (blocked.length && blocked.length !== adBlockedCount) {
        adBlockedCount = blocked.length;
        showToast(`${blocked.length} server disembunyikan karena mengarah ke jaringan iklan.`, 'info');
    } else if (!blocked.length) {
        adBlockedCount = 0;
    }
    if (!adRiskHosts.size) return kept;
    return kept.map((server) => (adRiskHosts.has(hostOf(server.url)) ? { ...server, adRisk: true } : server));
}

/**
 * Tanyakan backend (yang menanyakan DNS AdGuard) reputasi host server yang tampil.
 * Hanya menandai; tidak pernah memblokir atau menghentikan pemutaran.
 */
let adRiskBusy = false;
async function refreshAdRisk() {
    if (adRiskBusy) return;
    const hosts = [...new Set(servers().map((server) => hostOf(server.url)).filter(Boolean))];
    if (!hosts.length) return;
    adRiskBusy = true;
    try {
        const result = await checkHosts(hosts);
        const next = new Set(Object.entries(result).filter(([, blocked]) => blocked).map(([host]) => host));
        const changed = next.size !== adRiskHosts.size || [...next].some((host) => !adRiskHosts.has(host));
        if (changed) {
            adRiskHosts = next;
            if (player.state !== 'message') player.setServers(servers());
        }
    } finally {
        adRiskBusy = false;
    }
}
/** Semua judul yang diketahui (URL + detail) untuk mencari padanan di situs sumber. */
const scrapeTitles = () => [ref.title, ref.alt, anime.title, anime.titleAlt];
/** Kunci himpunan judul (untuk tahu apakah detail membawa judul yang belum dicari). */
const titlesKey = (list) => [...new Set(list.map(titleKey).filter(Boolean))].sort().join('|');

/**
 * Pemeriksaan Sub Indo per episode untuk badge di daftar episode (24 Okt 2026, putaran 3).
 * Sebelumnya badge hanya muncul untuk episode yang sedang dibuka; sekarang backend memeriksa
 * seluruh rentang (maks PLAYER.subtitleMapLimit episode) sekali per anime.
 */
let subtitleMapCtrl = null;
let subtitleMapKey = '';

/**
 * @param {number} limit jumlah episode yang ingin diperiksa (dipotong PLAYER.subtitleMapLimit)
 */
async function loadSubtitleMap(limit) {
    if (!fromBackendSource() || !ref.slug || !(limit > 0)) return;
    const to = Math.min(limit, PLAYER.subtitleMapLimit);
    const key = `${ref.slug}:${to}`;
    if (key === subtitleMapKey) return;
    subtitleMapKey = key;
    subtitleMapCtrl?.abort();
    const ctrl = new AbortController();
    subtitleMapCtrl = ctrl;
    try {
        const map = await getEpisodeSubtitles(ref.slug, { from: 1, to, signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        episodes.setSubtitles(map);
    } catch (err) {
        if (err?.kind !== 'abort') {
            console.info('[watch] pemeriksaan Sub Indo per episode tidak tersedia:', err?.message || err);
        }
        if (subtitleMapKey === key) subtitleMapKey = ''; // boleh dicoba lagi saat episode lain dibuka
    }
}

/**
 * Lepas penahanan episode n dan mulai putar.
 *  - force: hasil scraping sudah datang → server Multi Sub tetap diprioritaskan oleh servers()
 *  - tanpa force: hanya bila pencarian scraping sudah selesai tanpa server (atau batas tunggu
 *    habis) DAN server cadangan siap (id anime diketahui) atau detail sudah dimuat —
 *    anime dari backend tanpa id menunggu detail (id + jumlah episode) dulu.
 * @param {number} n
 * @param {{force?: boolean}} [opts]
 */
function releaseHold(n, { force = false } = {}) {
    if (holdFor !== n) return false;
    if (!force && (scrapeDoneFor !== n || (!detailLoaded && !staticServers().some((s) => s.available)))) return false;
    holdFor = null;
    scrapeDoneFor = null;
    clearTimeout(holdTimer);
    if (total !== 0 && player.state === 'waiting') {
        player.load(n, servers());
        return true;
    }
    return false;
}

/** Pencarian scraping episode n selesai tanpa server / kelamaan → coba server cadangan. */
function scrapeFinished(n) {
    if (holdFor !== n) return;
    scrapeDoneFor = n;
    releaseHold(n);
}

/** Batas tunggu hasil scraping untuk episode n. */
function armHoldTimer(n, ms = PLAYER.scrapeWaitMs) {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => scrapeFinished(n), ms);
}

/** Tahan episode n sampai server hasil scraping datang (atau batas tunggu habis). */
function holdForScrape(n) {
    holdFor = n;
    scrapeDoneFor = null;
    player.showWaiting(`Mencari server Multi Sub atau pilihan bahasa lain untuk Episode ${n}...`);
    armHoldTimer(n);
}

/* ------------------------------------------------------------------ */
/* Komponen                                                            */
/* ------------------------------------------------------------------ */
const player = createPlayer({
    stage: $('#playerStage'),
    serverBox: $('#serverButtons'),
    fullscreenBtn: $('#btnFullscreen'),
    adGuideBtn: $('#btnAdGuide'),
    status: $('#playerStatus'),
    statusText: $('#playerStatusText'),
    getTitle: () => anime.title,
    fetchAiSubtitle: getAiSubtitlePart, // "Subtitle Indonesia (AI)" (hanya bila backend menawarkannya)
    localSubtitleTools: $('#localSubtitleTools'),
    localSubtitleButton: $('#btnLocalSubtitle'),
    clearLocalSubtitleButton: $('#btnClearLocalSubtitle'),
    localSubtitleInput: $('#localSubtitleInput'),
});

const episodes = createEpisodeList({
    grid: $('#episodeGrid'),
    tabs: $('#epRangeTabs'),
    hrefFor: urlFor,
    onSelect: (n) => goToEpisode(n),
});

/* ------------------------------------------------------------------ */
/* Format waktu tayang (WIB)                                           */
/* ------------------------------------------------------------------ */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const pad2 = (n) => String(n).padStart(2, '0');

/** Detik UNIX → "Sabtu, 25 Okt • 23:00 WIB" (selalu WIB, apa pun zona waktu perangkat). */
function formatWib(sec) {
    const d = new Date((sec + SCHEDULE.utcOffsetHours * 3600) * 1000);
    return `${DAY_NAMES[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} • ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} ${SCHEDULE.label}`;
}

/* ------------------------------------------------------------------ */
/* Render: judul, meta, info, platform, bookmark                       */
/* ------------------------------------------------------------------ */
function renderEpisodeLabel() {
    els.epLabel.textContent = `Episode ${ep} • Cek pilihan subtitle`;
    document.title = anime.title ? `${anime.title} - Episode ${ep} | Kazanime` : 'Nonton Anime - Kazanime';
}

function renderMeta() {
    const a = anime;
    const parts = [];
    if (a.score != null) parts.push(html`<span class="meta-score">${icon('star', { cls: 'ic--rating' })}${a.score.toFixed(1)}</span>`);
    if (detailLoaded && a.status !== 'UNKNOWN') parts.push(html`<span>${statusLabel(a)}</span>`);
    if (detailLoaded) parts.push(html`<span>${formatLabel(a)}</span>`);
    const season = seasonLabel(a);
    if (season) parts.push(html`<span>${icon('calendar')}${season}</span>`);
    if (a.episodes) parts.push(html`<span>${icon('film')}${a.episodes} Episode</span>`);
    if (a.duration) parts.push(html`<span>${icon('timer')}${a.duration} mnt</span>`);
    if (a.studios?.length) parts.push(html`<span>${icon('building-2')}${a.studios[0]}</span>`);
    parts.push(html`<span>${icon('captions')}Multi Sub</span>`, html`<span>${icon('server')}Multi-Server</span>`);
    els.meta.innerHTML = String(html`${parts}`);
}

function renderHeader() {
    els.title.textContent = anime.title || (detailLoaded ? 'Judul tidak diketahui' : 'Memuat...');
    els.altTitle.textContent = anime.titleAlt;
    els.altTitle.hidden = !anime.titleAlt;
    renderEpisodeLabel();
    renderMeta();
}

function renderInfo() {
    const a = anime;
    els.poster.classList.remove('loading-shimmer');
    els.poster.innerHTML = String(html`<img src="${a.image || placeholderImage(a.title || 'Kazanime', a.color)}" alt="Poster ${a.title}" decoding="async" data-fallback data-color="${a.color || ''}">`);

    els.synopsis.innerHTML = String(html`
        <p class="watch-synopsis" id="watchSynopsisText">${a.description || 'Sinopsis belum tersedia untuk anime ini.'}</p>
        <button type="button" class="watch-synopsis-toggle" aria-controls="watchSynopsisText" aria-expanded="false" hidden>Selengkapnya ▾</button>`);
    const text = els.synopsis.querySelector('.watch-synopsis');
    const toggle = els.synopsis.querySelector('.watch-synopsis-toggle');
    toggle.addEventListener('click', () => {
        const open = text.classList.toggle('expanded');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? 'Sembunyikan ▴' : 'Selengkapnya ▾';
    });
    // Tombol hanya muncul bila teks benar-benar terpotong (line-clamp 4 baris)
    requestAnimationFrame(() => { toggle.hidden = text.scrollHeight <= text.clientHeight + 2; });

    // Genre yang ada di daftar genre situs → link ke search.html?genre=...
    els.genres.innerHTML = String(html`${a.genres.slice(0, 10).map((g) => {
        const known = GENRES.find((x) => x.label.toLowerCase() === g.toLowerCase());
        return known ? html`<a href="${genreUrl(known.label)}">${g}</a>` : html`<span>${g}</span>`;
    })}`);
}

function renderPlatforms() {
    const t = anime.title;
    els.platformsSection.hidden = !t;
    if (!t) return;
    els.platforms.innerHTML = String(html`${LEGAL_PLATFORMS.map((p) => html`
        <a class="platform-card" data-platform="${p.id}" href="${p.url(t)}" target="_blank" rel="noopener noreferrer">
            <span class="platform-icon" aria-hidden="true">${icon(p.icon)}</span>
            <div><div class="platform-name">${p.name}</div><div class="platform-desc">${p.description}</div></div>
        </a>`)}`);
}

function renderNextAiring() {
    const n = anime.nextAiring;
    const show = Boolean(n?.airingAt) && n.airingAt * 1000 > Date.now() && anime.status !== 'COMPLETED';
    els.nextAiring.hidden = !show;
    if (show) els.nextAiring.innerHTML = String(html`${icon('alarm-clock')} ${n.episode ? `Episode ${n.episode}` : 'Episode berikutnya'} tayang ${formatWib(n.airingAt)}`);
}

function syncWatchBookmark() {
    const usable = Boolean(anime.title);
    const on = usable && ctx.isBookmarked(anime);
    els.bookmarkBtn.classList.toggle('bookmarked', on);
    els.bookmarkBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    els.bookmarkBtn.querySelector('.bookmark-label').textContent = on ? 'Bookmarked' : 'Bookmark';
    els.bookmarkBtn.disabled = !usable;
}

/* ------------------------------------------------------------------ */
/* Episode & navigasi                                                  */
/* ------------------------------------------------------------------ */
function updateNav() {
    els.prev.disabled = ep <= 1;
    els.next.disabled = typeof total === 'number' && ep >= total;
}

function replaceUrl() {
    history.replaceState(history.state, '', urlFor(ep));
}

/** Jumlah tombol episode dari data API (toleransi kecil untuk anime yang baru saja tayang). */
function computeTotal() {
    const aired = airedEpisodeCount(anime);
    if (aired == null || aired === 0) return aired;
    // Anime dari backend: daftar episode situs sumber = yang benar-benar bisa diputar → tanpa toleransi.
    if (fromBackendSource()) return aired;
    return anime.status === 'ONGOING' ? Math.max(aired, Math.min(ep, aired + 2)) : aired;
}

/** Gulir ke player bila sedang tidak terlihat (mis. memilih episode dari daftar di bawah). */
function revealPlayer() {
    const navH = document.querySelector('.navbar')?.offsetHeight || 70;
    const r = els.wrapper.getBoundingClientRect();
    if (r.top < navH - 1 || r.top > window.innerHeight * 0.6) {
        window.scrollTo({ top: Math.max(0, window.scrollY + r.top - navH - 8), behavior: smooth() });
    }
}

function showUpcoming() {
    const n = anime.nextAiring;
    player.showMessage({
        icon: 'hourglass',
        title: 'Anime ini belum tayang',
        text: n?.airingAt ? `Episode ${n.episode || 1} dijadwalkan tayang ${formatWib(n.airingAt)}.` : 'Belum ada episode yang bisa diputar.',
        sub: 'Bookmark dulu agar mudah ditemukan saat sudah tayang.',
        actions: [{ label: html`${icon('play')} Coba putar`, onClick: () => player.load(ep, servers()) }],
        legal: true,
        statusText: 'Belum tayang',
    });
}

/**
 * Putar episode n (tanpa reload halaman).
 * @param {number} n
 * @param {{initial?: boolean, announce?: boolean}} [opts]
 */
function playEpisode(n, { initial = false, announce = true } = {}) {
    ep = n;
    backendServers = [];
    subIndoRetryFor = null;
    providerResult = null;
    holdFor = null;
    scrapeDoneFor = null;
    rescrapePending = false;
    clearTimeout(holdTimer);
    renderEpisodeLabel();
    episodes.setCurrent(n);
    updateNav();
    if (!initial) replaceUrl();
    if (total === 0) showUpcoming();
    else if (scrapeFirst()) holdForScrape(n);
    else player.load(n, servers());
    loadExtras(n);
    if (total !== 0) loadProviders(n);
    if (announce && !initial) showToast(`Episode ${n} dimuat`, 'info');
}

/** Pilihan user (daftar episode, tombol prev/next, input manual). */
function goToEpisode(n) {
    if (!Number.isInteger(n) || n < 1 || n > PLAYER.maxEpisode) return;
    if (typeof total === 'number' && total > 0 && n > total) {
        showToast(`Episode ${n} belum tersedia.`, 'info');
        return;
    }
    if (n === ep && (player.state === 'loading' || player.state === 'playing')) {
        revealPlayer();
        return;
    }
    playEpisode(n);
    revealPlayer();
}

els.prev.addEventListener('click', () => goToEpisode(ep - 1));
els.next.addEventListener('click', () => goToEpisode(ep + 1));
els.nextServer.addEventListener('click', () => player.nextServer());

/*
 * Pemutar eksternal (24 Okt 2026, putaran 8).
 *
 * Permintaan pengguna: tombol "Pop Up block / Izinkan" dihapus karena tidak bekerja
 * ("Sandbox Not Allowed"), dan iklan host streaming diusahakan tidak membuka tab baru.
 * Sandbox iframe dihapus total (lihat js/ui/player.js); sebagai gantinya tombol ini membuka
 * embed yang sedang diputar di TAB BARU. Di tab itu tidak ada halaman Kazanime yang bisa
 * dibajak, dan pengguna bisa menutupnya kapan saja. Lapisan anti-iklan di dalam player
 * menahan klik pertama supaya popunder tidak muncul.
 */
function openExternalPlayer() {
    const url = player.externalUrl();
    if (!url) {
        showToast('Server ini tidak punya tautan pemutar eksternal.', 'info');
        return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    showToast('Pemutar dibuka di tab baru. Tutup tab itu bila sudah selesai.', 'success');
}

els.externalPlayer?.addEventListener('click', openExternalPlayer);

/* ------------------------------------------------------------------ */
/* Auto-next & riwayat tontonan                                        */
/* ------------------------------------------------------------------ */
els.autoNext.checked = (storage.getRaw(STORAGE_KEYS.autoNext) ?? (PLAYER.autoNextDefault ? '1' : '0')) === '1';
els.autoNext.addEventListener('change', () => {
    storage.setRaw(STORAGE_KEYS.autoNext, els.autoNext.checked ? '1' : '0');
    showToast(els.autoNext.checked ? 'Auto-next aktif' : 'Auto-next nonaktif', 'info');
});

function refreshWatched() {
    episodes.setWatched(getWatchedEpisodes(anime));
}

player.on('loaded', ({ ep: n }) => {
    if (anime.title) markWatched(anime, n);
    refreshWatched();
});

player.on('complete', ({ ep: done }) => {
    if (anime.title) markWatched(anime, done);
    refreshWatched();
    if (done !== ep) return;
    const nextEp = done + 1;
    if (typeof total === 'number' && nextEp > total) {
        const n = anime.nextAiring;
        if (anime.status === 'ONGOING' && n?.airingAt) showToast(`Episode ${nextEp} tayang ${formatWib(n.airingAt)}`, 'info');
        else showToast('Selesai! Semua episode telah ditonton.', 'success');
        return;
    }
    if (!els.autoNext.checked) return;
    playEpisode(nextEp, { announce: false });
    showToast(`Otomatis Episode ${nextEp}`, 'success');
});

player.on('servers', ({ count }) => { els.nextServer.disabled = count === 0; });

/* Putaran 11: iklan yang memindahkan pemutar & panduan DNS AdGuard. */
player.on('adblock', ({ type, server }) => {
    if (type === 'takeover') {
        showToast('Iklan memindahkan pemutar. Klik "Pulihkan pemutar" di bawah player, atau pilih server lain.', 'info', 7000);
    } else if (type === 'skipped') {
        showToast(`Server ${server?.name || ''} dilewati karena iklan membajak pemutarnya. Coba server lain.`, 'info', 7000);
    }
});
player.on('adguide', () => openAdGuide());
player.on('fullscreen', ({ on }) => syncFullscreenButton(on));

/** Sinkronkan tombol Layar Penuh dengan status peramban (termasuk saat Esc ditekan). */
function syncFullscreenButton(on = player.isFullscreen()) {
    if (!els.fullscreenBtn) return;
    els.fullscreenBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    els.fullscreenBtn.classList.toggle('is-on', on);
    els.fullscreenBtn.title = on
        ? 'Keluar dari layar penuh'
        : 'Layar penuh: video mengisi layar dan otomatis berputar ke lanskap bila peramban mendukung';
}

els.fullscreenBtn?.addEventListener('click', () => {
    player.toggleFullscreen().then((on) => syncFullscreenButton(on));
});
syncFullscreenButton(false);

els.adGuideBtn?.addEventListener('click', () => openAdGuide());
player.on('retry', () => {
    retrySourcesNow();
    loadDetail();
});

/* ------------------------------------------------------------------ */
/* Data: detail, link download/server backend, rekomendasi             */
/* ------------------------------------------------------------------ */
function applyDetail(data) {
    anime = data.anime;
    detailLoaded = true;
    void loadKusonimeDownloads(); // full-series packs follow title metadata, not the active episode
    total = computeTotal();

    renderHeader();
    renderInfo();
    renderPlatforms();
    renderNextAiring();
    syncWatchBookmark();
    episodes.setTotal(total, {
        emptyText: anime.nextAiring?.airingAt
            ? `Belum ada episode yang tayang. Episode ${anime.nextAiring.episode || 1}: ${formatWib(anime.nextAiring.airingAt)}.`
            : 'Belum ada episode yang tayang.',
    });
    refreshWatched();
    // Badge Sub Indo per episode: backend memeriksa halaman tiap episode (maks 24).
    void loadSubtitleMap(total);

    // Tautan Jadwal Rilis (ep=latest): buka episode terbaru yang sudah ada (atau episode 1)
    if (wantLatest) {
        wantLatest = false;
        playEpisode(total > 0 ? total : 1, { announce: false });
        return;
    }

    // Episode di URL melewati episode yang sudah ada → buka episode terakhir
    if (total && ep > total) {
        showToast(`Episode ${ep} belum tersedia — membuka Episode ${total}.`, 'info');
        playEpisode(total, { announce: false });
        return;
    }
    updateNav();
    replaceUrl(); // URL kini membawa id lengkap (mudah dibagikan)

    // Detail membawa judul yang belum dicari (mis. romaji, URL lama tanpa `alt`) → cari lagi dengan SEMUA judul.
    // Pencarian yang sedang berjalan tidak dibatalkan; bila hasilnya kosong baru dicari ulang.
    const rescrape = scrapeFirst() && !ref.slug && !backendServers.length && total !== 0 && titlesKey(scrapeTitles()) !== scrapedTitles;
    if (rescrape && extrasBusy) rescrapePending = true;
    const rescrapeNow = rescrape && !extrasBusy;
    if (total === 0) showUpcoming();
    else if (holdFor === ep) {
        if (rescrapeNow) {
            scrapeDoneFor = null;
            loadExtras(ep);
            armHoldTimer(ep, Math.round(PLAYER.scrapeWaitMs / 2));
        } else releaseHold(ep); // pencarian sudah selesai tanpa server → server cadangan (belum selesai → menunggu)
    } else {
        if (player.state !== 'message') player.setServers(servers()); // mulai bila menunggu; buka kunci server baru tanpa memutus video
        if (rescrapeNow) loadExtras(ep);
    }
    // Penyedia (ReAnime/AniZone) diminta ulang bila detail membawa id AniList / judul yang belum dipakai.
    if (total !== 0 && providerKeyFor() !== providerKey && !(providerResult?.servers?.length)) loadProviders(ep);
}

const providerTitles = () => [...new Set(scrapeTitles().map((t) => String(t || '').trim()).filter(Boolean))];
const providerKeyFor = () => `${anime.ids?.anilist || ref.anilist || ''}|${titlesKey(providerTitles())}`;

/** Perbarui tombol server (atau mulai putar bila player menunggu tanpa server) — kecuali masih menahan untuk scraping. */
function refreshServers() {
    if (total === 0 || player.state === 'message' || holdFor === ep) return;
    player.setServers(servers());
    refreshAdRisk();
}

/** Server ReAnime + AniZone untuk episode n (lewat backend /api/stream/servers). */
async function loadProviders(n) {
    providerCtrl?.abort();
    const ctrl = new AbortController();
    providerCtrl = ctrl;
    providerResult = null;
    providerKey = providerKeyFor();
    const anilistId = anime.ids?.anilist || ref.anilist || null;
    const titles = providerTitles();
    if (!isBackendEnabled() || (!anilistId && !titles.length)) {
        providerResult = { servers: [], status: {}, error: { kind: isBackendEnabled() ? 'empty' : 'disabled' } };
        refreshServers();
        return;
    }
    try {
        const res = await getStreamServers({ anilist: anilistId, ep: n, titles, year: anime.year || null, signal: ctrl.signal });
        if (ctrl.signal.aborted || n !== ep) return;
        providerResult = res;
    } catch (err) {
        if (err?.kind === 'abort' || ctrl.signal.aborted || n !== ep) return;
        providerResult = { servers: [], status: {}, error: err };
    }
    refreshServers();
}

async function loadDetail() {
    const my = ++detailToken;
    setSectionNote(els.info);
    let data;
    try {
        data = await getWatchData(ref);
    } catch (err) {
        console.error('[watch] gagal memuat detail:', err);
        data = { anime: provisionalAnime(ref), recommendations: null, source: 'fallback', fallback: true, error: err };
    }
    if (my !== detailToken) return;
    applyDetail(data);
    loadRecommendations(data.recommendations);
    if (data.fallback) {
        setSectionNote(els.info, {
            text: `Info anime tidak dapat dimuat. ${friendlyError(data.error)}`,
            onRetry: () => {
                retrySourcesNow();
                loadDetail();
            },
        });
    }
}

function kusonimeTitleCandidates() {
    const seen = new Set();
    return [anime.titleAlt, ref.alt, anime.title, ref.title]
        .map((value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100))
        .filter((value) => {
            if (value.length < 2 || !/\p{Script=Latin}/u.test(value)
                || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) return false;
            const key = titleKey(value);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 4);
}

/** Look up full-series Kusonime packs once per anime detail, independently of each episode. */
async function loadKusonimeDownloads() {
    if (!els.kusonimeDownloads) return;
    kusonimeCtrl?.abort();
    const ctrl = new AbortController();
    kusonimeCtrl = ctrl;
    const token = ++kusonimeLoadToken;
    const isCurrent = () => kusonimeCtrl === ctrl && token === kusonimeLoadToken && !ctrl.signal.aborted;
    const titles = kusonimeTitleCandidates();
    if (!titles.length || !isBackendEnabled()) {
        renderDownloads(els.kusonimeDownloads, {
            disabled: true,
            emptyHeading: 'Paket Kusonime tidak tersedia',
            emptyText: !isBackendEnabled()
                ? 'Backend diperlukan untuk mencari paket di Kusonime.'
                : 'Judul Romaji belum tersedia untuk pencarian paket.',
        });
        return;
    }
    renderDownloads(els.kusonimeDownloads, { loading: true, loadingText: 'Mencari paket anime...' });
    try {
        const result = await getKusonimeDownloads(titles, { signal: ctrl.signal });
        if (!isCurrent()) return;
        renderDownloads(els.kusonimeDownloads, {
            items: result.downloads,
            emptyHeading: 'Paket Kusonime tidak ditemukan',
            source: result.source || 'Kusonime',
            contextLabel: result.matchedTitle ? `Paket anime — ${result.matchedTitle}` : 'Paket anime',
            disabled: result.disabled,
            emptyText: result.disabled
                ? 'Sumber Kusonime dinonaktifkan di konfigurasi deployment.'
                : 'Tidak ditemukan paket dengan judul Romaji yang cocok di Kusonime.',
            onRetry: () => {
                retrySourcesNow();
                loadKusonimeDownloads();
            },
        });
    } catch (err) {
        if (err?.kind === 'abort' || !isCurrent()) return;
        renderDownloads(els.kusonimeDownloads, {
            error: err,
            emptyHeading: 'Paket Kusonime belum bisa dimuat',
            errorText: friendlyError(err),
            emptyText: 'Paket Kusonime belum bisa dimuat.',
            onRetry: () => {
                retrySourcesNow();
                loadKusonimeDownloads();
            },
        });
    }
}

async function loadExtras(n) {
    extrasCtrl?.abort();
    const ctrl = new AbortController();
    extrasCtrl = ctrl;
    extrasBusy = true;
    scrapedTitles = titlesKey(scrapeTitles());
    renderDownloads(els.downloads, { loading: true });
    // Full-series Kusonime packs load from applyDetail, not with episode-specific extras.
    try {
        const res = await getEpisodeExtras(anime, n, { slug: ref.slug, titles: scrapeTitles(), signal: ctrl.signal });
        if (extrasCtrl === ctrl) extrasBusy = false;
        if (ctrl.signal.aborted || n !== ep) return;
        if (!res.servers.length && rescrapePending) {
            // Detail datang dengan judul baru selama pencarian ini → cari lagi dengan semua judul
            rescrapePending = false;
            loadExtras(n);
            return;
        }
        const hasSubIndo = res.servers.some((server) => server.lang === 'id');
        if (hasSubIndo) subIndoSeen = true;
        // "Episode 1 ada Sub Indo, episode lain cuma Sub Inggris": bila sumber Sub Indo yang
        // dikenal gagal dimuat untuk episode ini, coba sekali lagi setelah jeda singkat.
        const lostSubIndo = !hasSubIndo && (res.failedSubIndo?.length || subIndoSeen);
        const willRetry = lostSubIndo && subIndoRetryFor !== n && !res.disabled;
        if (willRetry) {
            subIndoRetryFor = n;
            const waiting = holdFor === n;
            if (!waiting) {
                showToast('Server Sub Indo belum termuat — mencoba sekali lagi…', 'info', 4000);
            }
            setTimeout(() => {
                if (n === ep && !ctrl.signal.aborted) {
                    if (waiting) armHoldTimer(n, Math.round(PLAYER.scrapeWaitMs / 2));
                    loadExtras(n);
                }
            }, 1600);
        }
        if (res.servers.length) {
            backendServers = res.servers;
            if (holdFor === n) releaseHold(n, { force: true }); // server scraping dulu, cadangan di belakangnya
            else if (total !== 0 && player.state !== 'message') {
                // Datang setelah server cadangan diputar → tambahkan tombol tanpa memutus video
                const wasPlaying = player.state === 'loading' || player.state === 'playing';
                player.setServers(servers());
                if (wasPlaying && scrapeFirst()) showToast(`${res.servers.length} server tambahan tersedia — pilih di daftar server.`, 'info');
            }
        } else if (!willRetry) scrapeFinished(n);
        const realError = res.error && res.error.kind !== 'empty' ? res.error : null;
        renderDownloads(els.downloads, {
            items: res.downloads,
            ep: n,
            source: res.source,
            disabled: res.disabled,
            error: realError,
            errorText: realError ? friendlyError(realError) : '',
            onRetry: () => loadExtras(n),
        });
    } catch (err) {
        if (extrasCtrl === ctrl) extrasBusy = false;
        if (err?.kind === 'abort' || ctrl.signal.aborted) return;
        rescrapePending = false;
        if (n === ep) scrapeFinished(n); // backend gagal → server cadangan (bila ada) tetap diputar
        renderDownloads(els.downloads, {
            error: err,
            errorText: friendlyError(err),
            onRetry: () => {
                retrySourcesNow();
                loadExtras(n);
            },
        });
    }
}

async function loadRecommendations(preloaded) {
    try {
        const res = await getRecommendations(anime.title ? anime : null, { preloaded });
        if (res.items.length) renderCards(els.recs, res.items, { isBookmarked });
        else gridMessage(els.recs, { icon: 'inbox', text: 'Belum ada rekomendasi untuk anime ini.' });
    } catch (err) {
        gridMessage(els.recs, { icon: 'triangle-alert', text: friendlyError(err) });
    }
}

/* ------------------------------------------------------------------ */
/* Bookmark                                                            */
/* ------------------------------------------------------------------ */
els.bookmarkBtn.addEventListener('click', () => {
    if (anime.title) ctx.toggleBookmark(anime);
});
bindCardActions(els.recs, (a) => ctx.toggleBookmark(a));
onBookmarksChange(() => {
    syncWatchBookmark();
    syncBookmarkButtons(isBookmarked, els.recs);
});

/* ------------------------------------------------------------------ */
/* Mulai                                                               */
/* ------------------------------------------------------------------ */
function renderNotFound() {
    document.title = 'Anime tidak ditemukan - Kazanime';
    els.title.textContent = 'Anime tidak ditemukan';
    els.epLabel.textContent = 'Link tidak lengkap';
    els.meta.replaceChildren();
    syncWatchBookmark();
    els.prev.disabled = true;
    els.next.disabled = true;
    player.showMessage({
        icon: 'clapperboard',
        title: 'Anime tidak ditemukan',
        text: 'Link tidak lengkap. Pilih anime dari beranda atau pencarian.',
        actions: [{ label: 'Kembali ke Beranda', href: PAGES.home, newTab: false }],
        statusText: 'Anime tidak ditemukan',
    });
    player.setServers(listStreamServers(anime, 1)); // tampil terkunci 🔒
    episodes.setTotal(0, { emptyText: 'Pilih anime dari beranda atau pencarian.' });
    els.poster.classList.remove('loading-shimmer');
    els.synopsis.innerHTML = String(html`<p class="watch-synopsis">Tidak ada anime yang dipilih.</p>`);
    renderDownloads(els.downloads, { disabled: true });
    renderPlatforms();
    showSkeleton(els.recs, 6);
    loadRecommendations(null);
}

function start() {
    renderHeader();
    renderPlatforms();
    syncWatchBookmark();
    subtitleMapKey = '';
    episodes.clearSubtitles();
    episodes.setCurrent(ep);
    episodes.setLoading();
    updateNav();
    showSkeleton(els.recs, 6);

    if (wantLatest) {
        // ep=latest: nomor episode terbaru baru diketahui setelah detail dimuat (applyDetail)
        player.showWaiting('Mencari episode terbaru...');
    } else if (scrapeFirst() || servers().some((s) => s.available)) {
        // scrape-first → menunggu hasil scraping dulu; id sudah ada di URL → tidak perlu menunggu detail
        playEpisode(ep, { initial: true });
    } else {
        player.showWaiting('Mencari ID anime untuk server streaming...');
        loadExtras(ep);
    }
    loadDetail();
}

if (!ref.title && !ref.anilist && !ref.mal && !ref.kitsu && !ref.slug) renderNotFound();
else start();

console.info('%cKazanime — player: Multi Sub diprioritaskan bila tersedia; server lain tetap ditampilkan sesuai bahasa dan ketersediaan', 'color:#ff6b9d;font-weight:bold');
