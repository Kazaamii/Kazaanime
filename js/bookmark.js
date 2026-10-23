/**
 * Kazanime — bookmark.js (halaman bookmark.html)
 *
 * 24 Okt 2026 (permintaan pengguna): daftar bookmark dipindah dari beranda & navbar
 * ke halaman sendiri supaya navigasi tidak sesak. Halaman ini:
 *   - menampilkan semua bookmark akun aktif (sumber kebenaran tetap services/bookmark.js),
 *   - bisa dicari (judul/judul alternatif) dan diurutkan (disimpan, A–Z, rating),
 *   - menampilkan ajakan masuk bila belum login,
 *   - memakai kartu varian "bookmark" (tombol bookmark = hapus dari daftar).
 *
 * Tidak ada request jaringan: bookmark dibaca dari localStorage akun.
 */
import { initLayout } from './ui/layout.js';
import { renderCards, gridMessage, bindCardActions, syncBookmarkButtons } from './ui/card.js';
import { getBookmarks, onBookmarksChange } from './services/bookmark.js';
import { onAuthChange } from './services/auth.js';
import { openAuthModal } from './ui/auth-modal.js';
import { html, $, delegate } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { homeSectionUrl } from './routes.js';

const ctx = initLayout();

const toolbar = $('#bookmarkToolbar');
const searchInput = $('#bookmarkSearch');
const sortSelect = $('#bookmarkSort');
const totalEl = $('#bookmarkTotal');
const grid = $('#bookmarkGrid');
const subtitle = $('#bookmarkSubtitle');

const state = { query: '', sort: 'saved' };

/** Urutkan tanpa mengubah daftar asli penyimpanan. */
function sortList(list) {
    const out = list.slice();
    if (state.sort === 'title') {
        out.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'id', { sensitivity: 'base' }));
    } else if (state.sort === 'score') {
        out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    }
    return out;
}

/** Cocokkan kata kunci ke judul utama atau judul alternatif. */
function matches(anime, query) {
    if (!query) return true;
    const needle = query.toLowerCase();
    return [anime.title, anime.titleAlt]
        .filter(Boolean)
        .some((title) => String(title).toLowerCase().includes(needle));
}

function render() {
    const user = ctx.getUser();
    const all = user ? getBookmarks() : [];

    if (toolbar) toolbar.hidden = !user || all.length === 0;
    if (totalEl) {
        const shown = all.filter((anime) => matches(anime, state.query)).length;
        totalEl.textContent = all.length ? `${shown} dari ${all.length} judul` : '';
    }

    if (!user) {
        if (subtitle) subtitle.textContent = 'Masuk dulu untuk melihat anime yang kamu simpan.';
        gridMessage(grid, {
            icon: 'bookmark',
            title: 'Bookmark ada di akunmu',
            text: 'Login atau daftar untuk menyimpan anime dan membukanya lagi dari halaman ini.',
            actions: html`<button type="button" class="btn-ext" data-action="login">${icon('user')} Masuk / Daftar</button>`,
        });
        return;
    }

    if (subtitle) subtitle.textContent = 'Anime yang kamu simpan tersimpan di akun ini — bisa dibuka lagi kapan saja.';

    if (!all.length) {
        gridMessage(grid, {
            icon: 'bookmark',
            title: 'Belum ada bookmark',
            text: 'Klik ikon bookmark di pojok kartu anime untuk menambahkannya ke halaman ini.',
            actions: html`<a class="btn-ext" href="${homeSectionUrl('ongoing')}">${icon('library')} Jelajahi anime</a>`,
        });
        return;
    }

    const visible = sortList(all.filter((anime) => matches(anime, state.query)));
    if (!visible.length) {
        gridMessage(grid, {
            icon: 'search',
            title: `Tidak ada bookmark berjudul “${state.query}”`,
            text: 'Coba kata kunci lain, atau hapus isi kolom pencarian.',
        });
        return;
    }
    renderCards(grid, visible, { variant: 'bookmark', isBookmarked: () => true });
}

render();
onBookmarksChange(render);
onAuthChange(render);

if (searchInput) {
    searchInput.addEventListener('input', () => {
        state.query = searchInput.value.trim();
        render();
    });
}

if (sortSelect) {
    sortSelect.addEventListener('change', () => {
        state.sort = sortSelect.value;
        render();
    });
}

delegate(grid, 'click', '[data-action="login"]', (event) => {
    event.preventDefault();
    openAuthModal('login');
});

// Kartu varian bookmark: klik ikon bookmark = hapus dari daftar (event memicu render ulang).
bindCardActions(grid, (anime) => ctx.toggleBookmark(anime));
onBookmarksChange(() => syncBookmarkButtons(() => true, grid));
