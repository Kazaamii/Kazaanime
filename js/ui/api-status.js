/**
 * Kazanime — ui/api-status.js
 * Widget "status API" di pojok kanan bawah (port dari file asli).
 *
 * Perbedaan dengan file asli:
 *  - Status diambil dari request data yang BENAR-BENAR dipakai halaman
 *    (registry kesehatan di api/http.js), bukan dari request uji terpisah.
 *    Hanya sumber yang belum terpakai yang dicek dengan request super ringan.
 *  - Tampil otomatis sekali per sesi (dulu di setiap muat ulang), bisa dibuka
 *    lagi kapan saja lewat tombol "📡 Status API" di footer (cek ulang semua).
 *  - Menampilkan sumber AniList & Kitsu + Backend bila sudah aktif (Jikan dihapus 22 Okt 2026).
 *  - Update langsung saat status berubah; klik widget untuk menutup.
 */
import { STORAGE_KEYS, UI } from '../config.js';
import { activeApiSources, checkApiSources, getAllHealth, onHealthChange, pendingRequests } from '../api/index.js';
import { html } from './dom.js';
import { showToast } from './toast.js';

const NAMES = { anilist: 'AniList API', kitsu: 'Kitsu API', backend: 'Backend Scraper' };
const LABEL = { online: 'Online', offline: 'Offline', loading: 'Memeriksa...' };

let el = null;
let hideTimer = null;
let fadeTimer = null;
let running = null;
let forceLoading = false;

function ensureEl() {
    if (el?.isConnected) return el;
    el = document.createElement('div');
    el.className = 'api-status';
    el.id = 'apiStatus';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.title = 'Klik untuk menutup';
    el.addEventListener('click', hide);
    document.body.appendChild(el);
    return el;
}

function stateOf(source, health) {
    if (forceLoading) return 'loading';
    const s = health[source]?.state;
    return s === 'online' || s === 'offline' ? s : 'loading';
}

function render() {
    if (!el || el.hidden) return;
    const health = getAllHealth();
    el.innerHTML = String(html`${activeApiSources().map((source) => {
        const state = stateOf(source, health);
        return html`<div class="api-badge"><span class="status-dot ${state}"></span><span>${NAMES[source]}: ${LABEL[state]}</span></div>`;
    })}`);
}

function hide() {
    if (!el || el.hidden) return;
    clearTimeout(hideTimer);
    el.classList.add('is-fading');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
        el.hidden = true;
        el.classList.remove('is-fading');
    }, 600);
}

/** Tunggu request data halaman ini selesai (maks `max` ms) agar sumber tidak di-ping dobel. */
function waitForPageRequests(max) {
    return new Promise((resolve) => {
        const started = Date.now();
        const idle = () => activeApiSources().every((s) => pendingRequests(s) === 0);
        const tick = () => {
            if (idle() || Date.now() - started >= max) resolve();
            else setTimeout(tick, 250);
        };
        setTimeout(tick, 300);
    });
}

function summaryToast() {
    const health = getAllHealth();
    const sources = activeApiSources();
    const online = sources.filter((s) => health[s].state === 'online').length;
    if (online === sources.length) showToast('Semua API online! Data anime real-time aktif.', 'success');
    else if (online > 0) showToast(`${online}/${sources.length} API online. Sebagian data memakai sumber cadangan.`, 'info');
    else showToast('API offline. Menampilkan data cadangan.', 'error');
}

/**
 * Tampilkan widget.
 * @param {{recheck?: boolean}} [opts] recheck: cek ulang SEMUA sumber (tombol footer)
 */
export function showApiStatus({ recheck = false } = {}) {
    ensureEl();
    clearTimeout(hideTimer);
    clearTimeout(fadeTimer);
    el.classList.remove('is-fading');
    el.hidden = false;
    forceLoading = recheck;
    render();

    if (running) return running;
    running = (async () => {
        if (!recheck) await waitForPageRequests(8000);
        await checkApiSources({ all: recheck });
        forceLoading = false;
        render();
        summaryToast();
        hideTimer = setTimeout(hide, UI.apiStatusHideDelay);
    })().finally(() => { running = null; });
    return running;
}

/**
 * Pasang widget di halaman. Tampil otomatis pada halaman pertama yang dibuka
 * di setiap sesi browser (tab).
 */
export function initApiStatus() {
    onHealthChange(() => render());
    let alreadyShown = false;
    try {
        alreadyShown = window.sessionStorage.getItem(STORAGE_KEYS.apiStatusShown) === '1';
        window.sessionStorage.setItem(STORAGE_KEYS.apiStatusShown, '1');
    } catch {
        /* sessionStorage diblokir: tetap tampilkan */
    }
    if (!alreadyShown) showApiStatus();
}
