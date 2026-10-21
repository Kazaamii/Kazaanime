/**
 * Kazanime — services/theme.js
 * Ganti tema (7 tema) + efek partikel. Perilaku sama dengan file asli:
 *  - 'sakura' = default (:root), atribut data-theme dihapus.
 *  - Efek partikel hanya dibuat jika user PERNAH memilih tema (sama seperti
 *    loadSavedTheme() asli) dan dilewati bila prefers-reduced-motion.
 *
 * Perbaikan: variabel `icons` yang tidak terpakai dihapus; partikel dibuat
 * dengan DocumentFragment (1 reflow, bukan 20); event 'kazanime:theme'
 * dikirim agar komponen lain (modal tema di tab lain, dsb.) bisa sinkron.
 */
import { THEMES, DEFAULT_THEME, STORAGE_KEYS, THEME_PARTICLE_COUNT } from '../config.js';
import { storage } from './storage.js';

const THEME_IDS = new Set(THEMES.map((t) => t.id));

export function getThemeMeta(id) {
    return THEMES.find((t) => t.id === id) || THEMES[0];
}

/** Tema tersimpan (atau null jika user belum pernah memilih). */
export function getSavedTheme() {
    const saved = storage.getRaw(STORAGE_KEYS.theme);
    return saved && THEME_IDS.has(saved) ? saved : null;
}

/** Tema aktif saat ini. */
export function getActiveTheme() {
    return getSavedTheme() || DEFAULT_THEME;
}

function setAttribute(id) {
    if (id === DEFAULT_THEME) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', id);
}

function prefersReducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Bangun ulang lapisan partikel untuk tema tertentu. */
export function applyThemeEffects(id) {
    document.querySelector('.visual-effects')?.remove();
    if (prefersReducedMotion()) return;

    const meta = getThemeMeta(id);
    const layer = document.createElement('div');
    layer.className = 'visual-effects';
    layer.setAttribute('aria-hidden', 'true');

    const frag = document.createDocumentFragment();
    for (let i = 0; i < THEME_PARTICLE_COUNT; i++) {
        const p = document.createElement('div');
        p.className = `particle-effect ${meta.particle}`;
        p.style.left = `${Math.random() * 100}%`;
        p.style.animationDuration = `${Math.random() * 10 + 10}s`;
        p.style.animationDelay = `${Math.random() * 5}s`;
        if (id === 'midnight') p.style.top = `${Math.random() * 50}%`;
        frag.appendChild(p);
    }
    layer.appendChild(frag);
    document.body.appendChild(layer);
}

/**
 * Terapkan & simpan tema.
 * @param {string} id
 * @returns {import('../config.js').THEMES[number]} meta tema yang diterapkan
 */
export function setTheme(id) {
    const themeId = THEME_IDS.has(id) ? id : DEFAULT_THEME;
    setAttribute(themeId);
    storage.setRaw(STORAGE_KEYS.theme, themeId);
    applyThemeEffects(themeId);
    window.dispatchEvent(new CustomEvent('kazanime:theme', { detail: { theme: themeId } }));
    return getThemeMeta(themeId);
}

/** Dipanggil sekali saat halaman dimuat (pengganti loadSavedTheme). */
export function initTheme() {
    const saved = getSavedTheme();
    if (saved) {
        setAttribute(saved);
        applyThemeEffects(saved);
    }
    // Sinkron antar-tab: ganti tema di tab lain → tab ini ikut
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEYS.theme && e.newValue && THEME_IDS.has(e.newValue)) {
            setAttribute(e.newValue);
            applyThemeEffects(e.newValue);
            window.dispatchEvent(new CustomEvent('kazanime:theme', { detail: { theme: e.newValue } }));
        }
    });
}
