/**
 * Kazanime — ui/account-modal.js
 * Modal "Cadangkan Akun" & "Pulihkan Akun" (putaran 10, 24 Okt 2026).
 *
 * Akun Kazanime disimpan di browser, jadi tidak bisa masuk otomatis di perangkat
 * lain. Modal ini menyediakan dua jalur resmi:
 *   - Cadangkan: unduh berkas .json ATAU salin "kode sinkron" pendek.
 *   - Pulihkan: unggah berkas ATAU tempel kode, lalu akun digabung (yang lebih
 *     baru menang) dan langsung login memakai akun dari cadangan.
 *
 * Semua validasi ada di services/account-backup.js; modul ini hanya UI.
 */
import { html, raw, $ } from './dom.js';
import { registerModal, openModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';
import { listAccounts, storageInfo } from '../services/auth.js';
import {
    buildBundle, bundleSummary, createSyncCode, downloadBundle, parseSyncCode, readBundleFile, restoreBundle,
} from '../services/account-backup.js';

const ICON_CLOSE = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>');

let modalEl = null;
let pendingBundle = null;

/** @param {import('../services/auth.js').PublicUser|null} user */
const accountLine = (account) => html`
    <li class="account-list-item">
        <span class="account-list-name">${account.username}</span>
        <span class="account-list-meta">${account.bookmarks} bookmark${account.createdAt ? ` · dibuat ${new Date(account.createdAt).toLocaleDateString('id-ID')}` : ''}</span>
    </li>`;

function buildModal() {
    const wrap = document.createElement('div');
    wrap.innerHTML = String(html`
    <div class="auth-modal" id="accountModal">
        <div class="auth-container account-container">
            <button type="button" class="auth-close" data-modal-close aria-label="Tutup">${ICON_CLOSE}</button>
            <div class="auth-header">
                <div class="auth-logo" aria-hidden="true">${icon('database-backup')}</div>
                <h2 id="accountModalTitle">Cadangkan Akun</h2>
                <p id="accountModalSubtitle">Akun tersimpan di browser ini saja — pindahkan dengan berkas atau kode.</p>
            </div>

            <div class="auth-tabs" role="tablist">
                <button type="button" class="auth-tab active" role="tab" aria-selected="true" data-account-tab="backup">Cadangkan</button>
                <button type="button" class="auth-tab" role="tab" aria-selected="false" data-account-tab="restore">Pulihkan</button>
            </div>

            <div class="auth-form" id="accountBackupPanel">
                <p class="account-status" id="accountBackupStatus"></p>
                <ul class="account-list" id="accountBackupList"></ul>
                <button type="button" class="btn-auth" id="accountDownloadBtn">${icon('download')} Unduh Berkas Cadangan (.json)</button>
                <button type="button" class="btn-ext btn-ext--retry account-code-btn" id="accountCodeBtn">${icon('key-round')} Buat Kode Sinkron</button>
                <p class="account-note">Berkas & kode berisi hash password dan bookmark. Simpan di tempat aman — siapa pun yang memegangnya bisa mencoba menebak password secara offline.</p>
                <div class="account-code-box" id="accountCodeBox" hidden>
                    <label for="accountCodeOutput">Kode sinkron (tempel di perangkat lain → Pulihkan)</label>
                    <textarea id="accountCodeOutput" rows="3" readonly spellcheck="false"></textarea>
                    <button type="button" class="btn-ext btn-ext--retry" id="accountCopyBtn">${icon('copy')} Salin Kode</button>
                </div>
            </div>

            <div class="auth-form" id="accountRestorePanel" hidden>
                <p class="account-status">Pulihkan dari berkas cadangan atau kode sinkron. Akun yang sudah ada di perangkat ini tetap dipertahankan.</p>
                <label class="account-field" for="accountRestoreFile">Berkas cadangan (.json)
                    <input type="file" id="accountRestoreFile" accept="application/json,.json">
                </label>
                <label class="account-field" for="accountRestoreCode">atau tempel kode sinkron
                    <textarea id="accountRestoreCode" rows="3" placeholder="KZ1-… / KZ1Z-…" spellcheck="false"></textarea>
                </label>
                <p class="account-status account-status--preview" id="accountRestorePreview" hidden></p>
                <button type="button" class="btn-auth" id="accountRestoreBtn" disabled>${icon('upload')} Pulihkan Akun</button>
                <p class="account-note">Setelah dipulihkan, kamu langsung masuk dengan akun dari cadangan. Bookmark digabung; data yang lebih baru dipakai.</p>
            </div>
        </div>
    </div>`);
    return wrap.firstElementChild;
}

function renderBackupPanel() {
    const accounts = listAccounts();
    const info = storageInfo();
    const status = $('#accountBackupStatus', modalEl);
    const list = $('#accountBackupList', modalEl);
    const download = $('#accountDownloadBtn', modalEl);
    const codeBtn = $('#accountCodeBtn', modalEl);

    const parts = [`${accounts.length} akun di perangkat ini`];
    if (info.hasBackup && accounts.length) parts.push('cadangan otomatis aktif');
    if (!info.enabled) parts.push('penyimpanan browser diblokir / mode privat');
    if (info.recovered) parts.push('data rusak dipulihkan otomatis');
    status.textContent = parts.join(' · ');

    list.innerHTML = accounts.length
        ? String(html`${accounts.map(accountLine)}`)
        : '<li class="account-list-empty">Belum ada akun di perangkat ini.</li>';

    download.disabled = accounts.length === 0;
    codeBtn.disabled = accounts.length === 0;
    $('#accountCodeBox', modalEl).hidden = true;
    $('#accountCodeOutput', modalEl).value = '';
}

function switchTab(tab) {
    modalEl.querySelectorAll('[data-account-tab]').forEach((btn) => {
        const on = btn.dataset.accountTab === tab;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('#accountBackupPanel', modalEl).hidden = tab !== 'backup';
    $('#accountRestorePanel', modalEl).hidden = tab !== 'restore';
    $('#accountModalTitle', modalEl).textContent = tab === 'backup' ? 'Cadangkan Akun' : 'Pulihkan Akun';
    const subtitle = tab === 'backup'
        ? 'Akun tersimpan di browser ini saja — pindahkan dengan berkas atau kode.'
        : 'Pindahkan akun dari perangkat lain lewat berkas atau kode sinkron.';
    $('#accountModalSubtitle', modalEl).textContent = subtitle;
}

function showPreview(bundle, sourceLabel) {
    const preview = $('#accountRestorePreview', modalEl);
    const summary = bundleSummary(bundle);
    const names = summary.accounts.slice(0, 5).map((a) => a.username).join(', ');
    // Berapa akun yang sudah ada di perangkat ini (akan digabung, bukan dihapus).
    const localNames = new Set(listAccounts().map((a) => a.username.trim().toLowerCase()));
    const overlap = summary.accounts.filter((a) => localNames.has(String(a.username).trim().toLowerCase())).length;
    preview.hidden = false;
    preview.textContent = `${sourceLabel}: ${summary.total} akun${summary.total ? ` (${names}${summary.total > 5 ? ', …' : ''})` : ''}`
        + (summary.exportedAt ? ` · dibuat ${new Date(summary.exportedAt).toLocaleString('id-ID')}` : '')
        + (overlap ? ` · ${overlap} sudah ada di perangkat ini, data terbaru yang dipakai` : '');
    $('#accountRestoreBtn', modalEl).disabled = summary.total === 0;
    pendingBundle = summary.total ? bundle : null;
}

async function handleRestore() {
    if (!pendingBundle) {
        showToast('Pilih berkas cadangan atau tempel kode sinkron dulu.', 'info');
        return;
    }
    // Konfirmasi bila ada akun yang sudah ada di perangkat ini: datanya bisa tertimpa
    // versi yang lebih baru dari cadangan. Akun lain tidak pernah dihapus.
    const localNames = new Set(listAccounts().map((a) => a.username.trim().toLowerCase()));
    const summary = bundleSummary(pendingBundle);
    const overlap = summary.accounts.filter((a) => localNames.has(String(a.username).trim().toLowerCase()));
    if (overlap.length) {
        const names = overlap.slice(0, 4).map((a) => a.username).join(', ');
        const ok = window.confirm(
            `${overlap.length} akun sudah ada di perangkat ini (${names}${overlap.length > 4 ? ', …' : ''}).\n\n`
            + 'Data dari cadangan yang lebih baru akan MENGGANTIKAN data akun tersebut. Akun lain tetap aman. Lanjutkan?',
        );
        if (!ok) {
            showToast('Pemulihan dibatalkan — data di perangkat ini tidak diubah.', 'info');
            return;
        }
    }
    const res = restoreBundle(pendingBundle, { loginUser: pendingBundle.currentUser });
    if (!res.ok) {
        showToast(res.error, 'error');
        return;
    }
    pendingBundle = null;
    const merged = `Pulihkan selesai — ${res.added} akun baru, ${res.updated} diperbarui${res.skipped ? `, ${res.skipped} dilewati` : ''}.`;
    showToast(res.loggedInAs ? `${merged} Masuk sebagai ${res.loggedInAs}.` : merged, 'success');
    closeModal(modalEl);
}

function bind() {
    modalEl.querySelectorAll('[data-account-tab]').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.accountTab));
    });

    $('#accountDownloadBtn', modalEl).addEventListener('click', () => {
        const res = downloadBundle();
        if (!res.ok) {
            showToast(res.error, 'error');
            return;
        }
        showToast(`Berkas cadangan dibuat: ${res.filename} (${Math.round(res.bytes / 1024)} KB).`, 'success');
    });

    $('#accountCodeBtn', modalEl).addEventListener('click', async () => {
        const res = await createSyncCode();
        if (!res.ok) {
            showToast(res.error, 'error');
            return;
        }
        const box = $('#accountCodeBox', modalEl);
        box.hidden = false;
        $('#accountCodeOutput', modalEl).value = res.code;
        $('#accountCodeOutput', modalEl).select();
        showToast(`Kode sinkron dibuat (${res.code.length} karakter${res.compressed ? ', terkompresi' : ''}).`, 'success');
    });

    $('#accountCopyBtn', modalEl).addEventListener('click', async () => {
        const value = $('#accountCodeOutput', modalEl).value;
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            showToast('Kode sinkron disalin. Tempel di perangkat lain.', 'success');
        } catch {
            $('#accountCodeOutput', modalEl).select();
            showToast('Salin manual: kode sudah dipilih semua (Ctrl/Cmd+C).', 'info');
        }
    });

    $('#accountRestoreFile', modalEl).addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const res = await readBundleFile(file);
        if (!res.ok) {
            showToast(res.error, 'error');
            pendingBundle = null;
            $('#accountRestoreBtn', modalEl).disabled = true;
            return;
        }
        $('#accountRestoreCode', modalEl).value = '';
        showPreview(res.bundle, file.name);
    });

    let codeTimer = null;
    $('#accountRestoreCode', modalEl).addEventListener('input', (e) => {
        clearTimeout(codeTimer);
        const value = e.target.value.trim();
        if (!value) {
            pendingBundle = null;
            $('#accountRestorePreview', modalEl).hidden = true;
            $('#accountRestoreBtn', modalEl).disabled = true;
            return;
        }
        codeTimer = setTimeout(async () => {
            const res = await parseSyncCode(value);
            if (!res.ok) {
                $('#accountRestorePreview', modalEl).hidden = false;
                $('#accountRestorePreview', modalEl).textContent = res.error;
                $('#accountRestoreBtn', modalEl).disabled = true;
                return;
            }
            $('#accountRestoreFile', modalEl).value = '';
            showPreview(res.bundle, 'Kode sinkron');
        }, 250);
    });

    $('#accountRestoreBtn', modalEl).addEventListener('click', handleRestore);
}

/**
 * Buka modal akun.
 * @param {'backup'|'restore'} [tab]
 */
export function openAccountModal(tab = 'backup') {
    if (!modalEl) {
        modalEl = buildModal();
        document.body.appendChild(modalEl);
        registerModal(modalEl, { label: 'Cadangkan atau pulihkan akun' });
        bind();
    }
    pendingBundle = null;
    $('#accountRestorePreview', modalEl).hidden = true;
    $('#accountRestoreBtn', modalEl).disabled = true;
    $('#accountRestoreCode', modalEl).value = '';
    $('#accountRestoreFile', modalEl).value = '';
    renderBackupPanel();
    switchTab(tab);
    openModal(modalEl, { focus: tab === 'backup' ? '#accountDownloadBtn' : '#accountRestoreFile' });
}

export function closeAccountModal() {
    if (modalEl) closeModal(modalEl);
}

/** Ringkasan cepat untuk tombol di menu profil (mis. "3 akun"). */
export function accountBadgeText() {
    const n = listAccounts().length;
    return n ? `${n} akun` : 'belum ada akun';
}

/** Bundel saat ini (dipakai tombol "Sinkron Sekarang"). */
export { buildBundle };
