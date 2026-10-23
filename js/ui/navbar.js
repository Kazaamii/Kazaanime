/**
 * Kazanime — ui/navbar.js
 * Navbar bersama untuk semua halaman (dulu disalin di satu file raksasa).
 *
 * Tanggung jawab modul ini: markup + interaksi murni UI
 *   - link navigasi (smooth scroll di homepage, index.html#section di halaman lain)
 *   - Ctrl/⌘+K fokus pencarian, Enter → search.html?q=..., Esc menutup
 *   - tombol 🔍 di mobile (dulu pencarian HILANG total di layar ≤480px)
 *   - profile dropdown (buka/tutup, klik di luar menutup)
 *   - setNavUser(): tampilkan state login/logout + jumlah bookmark
 * Logika akun/bookmark TIDAK di sini — diteruskan lewat callback.
 * Autocomplete pencarian dipasang terpisah oleh ui/search-dropdown.js (Tahap B).
 */
import { APP, NAV_LINKS, UI } from '../config.js';
import { html, raw, $, avatarSrc } from './dom.js';
import { homeSectionUrl, searchUrl } from '../routes.js';
import { icon } from './icons.js';

const ICON_SEARCH = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>');
const ICON_BOOKMARK = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>');
const ICON_USER = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>');
const ICON_THEME = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>');
const ICON_LOGOUT = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>');

/** Markup logo (dipakai navbar & footer). */
export function logoHTML({ tag = 'a' } = {}) {
    const icon = APP.logoImage
        ? html`<img src="${APP.logoImage}" alt="" data-fallback="emoji:${APP.logoFallback}">`
        : APP.logoFallback;
    const inner = html`<span class="logo-icon" aria-hidden="true">${icon}</span><span class="logo-text">${APP.name}</span>`;
    return tag === 'a'
        ? html`<a href="index.html" class="logo" aria-label="${APP.name} — Beranda">${inner}</a>`
        : html`<div class="logo">${inner}</div>`;
}

function navLinksHTML(page) {
    return html`${NAV_LINKS.map((link) => {
        const href = link.page
            ? link.page
            : (page === 'home' ? (link.section ? `#${link.section}` : 'index.html') : homeSectionUrl(link.section));
        const active = link.page ? page === String(link.page).replace(/\.html$/, '') : page === 'home' && !link.section;
        return html`<li${link.authOnly ? raw(' data-auth-only hidden') : ''}><a href="${href}"${active ? raw(' class="active" aria-current="page"') : ''} data-section="${link.section || ''}">${link.label}</a></li>`;
    })}`;
}

function navbarHTML(page) {
    return html`
    <nav class="navbar" aria-label="Navigasi utama">
        <div class="navbar-inner">
            ${logoHTML()}
            <ul class="nav-links">${navLinksHTML(page)}</ul>
            <div class="nav-right">
                <form class="search-box" id="searchBoxWrapper" role="search" action="search.html" method="get">
                    ${ICON_SEARCH}
                    <label for="searchInput" class="sr-only">Cari anime</label>
                    <input type="text" name="q" placeholder="Cari anime atau donghua..." id="searchInput" autocomplete="off" enterkeyhint="search" aria-controls="searchDropdown" aria-expanded="false" aria-autocomplete="list">
                    <span class="search-kbd" aria-hidden="true">Ctrl+K</span>
                    <div class="search-dropdown" id="searchDropdown" role="listbox" aria-label="Saran pencarian"></div>
                </form>
                <button type="button" class="nav-btn btn-theme search-toggle" id="btnSearchToggle" aria-label="Buka pencarian" aria-expanded="false">${icon('search')}</button>
                <button type="button" class="nav-btn btn-theme" id="btnTheme" aria-label="Pilih tema">${icon('palette')} <span class="theme-label">Tema</span></button>
                <button type="button" class="nav-btn btn-login" id="btnShowAuth">Masuk</button>
                <div class="profile-wrapper" id="profileWrapper" hidden>
                    <button type="button" class="profile-trigger" id="profileTrigger" aria-haspopup="menu" aria-expanded="false">
                        <img class="profile-avatar" id="navAvatar" alt="">
                        <span class="profile-name" id="navUsername"></span>
                        <span class="profile-arrow" aria-hidden="true">▼</span>
                    </button>
                    <div class="profile-dropdown" role="menu">
                        <div class="dropdown-header">
                            <img id="dropdownAvatar" alt="">
                            <div class="dropdown-header-info">
                                <h4 id="dropdownUsername"></h4>
                                <p>Member ${APP.name}</p>
                            </div>
                        </div>
                        <a class="dropdown-item" role="menuitem" href="bookmark.html" data-action="bookmarks">
                            ${ICON_BOOKMARK} Bookmark Saya <span class="bookmark-count" id="bookmarkCountBadge">0</span>
                        </a>
                        <button type="button" class="dropdown-item" role="menuitem" data-action="avatar">${ICON_USER} Ganti Avatar</button>
                        <button type="button" class="dropdown-item" role="menuitem" data-action="theme">${ICON_THEME} Ganti Tema</button>
                        <div class="dropdown-divider" role="separator"></div>
                        <button type="button" class="dropdown-item danger" role="menuitem" data-action="logout">${ICON_LOGOUT} Keluar</button>
                    </div>
                </div>
            </div>
        </div>
    </nav>`;
}

let navEl = null;

/** Scroll halus ke section dengan offset navbar (scroll-margin-top di CSS). */
function scrollToSection(id) {
    const target = id ? document.getElementById(id) : null;
    if (id && !target) return false;
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
}

function setActiveLink(section) {
    navEl?.querySelectorAll('.nav-links a').forEach((a) => {
        const on = (a.dataset.section || '') === (section || '');
        a.classList.toggle('active', on);
        if (on) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    });
}

function closeProfile() {
    const wrap = $('#profileWrapper', navEl);
    wrap?.classList.remove('open');
    $('#profileTrigger', navEl)?.setAttribute('aria-expanded', 'false');
}

/**
 * Render navbar ke elemen mount.
 * @param {HTMLElement} mount
 * @param {{
 *   page: 'home'|'search'|'watch',
 *   onLogin?: () => void,
 *   onTheme?: () => void,
 *   onAvatar?: () => void,
 *   onLogout?: () => void,
 *   onBookmarks?: () => void,
 * }} opts
 */
export function renderNavbar(mount, { page, onLogin, onTheme, onAvatar, onLogout, onBookmarks } = {}) {
    if (!mount) return null;
    mount.innerHTML = String(navbarHTML(page));
    navEl = mount.querySelector('.navbar');

    const input = $('#searchInput', navEl);
    const form = $('#searchBoxWrapper', navEl);
    const toggle = $('#btnSearchToggle', navEl);

    /* ---------- Navigasi ---------- */
    $('.nav-links', navEl).addEventListener('click', (e) => {
        const a = e.target.closest('a[data-section]');
        if (!a || page !== 'home') return; // halaman lain: biarkan browser pindah ke index.html#...
        e.preventDefault();
        const section = a.dataset.section || null;
        if (scrollToSection(section)) {
            setActiveLink(section);
            history.replaceState(null, '', section ? `#${section}` : window.location.pathname);
        }
    });

    /* ---------- Pencarian ---------- */
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = input.value.trim();
        if (q.length >= UI.searchMinChars) window.location.href = searchUrl(q);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            input.blur();
            navEl.classList.remove('search-open');
            toggle.setAttribute('aria-expanded', 'false');
        }
    });
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            navEl.classList.add('search-open');
            input.focus();
            input.select();
        }
    });
    toggle.addEventListener('click', () => {
        const open = navEl.classList.toggle('search-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) input.focus();
    });
    // Isi ulang kotak pencarian dengan query aktif di search.html
    if (page === 'search') {
        const q = new URLSearchParams(window.location.search).get('q');
        if (q) input.value = q;
    }

    /* ---------- Tombol & profile dropdown ---------- */
    $('#btnTheme', navEl).addEventListener('click', () => onTheme?.());
    $('#btnShowAuth', navEl).addEventListener('click', () => onLogin?.());
    $('#profileTrigger', navEl).addEventListener('click', (e) => {
        e.stopPropagation();
        const wrap = $('#profileWrapper', navEl);
        const open = wrap.classList.toggle('open');
        e.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    $('.profile-dropdown', navEl).addEventListener('click', (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        const action = item.dataset.action;
        closeProfile();
        // Bookmark sekarang halaman sendiri (bookmark.html) → biarkan tautannya berpindah.
        if (action === 'bookmarks') onBookmarks?.();
        else if (action === 'avatar') onAvatar?.();
        else if (action === 'theme') onTheme?.();
        else if (action === 'logout') onLogout?.();
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest?.('.profile-wrapper')) closeProfile();
        if (!e.target.closest?.('.search-box, .search-toggle')) {
            navEl.classList.remove('search-open');
            toggle.setAttribute('aria-expanded', 'false');
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeProfile();
    });

    return navEl;
}

/**
 * Tampilkan state login/logout di navbar.
 * @param {{username:string, avatar?:object}|null} user
 * @param {{bookmarkCount?: number}} [opts]
 */
export function setNavUser(user, { bookmarkCount = 0 } = {}) {
    if (!navEl) return;
    const loggedIn = Boolean(user);
    $('#btnShowAuth', navEl).hidden = loggedIn;
    $('#profileWrapper', navEl).hidden = !loggedIn;
    navEl.querySelectorAll('[data-auth-only]').forEach((el) => { el.hidden = !loggedIn; });
    if (!loggedIn) {
        closeProfile();
        return;
    }
    const fallback = `avatar:${user.avatar?.id || 1}`;
    for (const id of ['#navAvatar', '#dropdownAvatar']) {
        const img = $(id, navEl);
        img.dataset.fallback = fallback;
        delete img.dataset.failed;
        img.src = avatarSrc(user.avatar);
    }
    $('#navUsername', navEl).textContent = user.username;
    $('#dropdownUsername', navEl).textContent = user.username;
    $('#bookmarkCountBadge', navEl).textContent = String(bookmarkCount);
}

/** Elemen pencarian untuk dipasangi autocomplete (Tahap B). */
export function getSearchElements() {
    return navEl ? { form: $('#searchBoxWrapper', navEl), input: $('#searchInput', navEl), dropdown: $('#searchDropdown', navEl) } : null;
}
