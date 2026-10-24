/**
 * Kazanime — ui/ad-guide.js
 * Panduan "hilangkan iklan" (putaran 11, 24 Okt 2026).
 *
 * Permintaan pengguna: *"iklan masih saja muncul dan memaksa new tab … gunakan dns seperti ini
 * https://dns.adguard.com/dns-query atau terapkan di web saya agar tidak ada iklan"*.
 *
 * Kenapa panduan ini ada (jujur):
 *  - **Halaman web tidak bisa mengubah DNS perangkat pengunjung.** DNS diatur di perangkat,
 *    router, atau aplikasi sistem. Tidak ada kode di situs yang bisa memaksakannya.
 *  - Iklan yang muncul DI DALAM pemutar berasal dari server video pihak ketiga (iframe
 *    lintas-domain). Penyaring DNS di perangkat/router adalah satu-satunya cara memblokirnya
 *    secara menyeluruh.
 *  - Yang sudah dilakukan Kazanime sendiri: menolak URL jaringan iklan (server/lib/adblock.js),
 *    Mode Aman (sandbox tanpa pop-up), serta pemulihan otomatis saat iklan membajak pemutar.
 *
 * Modal ini memberi langkah konkret + tombol salin untuk DNS AdGuard yang diminta pengguna.
 */
import { html, raw } from './dom.js';
import { registerModal, openModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';

/** DNS-over-HTTPS AdGuard (yang diminta pengguna) + DNS biasa untuk perangkat. */
export const ADGUARD_DOH = 'https://dns.adguard.com/dns-query';
export const ADGUARD_IPV4 = ['94.140.14.14', '94.140.15.15'];
export const ADGUARD_IPV6 = ['2a10:50c0::ad1:ff', '2a10:50c0::ad2:ff'];
export const ADGUARD_DOT = 'dns.adguard-dns.com';
export const ADGUARD_GUIDE_URL = 'https://adguard-dns.io/';

const ICON_CLOSE = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>');

let modalEl = null;

const codeRow = (label, value, id) => html`
    <div class="ad-guide-row">
        <span class="ad-guide-label">${label}</span>
        <span class="ad-guide-value"><code id="${id}">${value}</code>
            <button type="button" class="ad-guide-copy" data-copy="${value}" aria-label="Salin ${label}">${icon('copy')} Salin</button>
        </span>
    </div>`;

function build() {
    const wrap = document.createElement('div');
    wrap.innerHTML = String(html`
    <div class="auth-modal ad-guide-modal" id="adGuideModal">
        <div class="auth-container ad-guide-container">
            <button type="button" class="auth-close" data-modal-close aria-label="Tutup">${ICON_CLOSE}</button>
            <div class="auth-header">
                <div class="auth-logo" aria-hidden="true">${icon('shield-check')}</div>
                <h2>Blokir Iklan Sampai Akar</h2>
                <p>Iklan di dalam pemutar berasal dari server video pihak ketiga. DNS penyaring di perangkat/router memblokirnya — halaman web sendiri tidak bisa mengubah DNS.</p>
            </div>

            <div class="auth-form">
                <div class="ad-guide-note">
                    <strong>Kenapa perlu diatur di perangkat?</strong>
                    Browser tidak menyediakan cara bagi situs mana pun untuk mengganti DNS pengunjung.
                    DNS AdGuard di bawah ini memblokir iklan, popunder, dan tracker untuk <em>semua</em>
                    situs di perangkatmu — termasuk iklan yang memaksa tab baru.
                </div>

                <h3 class="ad-guide-h3">1 · Pilih cara pemasangan</h3>
                <ul class="ad-guide-steps">
                    <li><strong>Android 9+</strong> — Setelan → Jaringan &amp; internet → DNS Pribadi → “Nama host penyedia DNS pribadi” → isi <code>${ADGUARD_DOT}</code></li>
                    <li><strong>iPhone/iPad</strong> — pasang profil DNS AdGuard dari situs resmi (atau aplikasi AdGuard), lalu aktifkan di Pengaturan → Umum → VPN &amp; Perangkat.</li>
                    <li><strong>Windows 11</strong> — Setelan → Jaringan → Properti → DNS server → isi DNS AdGuard + “DNS over HTTPS” = <code>${ADGUARD_DOH}</code></li>
                    <li><strong>macOS</strong> — Setelan Sistem → Jaringan → DNS → tambah <code>${ADGUARD_IPV4[0]}</code> dan <code>${ADGUARD_IPV4[1]}</code>.</li>
                    <li><strong>Router (semua perangkat di rumah)</strong> — isi DNS AdGuard di menu DHCP/DNS router.</li>
                    <li><strong>Peramban desktop</strong> — ekstensi pemblokir iklan (mis. AdGuard) juga memblokir iklan di dalam iframe.</li>
                </ul>

                <h3 class="ad-guide-h3">2 · Alamat DNS AdGuard</h3>
                ${codeRow('DNS-over-HTTPS', ADGUARD_DOH, 'adGuideDoh')}
                ${codeRow('DNS-over-TLS', ADGUARD_DOT, 'adGuideDot')}
                ${codeRow('IPv4', ADGUARD_IPV4.join('  ·  '), 'adGuideV4')}
                ${codeRow('IPv6', ADGUARD_IPV6.join('  ·  '), 'adGuideV6')}

                <p class="ad-guide-links">
                    <a href="${ADGUARD_GUIDE_URL}" target="_blank" rel="noopener noreferrer">Panduan resmi AdGuard DNS ${icon('external-link')}</a>
                </p>

                <h3 class="ad-guide-h3">3 · Yang sudah dilakukan Kazanime</h3>
                <ul class="ad-guide-checklist">
                    <li><strong>URL iklan ditolak</strong> — host jaringan iklan &amp; tautan “klik iklan” tidak pernah dipasang di pemutar.</li>
                    <li><strong>Mode Aman</strong> — tombol di bawah player memasang sandbox tanpa pop-up, sehingga iklan tidak bisa membuka tab baru.</li>
                    <li><strong>Pemulihan otomatis</strong> — bila iklan memindahkan pemutar ke halaman lain, bilah “Pulihkan pemutar” muncul dan server itu dilewati.</li>
                    <li><strong>Cek daftar blokir</strong> — server yang host-nya ada di daftar blokir AdGuard DNS diberi tanda ⚠ dan ditaruh di urutan belakang.</li>
                </ul>
                <p class="account-note">Iklan yang menempel pada video (hardsub) atau yang dimuat di dalam dokumen pemutar pihak ketiga tidak bisa dihapus dari sini — hanya DNS/ekstensi di perangkat yang bisa memblokirnya.</p>
            </div>
        </div>
    </div>`);
    return wrap.firstElementChild;
}

async function copyText(value) {
    try {
        await navigator.clipboard.writeText(value);
        showToast('Disalin. Tempel di pengaturan DNS perangkat.', 'success');
    } catch {
        showToast(`Salin manual: ${value}`, 'info', 8000);
    }
}

function bind() {
    modalEl.addEventListener('click', (event) => {
        const btn = event.target instanceof Element ? event.target.closest('[data-copy]') : null;
        if (!btn) return;
        copyText(btn.getAttribute('data-copy'));
    });
}

/** Buka panduan (idempoten; modal dibuat sekali). */
export function openAdGuide() {
    if (!modalEl) {
        modalEl = build();
        document.body.appendChild(modalEl);
        registerModal(modalEl, { label: 'Panduan memblokir iklan dengan DNS AdGuard' });
        bind();
    }
    openModal(modalEl, { focus: '[data-modal-close]' });
}

export function closeAdGuide() {
    if (modalEl) closeModal(modalEl);
}
