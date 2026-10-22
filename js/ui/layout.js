/**
 * Kazanime — ui/layout.js
 * "App shell" bersama: dipanggil SEKALI di awal setiap halaman
 * (home.js / search.js / watch.js). Memasang navbar, footer, modal tema,
 * modal auth, autocomplete pencarian, widget status API, fallback gambar,
 * dan tema tersimpan — lalu menyambungkan UI ke services/auth & bookmark.
 *
 * Perbaikan dari file asli:
 *  - Login/logout/daftar dulu memanggil loadAnimeData() → SEMUA section
 *    di-fetch ulang (±12 request). Sekarang hanya navbar & tombol bookmark yang
 *    diperbarui lewat event, tanpa request jaringan.
 *  - Klik bookmark saat belum login → modal login terbuka, dan setelah berhasil
 *    login anime tersebut langsung ditambahkan (dulu harus klik ulang).
 */
import { installImageFallback } from './dom.js';
import { hydrateIcons } from './icons.js';
import { initTheme } from '../services/theme.js';
import { renderNavbar, setNavUser, getSearchElements } from './navbar.js';
import { renderFooter } from './footer.js';
import { openThemeModal } from './theme-modal.js';
import { mountAuthModals, openAuthModal, openAvatarModal } from './auth-modal.js';
import { initSearchDropdown } from './search-dropdown.js';
import { initApiStatus, showApiStatus } from './api-status.js';
import { showToast } from './toast.js';
import { currentPage } from '../routes.js';
import * as auth from '../services/auth.js';
import * as bookmarks from '../services/bookmark.js';

/** Anime yang ingin di-bookmark sebelum user login (diselesaikan setelah login). */
let pendingBookmark = null;

function syncNav() {
    setNavUser(auth.getCurrentUser(), { bookmarkCount: bookmarks.bookmarkCount() });
}

/* ------------------------------------------------------------------ */
/* Bookmark (dengan umpan balik toast & gerbang login)                 */
/* ------------------------------------------------------------------ */
/**
 * Tambah/hapus bookmark + toast. Jika belum login, buka modal login.
 * @param {import('../api/normalize.js').Anime} anime
 * @returns {boolean|null} status baru, atau null bila belum login/gagal
 */
export function toggleBookmarkWithFeedback(anime) {
    if (!anime) return null;
    const res = bookmarks.toggleBookmark(anime);
    if (!res.ok) {
        if (res.reason === 'auth') {
            pendingBookmark = anime;
            openAuthModal('login');
            showToast('Login dulu untuk bookmark anime!', 'info');
        } else {
            showToast('Gagal mengubah bookmark (penyimpanan browser penuh/diblokir).', 'error');
        }
        return null;
    }
    showToast(
        res.bookmarked ? `${anime.title} ditambahkan ke bookmark!` : `${anime.title} dihapus dari bookmark`,
        res.bookmarked ? 'success' : 'info',
    );
    return res.bookmarked;
}

function completePendingBookmark() {
    const anime = pendingBookmark;
    pendingBookmark = null;
    if (anime && !bookmarks.isBookmarked(anime)) toggleBookmarkWithFeedback(anime);
}

/* ------------------------------------------------------------------ */
/* Handler modal auth                                                  */
/* ------------------------------------------------------------------ */
async function handleLogin(data) {
    const res = await auth.login(data);
    if (!res.ok) {
        showToast(res.error, 'error');
        return false;
    }
    showToast(`Selamat datang kembali, ${res.user.username}!`, 'success');
    if (res.migrated) console.info('[auth] password akun lama dikonversi ke hash SHA-256.');
    completePendingBookmark();
    return true;
}

async function handleRegister(data) {
    const res = await auth.register(data);
    if (!res.ok) {
        showToast(res.error, 'error');
        return false;
    }
    const avatar = res.user.avatar;
    showToast(
        avatar?.custom
            ? `Selamat datang, ${res.user.username}! Avatar custom disimpan.`
            : `Selamat datang, ${res.user.username}! Avatar ${avatar?.name || ''} telah dipilih.`,
        'success',
    );
    completePendingBookmark();
    return true;
}

function handleAvatarSave(avatar) {
    const res = auth.updateAvatar(avatar);
    if (!res.ok) {
        showToast(res.error, 'error');
        return false;
    }
    showToast(res.avatar.custom ? 'Avatar custom berhasil disimpan!' : `Avatar berhasil diganti ke ${res.avatar.name}!`, 'success');
    return true;
}

function handleLogout() {
    pendingBookmark = null;
    auth.logout();
    showToast('Berhasil keluar. Sampai jumpa!', 'info');
}

/* ------------------------------------------------------------------ */
/* Inisialisasi                                                        */
/* ------------------------------------------------------------------ */
/**
 * @returns {{
 *   page: string,
 *   toggleBookmark: typeof toggleBookmarkWithFeedback,
 *   isBookmarked: (anime: import('../api/normalize.js').Anime) => boolean,
 *   getUser: typeof auth.getCurrentUser,
 * }}
 */
export function initLayout() {
    const page = currentPage();

    installImageFallback();
    initTheme();
    hydrateIcons(document); // placeholder <span class="ic-slot" data-icon="…"> di HTML statis → SVG

    renderNavbar(document.getElementById('app-navbar'), {
        page,
        onLogin: () => openAuthModal('login'),
        onTheme: () => openThemeModal(),
        onAvatar: () => openAvatarModal(auth.getCurrentUser()?.avatar || null),
        onLogout: handleLogout,
    });
    renderFooter(document.getElementById('app-footer'), {
        onApiStatus: () => showApiStatus({ recheck: true }),
    });

    mountAuthModals({
        onLogin: handleLogin,
        onRegister: handleRegister,
        onAvatarSave: handleAvatarSave,
    });

    initSearchDropdown(getSearchElements());

    syncNav();
    auth.onAuthChange(syncNav);
    bookmarks.onBookmarksChange(syncNav);

    initApiStatus();

    return {
        page,
        toggleBookmark: toggleBookmarkWithFeedback,
        isBookmarked: bookmarks.isBookmarked,
        getUser: auth.getCurrentUser,
    };
}
