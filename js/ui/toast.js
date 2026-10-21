/**
 * Kazanime — ui/toast.js
 * Notifikasi singkat. API sama dengan file asli: showToast / hideToast / updateToast.
 *
 * Perbaikan:
 *  - Toast ditumpuk dalam satu container (dulu semua position:fixed di titik
 *    yang sama → saling menimpa).
 *  - Pesan dimasukkan sebagai textContent (dulu innerHTML → XSS dari judul).
 *  - Ada aria-live supaya terbaca screen reader.
 */
import { UI } from '../config.js';

const ICONS = { success: '✅', error: '❌', info: 'ℹ️' };
let stack = null;
let counter = 0;

function getStack() {
    if (!stack || !stack.isConnected) {
        stack = document.createElement('div');
        stack.className = 'toast-stack';
        stack.setAttribute('role', 'status');
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
    }
    return stack;
}

function fill(el, message, type) {
    el.replaceChildren();
    const icon = document.createElement('span');
    icon.textContent = ICONS[type] || ICONS.info;
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = message;
    el.append(icon, text);
}

/**
 * @param {string} message
 * @param {'success'|'error'|'info'} [type='info']
 * @param {number} [duration] ms; 0 = tidak hilang otomatis (tutup via hideToast)
 * @returns {string} id toast
 */
export function showToast(message, type = 'info', duration = UI.toastDuration) {
    const el = document.createElement('div');
    el.className = 'toast';
    const id = `toast-${Date.now()}-${++counter}`;
    el.dataset.toastId = id;
    fill(el, message, type);
    const container = getStack();
    container.appendChild(el);
    // Batasi tumpukan agar tidak memenuhi layar
    while (container.children.length > 4) container.firstElementChild.remove();
    if (duration > 0) setTimeout(() => hideToast(id), duration);
    return id;
}

export function hideToast(id) {
    if (!id || !stack) return;
    const el = stack.querySelector(`[data-toast-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
}

export function updateToast(id, message, type = 'info') {
    if (!id || !stack) return;
    const el = stack.querySelector(`[data-toast-id="${CSS.escape(id)}"]`);
    if (el) fill(el, message, type);
}
