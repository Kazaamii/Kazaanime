/**
 * Kazanime — search.js (entry point search.html)
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ TAHAP A — PRATINJAU STRUKTUR & CSS                               │
 * │ Mencocokkan judul di data statis saja. Tahap B: pencarian        │
 * │ gabungan MAL + Kitsu + AniList (dedupe, sort, filter, load more).│
 * └──────────────────────────────────────────────────────────────────┘
 */
import { initLayout, STAGE_B_NOTICE } from './ui/layout.js';
import { renderCards, gridMessage, bindCardActions } from './ui/card.js';
import { showSkeleton } from './ui/skeleton.js';
import { showToast } from './ui/toast.js';
import { $, $$, delegate } from './ui/dom.js';
import { parseSearchParams } from './routes.js';
import { titleKey } from './api/normalize.js';
import { FALLBACK_ONGOING, FALLBACK_POPULAR, FALLBACK_NEW, FALLBACK_DONGHUA } from './data/fallback.js';

initLayout();

const BROWSE = {
    ongoing: { title: 'Ongoing Anime', list: FALLBACK_ONGOING },
    popular: { title: 'Anime Populer', list: FALLBACK_POPULAR },
    new: { title: 'Baru Rilis', list: FALLBACK_NEW },
    donghua: { title: '🐉 Donghua (Anime China)', list: FALLBACK_DONGHUA },
};

const { q, browse } = parseSearchParams();
const grid = $('#searchResultsGrid');
const titleEl = $('#searchResultsTitle');
const subtitleEl = $('#searchResultsSubtitle');

showSkeleton(grid, 8);

let results;
if (browse) {
    titleEl.textContent = BROWSE[browse].title;
    document.title = `${BROWSE[browse].title} - Kazanime`;
    $('#searchSourceTabs').hidden = true; // tab sumber hanya relevan untuk pencarian
    results = BROWSE[browse].list;
} else if (q) {
    titleEl.textContent = `Hasil Pencarian: "${q}"`;
    document.title = `${q} - Cari Anime - Kazanime`;
    const all = [...FALLBACK_ONGOING, ...FALLBACK_POPULAR, ...FALLBACK_NEW, ...FALLBACK_DONGHUA];
    results = all.filter((a) => titleKey(a.title).includes(titleKey(q)));
} else {
    titleEl.textContent = 'Cari Anime';
    results = [];
}

subtitleEl.textContent = 'Tahap A: pratinjau tata letak dengan data statis. Pencarian MAL + Kitsu + AniList aktif di Tahap B.';
$$('[data-count]').forEach((el) => { el.textContent = el.dataset.count === 'all' ? String(results.length) : '0'; });

requestAnimationFrame(() => {
    if (results.length) {
        renderCards(grid, results, { variant: 'search' });
    } else {
        gridMessage(grid, {
            icon: '🔍',
            title: q ? `Tidak ditemukan "${q}" di data pratinjau` : 'Ketik judul anime di kotak pencarian',
            text: 'Coba "one", "solo", atau "soul".',
        });
    }
});

// Tombol filter/tab: hanya status aktif (logika di Tahap B)
delegate($('#searchFilters'), 'click', '.search-filter-btn', (_e, btn) => {
    if (btn.dataset.sort) {
        $$('#searchFilters [data-sort]').forEach((b) => {
            b.classList.toggle('active', b === btn);
            b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
    } else {
        const on = btn.classList.toggle('active');
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
});
delegate($('#searchSourceTabs'), 'click', '.search-source-tab', (_e, tab) => {
    $$('#searchSourceTabs .search-source-tab').forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    });
});

bindCardActions(grid, () => showToast(STAGE_B_NOTICE, 'info'));
