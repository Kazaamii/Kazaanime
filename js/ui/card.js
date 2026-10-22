/**
 * Kazanime — ui/card.js
 * Render kartu anime. Fungsi MURNI: menerima objek Anime (format normalisasi)
 * dan mengembalikan HTML ber-escape. Tidak ada fetch, tidak ada localStorage.
 *
 * Perubahan dari file asli:
 *  - Klik kartu = navigasi ke watch.html?... (link <a> asli: bisa klik-tengah,
 *    buka tab baru, bisa di-share), BUKAN membuka modal player.
 *  - Tidak ada onclick/onerror inline; bookmark ditangani lewat event delegation
 *    oleh pemanggil (lihat bindCardActions).
 *  - Registry key → Anime menggantikan global `animeDataStore` yang dikunci judul.
 */
import { html, raw, delegate, placeholderImage, escapeHtml } from './dom.js';
import { watchUrl } from '../routes.js';
import { episodeLabel, scoreLabel, statusBadge } from '../api/normalize.js';
import { icon, hasIcon } from './icons.js';

const ICON_PLAY = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>');
const ICON_BOOKMARK = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>');

/** Badge sumber: titik warna dari CSS (.src-*), tanpa emoji. */
const SOURCE_BADGES = {
    anilist: { cls: 'src-anilist', label: 'AniList' },
    kitsu: { cls: 'src-kitsu', label: 'Kitsu' },
};
const ratingHtml = (anime) => html`${icon('star', { cls: 'ic--rating' })}${scoreLabel(anime)}`;

/** key → Anime, supaya handler klik bisa mengambil data lengkap kartu. */
const registry = new Map();

export function getCardAnime(key) {
    return registry.get(key) || null;
}

export function rememberAnime(anime) {
    registry.set(anime.id, anime);
    return anime;
}

/**
 * @param {import('../api/normalize.js').Anime} anime
 * @param {{variant?: 'default'|'search'|'bookmark', bookmarked?: boolean, episodeText?: string, episode?: number}} [opts]
 *   episode: episode tujuan link (default 1; "Baru Rilis" memakai episode terbarunya)
 */
export function cardHTML(anime, { variant = 'default', bookmarked = false, episodeText, episode = 1 } = {}) {
    rememberAnime(anime);
    const href = watchUrl(anime, episode);
    const img = anime.image || placeholderImage(anime.title, anime.color);

    let badge = statusBadge(anime);
    let badgeClass = '';
    let quality = anime.quality || '1080p';
    let metaLeft = episodeText || episodeLabel(anime);
    let metaRight = ratingHtml(anime);

    if (variant === 'search') {
        const src = SOURCE_BADGES[anime.source];
        badge = src ? src.label : statusBadge(anime);
        badgeClass = src ? src.cls : '';
        quality = anime.format || 'TV';
        metaLeft = `${anime.year ? `${anime.year} • ` : ''}${episodeLabel(anime)}`;
        metaRight = anime.score != null ? ratingHtml(anime) : 'N/A';
    } else if (variant === 'bookmark') {
        badge = icon('bookmark-check');
        metaRight = html`${icon('bookmark-check')} Saved`;
    }

    const pressed = bookmarked ? 'true' : 'false';
    const label = `${bookmarked ? 'Hapus bookmark' : 'Tambah bookmark'}: ${anime.title}`;

    return html`
    <article class="anime-card" data-key="${anime.id}">
        <div class="anime-card-img">
            <img src="${img}" alt="${anime.title}" loading="lazy" decoding="async" data-fallback data-color="${anime.color || ''}">
            <div class="anime-card-overlay"><div class="play-btn-overlay">${ICON_PLAY}</div></div>
            <span class="anime-card-badge ${badgeClass}">${badge}</span>
            <span class="anime-card-quality">${quality}</span>
            <button type="button" class="card-bookmark-btn ${bookmarked ? 'is-bookmarked' : ''}" data-action="bookmark" data-key="${anime.id}" aria-pressed="${pressed}" aria-label="${label}" title="${label}">${ICON_BOOKMARK}</button>
        </div>
        <div class="anime-card-info">
            <h3 class="anime-card-title"><a class="anime-card-link" href="${href}" title="${anime.title}">${anime.title}</a></h3>
            <div class="anime-card-meta"><span>${metaLeft}</span><span class="anime-card-rating">${metaRight}</span></div>
        </div>
    </article>`;
}

const cardsHTML = (list, { variant, isBookmarked, episodeOf }) => String(html`${list.map((a) => cardHTML(a, {
    variant,
    bookmarked: isBookmarked(a),
    episode: episodeOf ? episodeOf(a) : 1,
}))}`);

/**
 * Render daftar kartu ke grid.
 * @param {Element} grid
 * @param {import('../api/normalize.js').Anime[]} list
 * @param {{variant?: string, isBookmarked?: (a) => boolean, episodeOf?: (a) => number}} [opts]
 */
export function renderCards(grid, list, { variant = 'default', isBookmarked = () => false, episodeOf } = {}) {
    if (!grid) return;
    grid.innerHTML = cardsHTML(list, { variant, isBookmarked, episodeOf });
    grid.setAttribute('aria-busy', 'false');
}

/** Tambahkan kartu di akhir grid (untuk "Muat Lebih Banyak"). */
export function appendCards(grid, list, { variant = 'default', isBookmarked = () => false, episodeOf } = {}) {
    if (!grid) return;
    grid.insertAdjacentHTML('beforeend', cardsHTML(list, { variant, isBookmarked, episodeOf }));
}

/** Perbarui status tombol bookmark semua kartu yang tampil (tanpa render ulang). */
export function syncBookmarkButtons(isBookmarked, root = document) {
    root.querySelectorAll('.card-bookmark-btn[data-key]').forEach((btn) => {
        const anime = registry.get(btn.dataset.key);
        if (!anime) return;
        const on = Boolean(isBookmarked(anime));
        btn.classList.toggle('is-bookmarked', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        const label = `${on ? 'Hapus bookmark' : 'Tambah bookmark'}: ${anime.title}`;
        btn.setAttribute('aria-label', label);
        btn.title = label;
    });
}

/**
 * Pasang SATU listener delegasi untuk tombol bookmark di dalam root.
 * @param {Element|Document} root
 * @param {(anime: import('../api/normalize.js').Anime, button: Element) => void} onBookmark
 */
export function bindCardActions(root, onBookmark) {
    return delegate(root, 'click', '.card-bookmark-btn[data-action="bookmark"]', (event, btn) => {
        event.preventDefault();
        event.stopPropagation();
        const anime = registry.get(btn.dataset.key);
        if (anime) onBookmark(anime, btn);
    });
}

/** Pesan kosong/error di dalam grid. */
export function gridMessage(grid, { icon: iconName = 'inbox', title = '', text = '', actions = '' } = {}) {
    if (!grid) return;
    grid.innerHTML = String(html`
        <div class="empty-state">
            <p class="empty-state-icon" aria-hidden="true">${hasIcon(iconName) ? icon(iconName) : iconName}</p>
            ${title ? html`<h3>${title}</h3>` : ''}
            ${text ? html`<p>${text}</p>` : ''}
            ${actions ? html`<div class="empty-actions">${actions}</div>` : ''}
        </div>`);
    grid.setAttribute('aria-busy', 'false');
}

// Re-export agar pemanggil tidak perlu import dom.js hanya untuk ini
export { escapeHtml };
