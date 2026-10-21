/**
 * Kazanime — ui/dom.js
 * Helper DOM kecil + template HTML yang AMAN.
 *
 * Masalah di file asli: judul dari API dimasukkan mentah ke innerHTML dan ke
 * onclick="openPlayer('...')" (hanya ' yang di-escape) → judul berisi tanda
 * kutip memutus atribut, dan input pencarian bisa menyuntik HTML (XSS).
 *
 * Solusi: tagged template `html`...`` meng-escape SEMUA nilai interpolasi
 * secara default. Hanya nilai yang dibungkus raw() atau hasil html`` lain
 * yang disisipkan apa adanya.
 */
import { AVATAR_COLORS, AVATAR_EMOJIS } from '../config.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/* ------------------------------------------------------------------ */
/* Escaping & template aman                                            */
/* ------------------------------------------------------------------ */
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"'`]/g, (c) => ESCAPE_MAP[c]);
}

class SafeHtml {
    constructor(value) { this.value = value; }
    toString() { return this.value; }
}

/** Tandai string sebagai HTML tepercaya (JANGAN dipakai untuk data API/user). */
export const raw = (value) => new SafeHtml(String(value ?? ''));

function serialize(value) {
    if (value == null || value === false) return '';
    if (value instanceof SafeHtml) return value.value;
    if (Array.isArray(value)) return value.map(serialize).join('');
    return escapeHtml(value);
}

/**
 * Template HTML ber-escape otomatis.
 * @example el.innerHTML = html`<h3>${anime.title}</h3>`;
 */
export function html(strings, ...values) {
    let out = '';
    strings.forEach((chunk, i) => {
        out += chunk;
        if (i < values.length) out += serialize(values[i]);
    });
    return new SafeHtml(out);
}

/** Set isi elemen dari hasil html`` (atau string tepercaya). */
export function setHTML(el, content) {
    if (el) el.innerHTML = String(content);
}

/** Hanya izinkan URL http(s) (cegah javascript:/data: dari data scraping). */
export function safeUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url, window.location.href);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
    } catch {
        return '';
    }
}

/* ------------------------------------------------------------------ */
/* Event delegation                                                    */
/* ------------------------------------------------------------------ */
/**
 * Satu listener untuk banyak elemen dinamis (pengganti onclick inline).
 * @param {Element|Document} root
 * @param {string} type
 * @param {string} selector
 * @param {(event: Event, target: Element) => void} handler
 */
export function delegate(root, type, selector, handler, options) {
    const listener = (event) => {
        const target = event.target instanceof Element ? event.target.closest(selector) : null;
        if (target && (root === document || root.contains(target))) handler(event, target);
    };
    root.addEventListener(type, listener, options);
    return () => root.removeEventListener(type, listener, options);
}

export function debounce(fn, wait) {
    let timer;
    const debounced = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
}

/* ------------------------------------------------------------------ */
/* Gambar placeholder & fallback                                       */
/* ------------------------------------------------------------------ */
const PLACEHOLDER_COLORS = ['#6366f1', '#ef4444', '#f59e0b', '#8b5cf6', '#06b6d4', '#10b981', '#ec4899', '#f97316', '#d946ef', '#14b8a6'];

/** Warna deterministik dari judul (dulu Math.random → berubah tiap render). */
export function colorFor(text) {
    let hash = 0;
    for (const ch of String(text)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return PLACEHOLDER_COLORS[hash % PLACEHOLDER_COLORS.length];
}

const placeholderCache = new Map();

/** Poster SVG (desain sama dengan generateAnimeImage di file asli). */
export function placeholderImage(title = 'Kazanime', color) {
    const key = `${title}|${color || ''}`;
    if (placeholderCache.has(key)) return placeholderCache.get(key);
    const t = title.length > 18 ? `${title.substring(0, 18)}...` : title;
    const fill = color || colorFor(title);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:${fill}"/><stop offset="100%" style="stop-color:#1a1a2e"/></linearGradient></defs><rect width="300" height="400" fill="url(#g)"/><circle cx="150" cy="160" r="60" fill="rgba(255,255,255,.1)"/><circle cx="150" cy="160" r="40" fill="rgba(255,255,255,.1)"/><text x="150" y="280" text-anchor="middle" fill="rgba(255,255,255,.9)" font-family="sans-serif" font-size="16" font-weight="bold">${escapeHtml(t)}</text><text x="150" y="310" text-anchor="middle" fill="rgba(255,255,255,.5)" font-family="sans-serif" font-size="12">Kazanime</text></svg>`;
    const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    placeholderCache.set(key, uri);
    return uri;
}

const avatarCache = new Map();

/** Avatar emoji di atas gradient (identik dengan getFallbackAvatar asli), di-cache. */
export function emojiAvatar(id) {
    const key = Number(id) || 1;
    if (avatarCache.has(key)) return avatarCache.get(key);
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 100, 100);
    gradient.addColorStop(0, AVATAR_COLORS[(key - 1) % AVATAR_COLORS.length] || '#ff6b9d');
    gradient.addColorStop(1, '#1a1a2e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 100, 100);
    ctx.font = '50px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(AVATAR_EMOJIS[(key - 1) % AVATAR_EMOJIS.length] || '🌸', 50, 50);
    const uri = canvas.toDataURL();
    avatarCache.set(key, uri);
    return uri;
}

/**
 * Satu listener global untuk semua <img data-fallback="...">
 * (pengganti onerror inline yang membawa data URI panjang di tiap kartu).
 *   data-fallback=""            → poster placeholder dari alt
 *   data-fallback="avatar:12"   → avatar emoji #12
 *   data-fallback="emoji:🎴"    → ganti <img> dengan teks emoji
 *   data-fallback="<url>"       → pakai URL lain
 */
let fallbackInstalled = false;
export function installImageFallback() {
    if (fallbackInstalled) return;
    fallbackInstalled = true;
    document.addEventListener('error', (event) => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-fallback') || img.dataset.failed) return;
        img.dataset.failed = '1';
        const spec = img.dataset.fallback || '';
        if (spec.startsWith('emoji:')) {
            img.replaceWith(document.createTextNode(spec.slice(6)));
        } else if (spec.startsWith('avatar:')) {
            img.src = emojiAvatar(spec.slice(7));
        } else if (spec) {
            img.src = spec;
        } else {
            img.src = placeholderImage(img.alt || 'Kazanime', img.dataset.color);
        }
    }, true); // capture: event 'error' tidak bubble
}

/** URL gambar avatar user (custom upload / pilihan grid / fallback emoji). */
export function avatarSrc(avatar) {
    if (!avatar) return emojiAvatar(1);
    return avatar.img || emojiAvatar(avatar.id || 1);
}
