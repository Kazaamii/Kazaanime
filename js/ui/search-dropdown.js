/**
 * Kazanime — ui/search-dropdown.js
 * Autocomplete kotak pencarian navbar (AniList + Kitsu; MyAnimeList/Jikan dihapus 22 Okt 2026).
 *
 * Tampilan grup sama seperti file asli (kini AniList 5, Kitsu 5 — kuota MAL dibagi,
 * tanpa duplikat), dengan perbaikan:
 *  - Request sebelumnya DIBATALKAN saat user mengetik lagi (dulu hasil lama
 *    bisa menimpa hasil baru karena balapan request).
 *  - Grup tampil bertahap: sumber yang cepat tidak menunggu sumber yang lambat.
 *  - Hasil di-cache (lewat api/http.js) → mengetik ulang kata yang sama instan.
 *  - Item berupa link asli ke watch.html (bisa buka di tab baru), tanpa onclick inline.
 *  - Keyboard: ↑/↓ memilih, Enter membuka item terpilih (tanpa pilihan → halaman
 *    hasil lengkap), Esc menutup. ARIA combobox/listbox untuk pembaca layar.
 *  - Judul dari API di-escape (dulu disisipkan mentah → XSS).
 */
import { UI } from '../config.js';
import { suggestAnime, dedupeKeys } from '../api/index.js';
import { scoreLabel } from '../api/normalize.js';
import { html, debounce, placeholderImage } from './dom.js';
import { watchUrl, searchUrl } from '../routes.js';
import { icon } from './icons.js';

const GROUPS = [
    { source: 'anilist', label: 'AniList', badge: 'source-anilist', name: 'AniList' },
    { source: 'kitsu', label: 'Kitsu', badge: 'source-kitsu', name: 'Kitsu' },
];

/** Teks episode singkat (sama dengan dropdown asli): "24 EP" / "Ongoing" / "?". */
function epText(a) {
    if (a.episodes) return `${a.episodes} EP`;
    if (a.status === 'ONGOING') return 'Ongoing';
    return '?';
}

/**
 * @param {{form: HTMLFormElement, input: HTMLInputElement, dropdown: HTMLElement} | null} els
 */
export function initSearchDropdown(els) {
    if (!els?.input || !els.dropdown) return null;
    const { form, input, dropdown } = els;

    let controller = null;
    let currentQuery = '';
    /** @type {Record<string, any>} undefined = menunggu, Array = selesai, Error = gagal */
    let state = {};
    /** @type {{href:string}[]} */
    let options = [];
    let active = -1;

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-haspopup', 'listbox');

    /* ---------------- tampil / sembunyi ---------------- */
    function show() {
        dropdown.classList.add('active');
        input.setAttribute('aria-expanded', 'true');
    }
    function hide() {
        dropdown.classList.remove('active');
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        active = -1;
    }
    function cancel() {
        run.cancel();
        controller?.abort();
        controller = null;
    }

    /* ---------------- render ---------------- */
    function renderLoading(q) {
        options = [];
        active = -1;
        dropdown.innerHTML = String(html`<div class="search-loading">${icon('loader-circle', { cls: 'ic--spin' })} Mencari "${q}" di AniList + Kitsu...</div>`);
        show();
    }

    function render(q) {
        const seen = new Set();
        const groups = [];
        const pendingNames = [];
        let failed = 0;

        for (const g of GROUPS) {
            const value = state[g.source];
            if (value === undefined) { pendingNames.push(g.name); continue; }
            if (!Array.isArray(value)) { failed++; continue; }
            const unique = [];
            for (const anime of value) {
                const keys = dedupeKeys(anime);
                if (keys.some((k) => seen.has(k))) continue;
                keys.forEach((k) => seen.add(k));
                unique.push(anime);
                if (unique.length >= UI.suggestLimits[g.source]) break;
            }
            if (unique.length) groups.push({ ...g, items: unique });
        }

        const total = groups.reduce((n, g) => n + g.items.length, 0);
        if (!total && pendingNames.length) return; // tetap tampilkan "Mencari..."

        options = [];
        active = -1;
        input.removeAttribute('aria-activedescendant');

        if (!total) {
            dropdown.innerHTML = String(failed === GROUPS.length
                ? html`<div class="search-no-results" role="presentation"><p>${icon('triangle-alert')} Gagal memuat saran</p><small>Periksa koneksi, atau tekan Enter untuk pencarian lengkap</small></div>`
                : html`<div class="search-no-results" role="presentation"><p>${icon('search')} Tidak ditemukan "${q}"</p><small>Tekan Enter untuk pencarian lengkap di AniList & Kitsu</small></div>`);
            show();
            return;
        }

        let index = 0;
        const body = groups.map((g) => html`
            <div class="search-dropdown-header" data-source="${g.source}" role="presentation"><span class="src-dot" aria-hidden="true"></span>${g.label} <span class="source-badge ${g.badge}">${g.items.length} hasil</span></div>
            ${g.items.map((anime) => {
                const i = index++;
                const href = watchUrl(anime, 1);
                options.push({ href });
                return html`
                <a class="search-result-item" id="search-opt-${i}" role="option" aria-selected="false" href="${href}" data-index="${i}">
                    <img src="${anime.image || placeholderImage(anime.title, anime.color)}" alt="" loading="lazy" decoding="async" data-fallback data-color="${anime.color || ''}">
                    <div class="search-result-info">
                        <h4>${anime.title}</h4>
                        <p><span class="sr-score">${icon('star', { cls: 'ic--rating' })}${scoreLabel(anime)}</span><span>${epText(anime)}</span><span class="sr-format">${anime.format}</span></p>
                    </div>
                </a>`;
            })}`);

        dropdown.innerHTML = String(html`
            ${body}
            ${pendingNames.length ? html`<div class="search-loading search-loading--inline" role="presentation">${icon('loader-circle', { cls: 'ic--spin' })} Memuat ${pendingNames.join(' & ')}...</div>` : ''}
            <div class="search-dropdown-footer" role="presentation">
                <span>Tekan Enter untuk hasil lengkap</span>
                <a href="${searchUrl(q)}">Lihat Semua →</a>
            </div>`);
        show();
    }

    function setActive(next) {
        const items = dropdown.querySelectorAll('.search-result-item');
        if (!items.length) return;
        active = (next + items.length) % items.length;
        items.forEach((el, i) => {
            const on = i === active;
            el.classList.toggle('is-active', on);
            el.setAttribute('aria-selected', on ? 'true' : 'false');
            if (on) {
                input.setAttribute('aria-activedescendant', el.id);
                el.scrollIntoView({ block: 'nearest' });
            }
        });
    }

    /* ---------------- request ---------------- */
    function start(q) {
        cancel();
        controller = new AbortController();
        const { signal } = controller;
        currentQuery = q;
        state = {};
        renderLoading(q);

        const promises = suggestAnime(q, { signal });
        GROUPS.forEach(({ source }) => {
            promises[source]
                .then((items) => { state[source] = items; })
                .catch((err) => { state[source] = err instanceof Error ? err : new Error(String(err)); })
                .finally(() => {
                    if (!signal.aborted && currentQuery === q) render(q);
                });
        });
    }

    const run = debounce(start, UI.searchDebounce);

    /* ---------------- event ---------------- */
    input.addEventListener('input', () => {
        const q = input.value.trim();
        if (q.length < UI.searchMinChars) {
            cancel();
            currentQuery = '';
            hide();
            return;
        }
        run(q);
    });

    input.addEventListener('focus', () => {
        const q = input.value.trim();
        if (q.length < UI.searchMinChars) return;
        if (q === currentQuery && dropdown.childElementCount) show();
        else run(q);
    });

    input.addEventListener('keydown', (e) => {
        const open = dropdown.classList.contains('active');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open && dropdown.childElementCount) show();
            setActive(active + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(active - 1);
        } else if (e.key === 'Enter') {
            if (open && active >= 0 && options[active]) {
                e.preventDefault();
                window.location.href = options[active].href;
            } else {
                cancel(); // biarkan form submit → search.html?q=...
                hide();
            }
        } else if (e.key === 'Escape') {
            hide();
        } else if (e.key === 'Tab') {
            hide();
        }
    });

    // Klik di luar kotak pencarian → tutup
    document.addEventListener('click', (e) => {
        if (!form.contains(e.target)) hide();
    });

    // Klik item tidak membuat input kehilangan fokus sebelum navigasi
    dropdown.addEventListener('mousedown', (e) => {
        if (e.target.closest('a')) e.preventDefault();
    });
    dropdown.addEventListener('mousemove', (e) => {
        const item = e.target.closest('.search-result-item');
        if (item && Number(item.dataset.index) !== active) setActive(Number(item.dataset.index));
    });

    return { hide, cancel };
}
