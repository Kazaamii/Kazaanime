/**
 * Kazanime — ui/layout.js
 * "App shell" bersama: dipanggil SEKALI di awal setiap halaman
 * (home.js / search.js / watch.js). Memasang navbar, footer, modal tema,
 * modal auth, fallback gambar, dan tema tersimpan.
 *
 * TAHAP A: login/daftar/bookmark masih berupa stub (pesan info).
 * TAHAP B: callback di bawah disambungkan ke services/auth.js & bookmark.js,
 *          plus autocomplete pencarian dan badge status API.
 */
import { installImageFallback } from './dom.js';
import { initTheme } from '../services/theme.js';
import { renderNavbar } from './navbar.js';
import { renderFooter } from './footer.js';
import { openThemeModal } from './theme-modal.js';
import { mountAuthModals, openAuthModal, openAvatarModal } from './auth-modal.js';
import { showToast } from './toast.js';
import { currentPage } from '../routes.js';

export const STAGE_B_NOTICE = 'Fitur ini diaktifkan di Tahap B (services/auth.js & bookmark.js).';

/**
 * @returns {{page: string}}
 */
export function initLayout() {
    const page = currentPage();

    installImageFallback();
    initTheme();

    renderNavbar(document.getElementById('app-navbar'), {
        page,
        onLogin: () => openAuthModal('login'),
        onTheme: () => openThemeModal(),
        onAvatar: () => openAvatarModal(null),
        onLogout: () => showToast(STAGE_B_NOTICE, 'info'),
    });
    renderFooter(document.getElementById('app-footer'));

    mountAuthModals({
        onLogin: () => { showToast(STAGE_B_NOTICE, 'info'); return false; },
        onRegister: () => { showToast(STAGE_B_NOTICE, 'info'); return false; },
        onAvatarSave: () => { showToast(STAGE_B_NOTICE, 'info'); return false; },
    });

    return { page };
}
