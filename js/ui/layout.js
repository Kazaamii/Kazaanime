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
import { renderNavbar, setNavUser, getSearchElements, setNavSyncAvailable } from './navbar.js';
import { renderFooter } from './footer.js';
import { openThemeModal } from './theme-modal.js';
import { mountAuthModals, openAuthModal, openAvatarModal } from './auth-modal.js';
import { openAccountModal } from './account-modal.js';
import { initSearchDropdown } from './search-dropdown.js';
import { initApiStatus, showApiStatus } from './api-status.js';
import { showToast } from './toast.js';
import { currentPage } from '../routes.js';
import * as auth from '../services/auth.js';
import * as bookmarks from '../services/bookmark.js';
import * as accountSync from '../services/account-sync.js';

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
        // Putaran 10: akun mungkin dibuat di perangkat lain → coba server akun
        // (hanya bila server aktif; kalau tidak, tetap pesan lokal yang jelas).
        const remote = await accountSync.loginRemote(data);
        if (remote.ok) {
            syncNav();
            refreshSyncAvailability();
            showToast(`Masuk sebagai ${data.username} — akun dipulihkan dari server.`, 'success');
            completePendingBookmark();
            return true;
        }
        showToast(res.error, 'error');
        return false;
    }
    showToast(`Selamat datang kembali, ${res.user.username}!`, 'success');
    if (res.migrated) console.info('[auth] password akun lama dikonversi ke hash SHA-256.');
    refreshSyncAvailability();
    accountSync.push().catch(() => {});
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
    // Sinkron ke server akun bila operator mengaktifkannya (best-effort, tidak memblokir).
    accountSync.registerRemote({ username: data.username, password: data.password, avatar }).then((remote) => {
        if (!remote.skipped) refreshSyncAvailability();
        if (remote.skipped) return;
        if (remote.ok) showToast('Akun juga tersimpan di server — bisa dipakai di perangkat lain.', 'info');
        else if (remote.error) showToast(`Akun lokal tersimpan, tetapi sinkron server gagal: ${remote.error}`, 'info');
    }).catch(() => {});
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
    accountSync.logoutRemote();
    auth.logout();
    showToast('Berhasil keluar. Sampai jumpa!', 'info');
}

/* Putaran 10: cadangkan / pulihkan / sinkron akun dari menu profil. */
function handleBackup() {
    openAccountModal('backup');
}

function handleRestore() {
    openAccountModal('restore');
}

/**
 * Perbarui visibilitas tombol "Sinkron Sekarang".
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
function refreshSyncAvailability({ force = false } = {}) {
    if (!auth.getCurrentUser() && !accountSync.hasToken()) {
        setNavSyncAvailable(false);
        return Promise.resolve(false);
    }
    return accountSync.serverStatus({ force })
        .then((status) => {
            setNavSyncAvailable(Boolean(status.enabled));
            return Boolean(status.enabled);
        })
        .catch(() => {
            setNavSyncAvailable(false);
            return false;
        });
}

async function handleSync() {
    const res = await accountSync.syncNow();
    if (res.disabled) {
        showToast(res.reason || 'Server akun belum diaktifkan operator — gunakan Cadangkan Akun.', 'info');
        return;
    }
    if (res.noToken) {
        showToast('Masuk dulu untuk sinkron dengan server akun.', 'info');
        return;
    }
    syncNav();
    if (res.ok) showToast(`Sinkron selesai${res.updated ? ` — ${res.updated} data diperbarui` : ''}.`, 'success');
    else showToast(`Sinkron gagal: ${res.error || 'server tidak merespons'}`, 'error');
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
        onBackup: handleBackup,
        onRestore: handleRestore,
        onSync: handleSync,
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

    /* Putaran 10: sinkron server akun (opsional) — tombol "Sinkron Sekarang" hanya
       tampil bila server akun benar-benar aktif, supaya menu tidak menjanjikan hal
       yang tidak tersedia. Status hanya diminta bila ada sesi/token: pengunjung yang
       belum masuk tidak perlu request tambahan di setiap halaman. */
    refreshSyncAvailability();
    accountSync.bootstrap().catch(() => {});

    initApiStatus();

    return {
        page,
        toggleBookmark: toggleBookmarkWithFeedback,
        isBookmarked: bookmarks.isBookmarked,
        getUser: auth.getCurrentUser,
    };
}
