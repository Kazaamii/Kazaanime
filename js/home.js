/**
 * Kazanime — home.js (entry point index.html)
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ TAHAP A — PRATINJAU STRUKTUR & CSS                               │
 * │ Merender data statis (js/data/fallback.js) agar tampilan bisa    │
 * │ dibandingkan dengan file asli. Tahap B mengganti isi file ini    │
 * │ dengan pemuatan data via js/api/ (cache, timeout, fallback).     │
 * └──────────────────────────────────────────────────────────────────┘
 */
import { initLayout, STAGE_B_NOTICE } from './ui/layout.js';
import { createHeroSlider } from './ui/hero.js';
import { renderCards, bindCardActions } from './ui/card.js';
import { renderSchedule } from './ui/schedule.js';
import { showSkeleton } from './ui/skeleton.js';
import { showToast } from './ui/toast.js';
import { html, $, delegate } from './ui/dom.js';
import { GENRES } from './config.js';
import {
    FALLBACK_HERO, FALLBACK_ONGOING, FALLBACK_POPULAR, FALLBACK_NEW, FALLBACK_DONGHUA, FALLBACK_SCHEDULE,
} from './data/fallback.js';

initLayout();

/* ---------- Hero ---------- */
const hero = createHeroSlider($('#hero'), {
    onBookmark: () => showToast(STAGE_B_NOTICE, 'info'),
});
hero.setSlides(FALLBACK_HERO);

/* ---------- Grid anime ---------- */
const grids = {
    ongoing: $('#ongoingGrid'),
    popular: $('#popularGrid'),
    newRelease: $('#newReleaseGrid'),
    donghua: $('#donghuaGrid'),
};
Object.values(grids).forEach((g) => showSkeleton(g));

// Sedikit jeda agar skeleton terlihat saat pratinjau (Tahap B: data asli)
requestAnimationFrame(() => {
    renderCards(grids.ongoing, FALLBACK_ONGOING);
    renderCards(grids.popular, FALLBACK_POPULAR);
    renderCards(grids.newRelease, FALLBACK_NEW);
    renderCards(grids.donghua, FALLBACK_DONGHUA);
});

bindCardActions($('#main'), () => showToast(STAGE_B_NOTICE, 'info'));

/* ---------- Genre (render dari config; filter aktif di Tahap B) ---------- */
const genreBox = $('#genreTags');
genreBox.innerHTML = String(html`
    <button type="button" class="genre-tag active" data-genre="" aria-pressed="true">Semua</button>
    ${GENRES.map((g) => html`<button type="button" class="genre-tag" data-genre="${g.label}" aria-pressed="false">${g.label}</button>`)}
`);
delegate(genreBox, 'click', '.genre-tag', (_e, tag) => {
    genreBox.querySelectorAll('.genre-tag').forEach((t) => {
        const on = t === tag;
        t.classList.toggle('active', on);
        t.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (tag.dataset.genre) showToast(`Filter genre "${tag.dataset.genre}" aktif di Tahap B.`, 'info');
});

/* ---------- Jadwal ---------- */
renderSchedule($('#scheduleGrid'), FALLBACK_SCHEDULE);
$('#scheduleNote').textContent = 'Jadwal contoh (statis). Tahap B: jadwal tayang asli dari AniList dalam WIB.';

console.info('%c🌸 Kazanime — Tahap A (pratinjau struktur & CSS, data statis)', 'color:#ff6b9d;font-weight:bold');
