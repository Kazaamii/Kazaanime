/**
 * Kazanime — ui/footer.js
 * Footer bersama. Perbaikan: dulu footer berada DI DALAM <main> dan halaman
 * streaming ditaruh SETELAH footer, sehingga saat streaming dibuka footer
 * muncul di atas player. Sekarang footer dipasang di luar <main> tiap halaman.
 * Kredit pembuat dipertahankan apa adanya.
 * Tahap B: tombol "📡 Status API" untuk membuka ulang widget status sumber data.
 */
import { APP } from '../config.js';
import { html, raw } from './dom.js';
import { logoHTML } from './navbar.js';
import { icon } from './icons.js';

const ICON_TWITTER = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23 3a10.9 10.9 0 0 1-3.14 1.53 4.48 4.48 0 0 0-7.86 3v1A10.66 10.66 0 0 1 3 4s-4 9 5 13a11.64 11.64 0 0 1-7 2c9 5 20 0 20-11.5a4.5 4.5 0 0 0-.08-.83A7.72 7.72 0 0 0 23 3z"/></svg>');
const ICON_INSTAGRAM = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>');

/**
 * @param {HTMLElement} mount
 * @param {{onApiStatus?: () => void}} [opts]
 */
export function renderFooter(mount, { onApiStatus } = {}) {
    if (!mount) return;
    mount.innerHTML = String(html`
    <footer class="footer">
        <div class="footer-inner">
            <div class="footer-left">${logoHTML({ tag: 'div' })}<p>${APP.tagline}</p></div>
            <nav class="footer-links" aria-label="Tautan footer">
                <a href="#">Tentang Kami</a><a href="#">Privasi</a><a href="#">Syarat</a><a href="#">Kontak</a><a href="#">DMCA</a>
                ${onApiStatus ? html`<button type="button" data-action="api-status">${icon('radio-tower')} Status API</button>` : ''}
            </nav>
            <div class="social-links">
                <span class="social-link" aria-label="Twitter">${ICON_TWITTER}</span>
                <span class="social-link" aria-label="Instagram">${ICON_INSTAGRAM}</span>
            </div>
            <div class="wm-credit">${APP.name} &copy; ${APP.copyrightYear} — Developed with ${icon('heart', { cls: 'ic--heart', label: 'cinta' })} by <strong>${APP.credit}</strong></div>
        </div>
    </footer>`);
    if (onApiStatus) mount.querySelector('[data-action="api-status"]')?.addEventListener('click', onApiStatus);
}
