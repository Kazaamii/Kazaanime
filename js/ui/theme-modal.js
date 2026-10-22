/**
 * Kazanime — ui/theme-modal.js
 * Modal "Pilih Tema" (komponen bersama, dipasang sekali per halaman).
 * Kartu tema dirender dari THEMES di config.js (dulu 7 blok HTML manual).
 *
 * Catatan: atribut data-theme pada tiap kartu SENGAJA dipertahankan — selector
 * [data-theme="..."] di base.css membuat warna border/centang kartu aktif
 * mengikuti tema kartu itu sendiri, persis seperti tampilan asli.
 */
import { THEMES } from '../config.js';
import { html, raw } from './dom.js';
import { registerModal, openModal, closeModal } from './modal.js';
import { setTheme, getActiveTheme } from '../services/theme.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';

const ICON_CLOSE = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>');

let modalEl = null;

function markActive(themeId) {
    modalEl?.querySelectorAll('.theme-card').forEach((card) => {
        const active = card.dataset.theme === themeId;
        card.classList.toggle('active', active);
        card.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

export function mountThemeModal() {
    if (modalEl) return modalEl;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = String(html`
    <div class="theme-modal" id="themeModal">
        <div class="theme-modal-content">
            <div class="theme-modal-header">
                <h2 id="themeModalTitle">${icon('palette')} Pilih Tema</h2>
                <button type="button" class="modal-close" data-modal-close aria-label="Tutup">${ICON_CLOSE}</button>
            </div>
            <div class="theme-grid">
                ${THEMES.map((t) => html`
                <button type="button" class="theme-card tc-${t.id}" data-theme="${t.id}" aria-pressed="false">
                    <div class="theme-card-icon" aria-hidden="true">${t.icon}</div>
                    <div class="theme-card-name">${t.name}</div>
                    <div class="theme-card-desc">${t.desc}</div>
                </button>`)}
            </div>
        </div>
    </div>`);
    modalEl = wrapper.firstElementChild;
    document.body.appendChild(modalEl);
    registerModal(modalEl, { label: 'Pilih Tema' });

    modalEl.querySelector('.theme-grid').addEventListener('click', (e) => {
        const card = e.target.closest('.theme-card');
        if (!card) return;
        const meta = setTheme(card.dataset.theme);
        markActive(meta.id);
        showToast(`Tema: ${meta.name}!`, 'success');
        closeModal(modalEl);
    });

    // Sinkron bila tema diganti dari tab lain
    window.addEventListener('kazanime:theme', (e) => markActive(e.detail.theme));
    markActive(getActiveTheme());
    return modalEl;
}

export function openThemeModal() {
    const el = mountThemeModal();
    markActive(getActiveTheme());
    openModal(el, { focus: '.theme-card.active' });
}
