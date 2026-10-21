/**
 * Kazanime — ui/modal.js
 * Manajer modal generik untuk .auth-modal & .theme-modal.
 *
 * Menggantikan 4 pasang fungsi open/close yang hampir identik di file asli,
 * plus listener Escape yang memanggil SEMUA close*() sekaligus.
 * Tambahan aksesibilitas: role="dialog", fokus dipindah ke modal & dikunci
 * (Tab tidak keluar modal), lalu dikembalikan ke tombol pemicu saat ditutup.
 */

const openStack = [];
let initialized = false;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

function visibleFocusables(modal) {
    return Array.from(modal.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function init() {
    if (initialized) return;
    initialized = true;

    document.addEventListener('keydown', (e) => {
        const top = openStack[openStack.length - 1];
        if (!top) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeModal(top.el);
        } else if (e.key === 'Tab') {
            const items = visibleFocusables(top.el);
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });

    // Klik area gelap di luar konten = tutup (sama seperti file asli)
    document.addEventListener('click', (e) => {
        const top = openStack[openStack.length - 1];
        if (top && e.target === top.el) closeModal(top.el);
    });
}

/**
 * Daftarkan elemen modal (dipanggil sekali setelah markup dipasang).
 * @param {HTMLElement} el
 * @param {{label?: string, onClose?: () => void}} [opts]
 */
export function registerModal(el, { label = '', onClose } = {}) {
    init();
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    if (label) el.setAttribute('aria-label', label);
    el.setAttribute('aria-hidden', 'true');
    if (onClose) el._onClose = onClose;
    el.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(el)));
}

/**
 * @param {HTMLElement} el
 * @param {{focus?: string}} [opts] selector elemen yang difokuskan pertama
 */
export function openModal(el, { focus } = {}) {
    if (!el || el.classList.contains('active')) return;
    openStack.push({ el, returnFocus: document.activeElement });
    el.classList.add('active');
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => {
        const target = (focus && el.querySelector(focus)) || visibleFocusables(el)[0];
        target?.focus({ preventScroll: true });
    });
}

export function closeModal(el) {
    if (!el || !el.classList.contains('active')) return;
    const index = openStack.findIndex((m) => m.el === el);
    const entry = index >= 0 ? openStack.splice(index, 1)[0] : null;
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
    if (!openStack.length) document.body.classList.remove('modal-open');
    el._onClose?.();
    if (entry?.returnFocus instanceof HTMLElement && entry.returnFocus.isConnected) {
        entry.returnFocus.focus({ preventScroll: true });
    }
}

export function isModalOpen(el) {
    return Boolean(el?.classList.contains('active'));
}
