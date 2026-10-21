/**
 * Kazanime — ui/skeleton.js
 * Skeleton loading. Dulu skeleton memakai inline style height:270px yang
 * MENGALAHKAN tinggi responsif (200px/180px di mobile) → layout melompat saat
 * data datang. Sekarang tingginya ikut aturan .anime-card-img di CSS.
 */
import { html } from './dom.js';
import { UI } from '../config.js';

const SKELETON_CARD = html`
    <div class="anime-card skeleton-card" aria-hidden="true">
        <div class="anime-card-img loading-shimmer"></div>
        <div class="anime-card-info">
            <div class="skeleton-line loading-shimmer"></div>
            <div class="skeleton-line skeleton-line--short loading-shimmer"></div>
        </div>
    </div>`;

export function skeletonCards(count = UI.skeletonCount) {
    return html`${Array.from({ length: count }, () => SKELETON_CARD)}`;
}

/** Isi grid dengan skeleton & tandai aria-busy. */
export function showSkeleton(grid, count = UI.skeletonCount) {
    if (!grid) return;
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = String(skeletonCards(count));
}
