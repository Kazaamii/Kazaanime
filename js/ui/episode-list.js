/**
 * Kazanime — ui/episode-list.js
 * Daftar episode di watch.html.
 *
 *  - Tombol episode = link <a> asli (bisa klik-tengah / buka di tab baru);
 *    klik biasa ditangani di halaman (tanpa reload) lewat onSelect.
 *  - Jumlah episode dari API (bukan angka 24 tetap seperti file asli).
 *  - > PLAYER.episodesPerRange episode → tab rentang (1–100, 101–200, ...),
 *    hanya tombol rentang aktif yang dirender (One Piece: 100 tombol, bukan 1000+).
 *  - Jumlah tidak diketahui → input nomor episode manual (seperti file asli).
 *  - Penanda "sudah ditonton" (.is-watched).
 * Tidak ada fetch di sini.
 */
import { PLAYER } from '../config.js';
import { icon } from './icons.js';
import { html, raw, delegate } from './dom.js';
import { showToast } from './toast.js';

/**
 * @param {{
 *   grid: HTMLElement,                 wadah tombol (#episodeGrid)
 *   tabs: HTMLElement,                 wadah tab rentang (#epRangeTabs)
 *   hrefFor: (ep: number) => string,   URL episode (watch.html?...&ep=N)
 *   onSelect: (ep: number) => void,
 * }} opts
 */
export function createEpisodeList({ grid, tabs, hrefFor, onSelect }) {
    const size = PLAYER.episodesPerRange;
    /** undefined = memuat · null = tidak diketahui · 0 = belum tayang · n = jumlah episode */
    let total;
    let current = 1;
    let watched = new Set();
    let rangeStart = 1;
    let emptyText = '';

    const rangeOf = (n) => Math.floor((n - 1) / size) * size + 1;

    function renderTabs() {
        if (!total || total <= size) {
            tabs.hidden = true;
            tabs.replaceChildren();
            return;
        }
        const starts = [];
        for (let s = 1; s <= total; s += size) starts.push(s);
        tabs.hidden = false;
        tabs.innerHTML = String(html`${starts.map((s) => {
            const on = s === rangeStart;
            return html`<button type="button" class="ep-range-tab${on ? ' active' : ''}" data-start="${s}" aria-pressed="${on ? 'true' : 'false'}">${s}–${Math.min(s + size - 1, total)}</button>`;
        })}`);
    }

    function renderGrid() {
        grid.setAttribute('aria-busy', total === undefined ? 'true' : 'false');
        if (total === undefined) {
            grid.innerHTML = String(html`${Array.from({ length: 12 }, () => html`<span class="ep-btn ep-skeleton loading-shimmer" aria-hidden="true"></span>`)}`);
            return;
        }
        if (total === null) {
            grid.innerHTML = String(html`
                <div class="episode-manual">
                    <p>Jumlah episode belum diketahui. Masukkan nomor episode:</p>
                    <form novalidate>
                        <input type="number" name="ep" min="1" max="${PLAYER.maxEpisode}" value="${current}" inputmode="numeric" aria-label="Nomor episode">
                        <button type="submit">${icon('play')} Putar</button>
                    </form>
                </div>`);
            return;
        }
        if (total === 0) {
            grid.innerHTML = String(html`<p class="episode-empty">${emptyText || 'Belum ada episode yang tayang.'}</p>`);
            return;
        }
        const end = Math.min(rangeStart + size - 1, total);
        const items = [];
        for (let n = rangeStart; n <= end; n++) items.push(n);
        grid.innerHTML = String(html`${items.map((n) => {
            const on = n === current;
            const seen = watched.has(n);
            return html`<a class="ep-btn${on ? ' active' : ''}${seen ? ' is-watched' : ''}" href="${hrefFor(n)}" data-ep="${n}" ${on ? raw('aria-current="page"') : ''} title="${seen ? `Episode ${n} (sudah ditonton)` : `Episode ${n}`}">EP ${n}</a>`;
        })}`);
    }

    /** Gulir daftar (bukan halaman) agar tombol aktif terlihat. */
    function revealActive() {
        const btn = grid.querySelector('.ep-btn.active');
        const box = grid.closest('.streaming-eps-scroll');
        if (!btn || !box) return;
        const top = btn.offsetTop - box.offsetTop;
        if (top < box.scrollTop || top + btn.offsetHeight > box.scrollTop + box.clientHeight) {
            box.scrollTop = Math.max(0, top - box.clientHeight / 2);
        }
    }

    function render() {
        renderTabs();
        renderGrid();
    }

    /* Klik episode: tangani di halaman, kecuali klik-tengah / Ctrl / Shift (biarkan browser) */
    delegate(grid, 'click', 'a.ep-btn[data-ep]', (event, a) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onSelect(Number(a.dataset.ep));
    });
    delegate(tabs, 'click', '.ep-range-tab[data-start]', (_event, btn) => {
        rangeStart = Number(btn.dataset.start) || 1;
        render();
    });
    delegate(grid, 'submit', '.episode-manual form', (event, form) => {
        event.preventDefault();
        const n = Number.parseInt(form.elements.ep.value, 10);
        if (!Number.isInteger(n) || n < 1 || n > PLAYER.maxEpisode) {
            showToast(`Masukkan nomor episode 1–${PLAYER.maxEpisode}.`, 'error');
            return;
        }
        onSelect(n);
    });

    return {
        get total() { return total; },

        /** Tampilkan kerangka loading. */
        setLoading() {
            total = undefined;
            render();
        },

        /**
         * @param {number|null} n  jumlah episode (null = tidak diketahui, 0 = belum tayang)
         * @param {{emptyText?: string}} [opts]
         */
        setTotal(n, { emptyText: text = '' } = {}) {
            total = n;
            emptyText = text;
            if (n) rangeStart = rangeOf(Math.min(current, n));
            render();
            requestAnimationFrame(revealActive);
        },

        /** Tandai episode aktif (pindah tab rentang bila perlu). */
        setCurrent(n) {
            current = n;
            if (total && n <= total) rangeStart = rangeOf(n);
            if (total === null) {
                const input = grid.querySelector('.episode-manual input[name="ep"]');
                if (input) input.value = String(n);
                return;
            }
            render();
            requestAnimationFrame(revealActive);
        },

        /** @param {Set<number>} set */
        setWatched(set) {
            watched = set;
            if (total) renderGrid();
        },

        /** Render ulang (mis. setelah id anime berubah → URL tombol ikut berubah). */
        refresh() {
            if (total !== null) render();
        },
    };
}
