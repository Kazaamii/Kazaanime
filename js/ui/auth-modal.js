/**
 * Kazanime — ui/auth-modal.js
 * Modal Masuk/Daftar + modal Ganti Avatar (komponen bersama).
 *
 * Modul ini HANYA UI: mengumpulkan input lalu memanggil callback.
 * Validasi & penyimpanan akun ada di services/auth.js (Tahap B).
 *
 * Perbaikan dari file asli:
 *  - <form> asli → tombol Enter bekerja (dulu harus klik tombol).
 *  - Area upload = <label for=file> → tanpa onclick inline.
 *  - State avatar terpisah per modal (dulu `selectedAvatarId` & `customAvatarData`
 *    global dipakai bersama oleh dua modal → foto dari form daftar bisa
 *    "bocor" ke modal ganti avatar).
 *  - Modal & grid avatar dibangun lazy SEKALI saat pertama dibuka (dulu grid
 *    dirender ulang tiap buka + 25 canvas fallback dibuat tiap render).
 */
import { AVATARS, AVATAR_UPLOAD } from '../config.js';
import { html, raw, $, delegate, emojiAvatar } from './dom.js';
import { registerModal, openModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';

const ICON_CLOSE = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>');

const TAB_TEXT = {
    login: { title: 'Masuk ke Kazanime', subtitle: 'Selamat datang kembali!' },
    register: { title: 'Daftar Akun Baru', subtitle: 'Buat akun & pilih waifu favoritmu!' },
};

/** @typedef {{id:number, name:string, img:string|null, custom?:boolean}} Avatar */

let authEl = null;
let avatarEl = null;
let handlers = {
    /** @type {(data:{username:string,password:string}) => Promise<boolean>|boolean} */
    onLogin: async () => false,
    /** @type {(data:{username:string,password:string,avatar:Avatar|null}) => Promise<boolean>|boolean} */
    onRegister: async () => false,
    /** @type {(avatar:Avatar|null) => Promise<boolean>|boolean} */
    onAvatarSave: async () => false,
};

/** State pilihan avatar per modal. */
const picks = {
    register: { avatarId: null, custom: null },
    change: { avatarId: null, custom: null },
};

function avatarGridHTML(scope) {
    return html`${AVATARS.map((a) => html`
        <div>
            <button type="button" class="avatar-option" data-scope="${scope}" data-id="${a.id}" aria-pressed="false" aria-label="Avatar ${a.name}">
                <img src="${a.img || emojiAvatar(a.id)}" alt="" loading="lazy" data-fallback="avatar:${a.id}">
            </button>
            <div class="avatar-name">${a.name}</div>
        </div>`)}`;
}

function uploadAreaHTML(scope, inputId, text) {
    return html`
        <label class="avatar-upload-area" for="${inputId}" data-scope="${scope}">
            <img class="avatar-upload-preview" alt="Pratinjau foto">
            <div class="upload-icon" aria-hidden="true">${icon('camera')}</div>
            <div class="upload-text">${text}</div>
            <input type="file" id="${inputId}" accept="image/*" data-scope="${scope}">
        </label>`;
}

function buildAuthModal() {
    const wrap = document.createElement('div');
    wrap.innerHTML = String(html`
    <div class="auth-modal" id="authModal">
        <div class="auth-container">
            <button type="button" class="auth-close" data-modal-close aria-label="Tutup">${ICON_CLOSE}</button>
            <div class="auth-header">
                <div class="auth-logo" aria-hidden="true">🌸</div>
                <h2 id="authTitle">Masuk ke Kazanime</h2>
                <p id="authSubtitle">Bookmark anime favoritmu & dapatkan pengalaman terbaik!</p>
            </div>
            <div class="auth-tabs" role="tablist">
                <button type="button" class="auth-tab active" role="tab" aria-selected="true" data-tab="login">Masuk</button>
                <button type="button" class="auth-tab" role="tab" aria-selected="false" data-tab="register">Daftar</button>
            </div>

            <form class="auth-form" id="loginForm" novalidate>
                <div class="form-group"><label for="loginUsername">Username</label><input type="text" id="loginUsername" name="username" placeholder="Masukkan username" autocomplete="username" required></div>
                <div class="form-group"><label for="loginPassword">Password</label><input type="password" id="loginPassword" name="password" placeholder="Masukkan password" autocomplete="current-password" required></div>
                <button type="submit" class="btn-auth">Masuk</button>
                <p class="auth-note">Akun disimpan lokal di browser ini (localStorage).</p>
            </form>

            <form class="auth-form" id="registerForm" novalidate hidden>
                <div class="form-group"><label for="regUsername">Username</label><input type="text" id="regUsername" name="username" placeholder="Pilih username unik" autocomplete="username" minlength="3" maxlength="24" required></div>
                <div class="form-group"><label for="regPassword">Password</label><input type="password" id="regPassword" name="password" placeholder="Minimal 6 karakter" autocomplete="new-password" minlength="6" required></div>
                <div class="avatar-section">
                    <label for="avatarFileInput">${icon('camera')} Upload Foto Sendiri (Opsional)</label>
                    ${uploadAreaHTML('register', 'avatarFileInput', raw('Klik untuk <strong>upload foto</strong> atau gunakan avatar di bawah'))}
                    <label>Atau Pilih Avatar Waifu/Husbando</label>
                    <div class="avatar-grid" id="avatarGrid">${avatarGridHTML('register')}</div>
                </div>
                <button type="submit" class="btn-auth">Daftar Sekarang</button>
            </form>
        </div>
    </div>`);
    return wrap.firstElementChild;
}

function buildAvatarModal() {
    const wrap = document.createElement('div');
    wrap.innerHTML = String(html`
    <div class="auth-modal" id="avatarChangeModal">
        <div class="auth-container">
            <button type="button" class="auth-close" data-modal-close aria-label="Tutup">${ICON_CLOSE}</button>
            <div class="auth-header">
                <div class="auth-logo" aria-hidden="true">🎭</div>
                <h2>Ganti Avatar</h2>
                <p>Pilih waifu atau husbando favoritmu!</p>
            </div>
            <form class="auth-form" id="avatarChangeForm" novalidate>
                ${uploadAreaHTML('change', 'avatarChangeFileInput', raw('Klik untuk <strong>upload foto baru</strong>'))}
                <div class="avatar-grid avatar-grid--tall" id="avatarChangeGrid">${avatarGridHTML('change')}</div>
                <button type="submit" class="btn-auth btn-auth--spaced">Simpan Avatar</button>
            </form>
        </div>
    </div>`);
    return wrap.firstElementChild;
}

/* ------------------------------------------------------------------ */
/* State avatar                                                        */
/* ------------------------------------------------------------------ */
function rootFor(scope) {
    return scope === 'register' ? authEl : avatarEl;
}

function renderPick(scope) {
    const root = rootFor(scope);
    if (!root) return;
    const { avatarId, custom } = picks[scope];
    root.querySelectorAll('.avatar-option').forEach((btn) => {
        const on = Number(btn.dataset.id) === avatarId && !custom;
        btn.classList.toggle('selected', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const area = root.querySelector('.avatar-upload-area');
    const preview = area.querySelector('.avatar-upload-preview');
    area.classList.toggle('has-image', Boolean(custom));
    if (custom) preview.src = custom;
    else preview.removeAttribute('src');
}

function resetPick(scope, avatarId = null) {
    picks[scope] = { avatarId, custom: null };
    const input = rootFor(scope)?.querySelector('input[type="file"]');
    if (input) input.value = '';
    renderPick(scope);
}

/** Avatar terpilih dalam format yang disimpan (sama dengan file asli). */
function selectedAvatar(scope) {
    const { avatarId, custom } = picks[scope];
    if (custom) return { id: 0, name: 'Custom', img: custom, custom: true };
    const a = AVATARS.find((x) => x.id === avatarId);
    return a ? { id: a.id, name: a.name, img: a.img } : null;
}

/** Crop tengah → 200×200 JPEG (logika sama dengan handleAvatarUpload asli). */
function readAndCrop(file) {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith('image/')) return reject(new Error('File harus berupa gambar!'));
        if (file.size > AVATAR_UPLOAD.maxBytes) return reject(new Error('Ukuran file maksimal 2MB!'));
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Gagal membaca file.'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('Gambar tidak valid.'));
            img.onload = () => {
                const size = AVATAR_UPLOAD.size;
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const min = Math.min(img.width, img.height);
                canvas.getContext('2d').drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, size, size);
                resolve(canvas.toDataURL('image/jpeg', AVATAR_UPLOAD.quality));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

/* ------------------------------------------------------------------ */
/* Tab                                                                 */
/* ------------------------------------------------------------------ */
function switchTab(tab) {
    const text = TAB_TEXT[tab] || TAB_TEXT.login;
    authEl.querySelectorAll('.auth-tab').forEach((t) => {
        const on = t.dataset.tab === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('#loginForm', authEl).hidden = tab !== 'login';
    $('#registerForm', authEl).hidden = tab !== 'register';
    $('#authTitle', authEl).textContent = text.title;
    $('#authSubtitle', authEl).textContent = text.subtitle;
}

/* ------------------------------------------------------------------ */
/* Pemasangan                                                          */
/* ------------------------------------------------------------------ */
function bindShared(root) {
    // Pilih avatar dari grid
    delegate(root, 'click', '.avatar-option', (_e, btn) => {
        const scope = btn.dataset.scope;
        picks[scope] = { avatarId: Number(btn.dataset.id), custom: null };
        renderPick(scope);
    });
    // Upload foto
    root.addEventListener('change', async (e) => {
        const input = e.target;
        if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
        const file = input.files?.[0];
        if (!file) return;
        const scope = input.dataset.scope;
        try {
            picks[scope] = { avatarId: null, custom: await readAndCrop(file) };
            renderPick(scope);
            showToast('Foto berhasil diupload!', 'success');
        } catch (err) {
            input.value = '';
            showToast(err.message, 'error');
        }
    });
}

/** Bangun modal Masuk/Daftar saat pertama kali dibutuhkan. */
function ensureAuthModal() {
    if (authEl) return authEl;
    authEl = buildAuthModal();
    document.body.appendChild(authEl);
    registerModal(authEl, { label: 'Masuk atau daftar' });
    bindShared(authEl);

    delegate(authEl, 'click', '.auth-tab', (_e, tab) => switchTab(tab.dataset.tab));

    $('#loginForm', authEl).addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const ok = await handlers.onLogin({
            username: form.username.value.trim(),
            password: form.password.value,
        });
        if (ok) {
            form.reset();
            closeModal(authEl);
        }
    });

    $('#registerForm', authEl).addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const ok = await handlers.onRegister({
            username: form.username.value.trim(),
            password: form.password.value,
            avatar: selectedAvatar('register'),
        });
        if (ok) {
            form.reset();
            resetPick('register');
            closeModal(authEl);
        }
    });
    return authEl;
}

/** Bangun modal Ganti Avatar saat pertama kali dibutuhkan. */
function ensureAvatarModal() {
    if (avatarEl) return avatarEl;
    avatarEl = buildAvatarModal();
    document.body.appendChild(avatarEl);
    registerModal(avatarEl, { label: 'Ganti avatar' });
    bindShared(avatarEl);

    $('#avatarChangeForm', avatarEl).addEventListener('submit', async (e) => {
        e.preventDefault();
        const ok = await handlers.onAvatarSave(selectedAvatar('change'));
        if (ok) closeModal(avatarEl);
    });
    return avatarEl;
}

/**
 * Daftarkan callback. Markup modal dibangun lazy saat pertama dibuka
 * (hemat DOM & tidak membuat 25 avatar di setiap halaman yang dibuka).
 * @param {Partial<typeof handlers>} callbacks
 */
export function mountAuthModals(callbacks = {}) {
    handlers = { ...handlers, ...callbacks };
}

/** @param {'login'|'register'} [tab] */
export function openAuthModal(tab = 'login') {
    ensureAuthModal();
    switchTab(tab);
    openModal(authEl, { focus: tab === 'login' ? '#loginUsername' : '#regUsername' });
}

export function closeAuthModal() {
    if (authEl) closeModal(authEl);
}

/** @param {Avatar|null} current avatar user saat ini (untuk pre-select) */
export function openAvatarModal(current) {
    ensureAvatarModal();
    resetPick('change', current && !current.custom ? current.id : null);
    openModal(avatarEl);
}

export function closeAvatarModal() {
    if (avatarEl) closeModal(avatarEl);
}
