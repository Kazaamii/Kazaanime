/**
 * Kazanime — ui/notice.js
 * Keterangan kecil tepat di bawah sebuah grid, mis. "⚠️ Menampilkan data
 * cadangan..." dengan tombol "Coba lagi". Dipakai homepage & search.html.
 */
import { html } from './dom.js';
import { icon } from './icons.js';

/**
 * Pasang/ubah/hapus keterangan di bawah `anchor`.
 * @param {HTMLElement} anchor   biasanya elemen grid
 * @param {{text?: string, onRetry?: () => void}} [opts]  text kosong = hapus keterangan
 */
export function setSectionNote(anchor, { text = '', onRetry } = {}) {
    if (!anchor) return;
    let note = anchor.nextElementSibling?.classList.contains('section-note') ? anchor.nextElementSibling : null;
    if (!text) {
        note?.remove();
        return;
    }
    if (!note) {
        note = document.createElement('div');
        note.className = 'section-note';
        note.setAttribute('role', 'status');
        anchor.after(note);
    }
    note.innerHTML = String(html`<span>${text}</span>${onRetry ? html`<button type="button" data-action="retry">${icon('refresh-cw')} Coba lagi</button>` : ''}`);
    if (onRetry) note.querySelector('[data-action="retry"]').addEventListener('click', onRetry, { once: true });
}
