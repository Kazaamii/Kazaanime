/**
 * Kazanime — watch.js (entry point watch.html)
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ TAHAP A — PRATINJAU STRUKTUR & CSS                               │
 * │ Membaca parameter URL & merender kerangka halaman.               │
 * │ Tahap C: SATU implementasi player (gabungan modal + streaming    │
 * │ page lama) dengan fallback server otomatis, daftar episode asli, │
 * │ info anime, bookmark, download, rekomendasi.                     │
 * └──────────────────────────────────────────────────────────────────┘
 */
import { initLayout, STAGE_B_NOTICE } from './ui/layout.js';
import { renderCards, bindCardActions } from './ui/card.js';
import { showToast } from './ui/toast.js';
import { html, $, delegate, placeholderImage } from './ui/dom.js';
import { parseWatchParams, PAGES } from './routes.js';
import { titleKey } from './api/normalize.js';
import { LEGAL_PLATFORMS } from './config.js';
import { FALLBACK_HERO, FALLBACK_ONGOING, FALLBACK_POPULAR, FALLBACK_NEW, FALLBACK_DONGHUA } from './data/fallback.js';

initLayout();

const params = parseWatchParams();
const stage = $('#playerStage');

/* ---------- Tanpa judul → arahkan kembali ---------- */
if (!params.title) {
    stage.innerHTML = String(html`
        <div class="player-message">
            <div class="player-message-icon" aria-hidden="true">🎬</div>
            <p class="player-message-title">Anime tidak ditemukan</p>
            <p class="player-message-text">Link tidak lengkap. Pilih anime dari beranda atau pencarian.</p>
            <div class="player-message-actions"><a href="${PAGES.home}">Kembali ke Beranda</a></div>
        </div>`);
    $('#watchTitle').textContent = 'Anime tidak ditemukan';
} else {
    renderPreview();
}

function renderPreview() {
    const all = [...FALLBACK_HERO, ...FALLBACK_ONGOING, ...FALLBACK_POPULAR, ...FALLBACK_NEW, ...FALLBACK_DONGHUA];
    const known = all.find((a) => titleKey(a.title) === titleKey(params.title));
    let ep = params.ep;

    document.title = `${params.title} - Episode ${ep} | Kazanime`;
    $('#watchTitle').textContent = params.title;
    const setEpisodeLabel = () => { $('#watchEpisodeLabel').textContent = `Episode ${ep} • Subtitle Indonesia`; };
    setEpisodeLabel();

    $('#watchMeta').innerHTML = String(html`
        ${known?.score != null ? html`<span class="meta-score">⭐ ${known.score.toFixed(1)}</span>` : ''}
        <span>📺 Sub Indo</span><span>🎬 Streaming</span><span>📡 Multi-Server</span>
        ${params.anilist ? html`<span>AniList #${params.anilist}</span>` : ''}
        ${params.mal ? html`<span>MAL #${params.mal}</span>` : ''}`);

    stage.innerHTML = String(html`
        <div class="player-message">
            <div class="player-message-icon" aria-hidden="true">🛠️</div>
            <p class="player-message-title">Player diaktifkan di Tahap C</p>
            <p class="player-message-text">Satu player terpadu dengan fallback otomatis ke server berikutnya bila server gagal.</p>
        </div>`);
    $('#playerStatusText').textContent = 'Tahap A: pratinjau tata letak halaman nonton.';

    /* Info anime */
    const poster = $('#watchPoster');
    poster.classList.remove('loading-shimmer');
    poster.innerHTML = String(html`<img src="${known?.image || placeholderImage(params.title)}" alt="${params.title}" data-fallback>`);
    $('#watchSynopsis').innerHTML = String(html`<p class="watch-synopsis">${known?.description || 'Sinopsis akan dimuat dari AniList/Jikan/Kitsu di Tahap C.'}</p>`);
    $('#watchGenres').innerHTML = String(html`${(known?.genres || []).map((g) => html`<span>${g}</span>`)}`);

    /* Episode (pratinjau 12 tombol; Tahap C: jumlah asli + rentang untuk >100 ep) */
    const epGrid = $('#episodeGrid');
    const total = Math.max(12, ep);
    epGrid.innerHTML = String(html`${Array.from({ length: total }, (_, i) => html`<button type="button" class="ep-btn${i + 1 === ep ? ' active' : ''}" data-ep="${i + 1}">EP ${i + 1}</button>`)}`);
    delegate(epGrid, 'click', '.ep-btn', (_e, btn) => {
        ep = Number(btn.dataset.ep);
        epGrid.querySelectorAll('.ep-btn').forEach((b) => b.classList.toggle('active', b === btn));
        setEpisodeLabel();
        const url = new URL(window.location.href);
        url.searchParams.set('ep', String(ep));
        history.replaceState(null, '', url);
    });

    /* Server (pratinjau, belum aktif) */
    $('#serverButtons').innerHTML = String(html`
        <button type="button" class="server-btn active" disabled>🇯🇵 Server 1 (MegaPlay - AniList)</button>
        <button type="button" class="server-btn" disabled>🇺🇸 Server 2 (MegaPlay - MAL)</button>`);

    /* Download */
    $('#downloadList').innerHTML = String(html`
        <div class="download-notice download-notice--warn">
            <strong>⚠️ Belum aktif.</strong> Link download diambil lewat backend (Tahap D) — tidak ada lagi tombol download palsu.
        </div>`);

    /* Platform legal (final) */
    $('#platformsGrid').innerHTML = String(html`${LEGAL_PLATFORMS.map((p) => html`
        <a class="platform-card" data-platform="${p.id}" href="${p.url(params.title)}" target="_blank" rel="noopener noreferrer">
            <span class="platform-icon" aria-hidden="true">${p.icon}</span>
            <div><div class="platform-name">${p.name}</div><div class="platform-desc">${p.description}</div></div>
        </a>`)}`);

    /* Rekomendasi */
    renderCards($('#recommendationGrid'), FALLBACK_POPULAR.filter((a) => titleKey(a.title) !== titleKey(params.title)).slice(0, 6));
}

$('#watchBookmarkBtn').addEventListener('click', () => showToast(STAGE_B_NOTICE, 'info'));
bindCardActions($('#recommendationGrid'), () => showToast(STAGE_B_NOTICE, 'info'));
