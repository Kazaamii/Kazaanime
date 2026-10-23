/**
 * Kazanime — ui/hero.js
 * Hero slider homepage (UI murni; data diberikan oleh pemanggil).
 *
 * Perbaikan dari file asli:
 *  - Gambar slide di-lazy-load (slide aktif + berikutnya saja). Dulu 8 gambar
 *    besar diunduh bersamaan saat halaman dibuka.
 *  - Gambar gagal → tetap gradient tema, bukan kotak hitam.
 *  - Utamakan banner lebar; poster potret hanya cadangan (poster 2:3 yang
 *    di-stretch ke hero 1400×600 tampak pecah).
 *  - Status tombol Bookmark benar per slide (dulu selalu "Bookmark" dan bug
 *    toggleHeroBookmark yang terdefinisi DUA kali + elemen #heroBookmarkBtn
 *    yang sudah tidak ada → error setiap updateBookmarkUI()).
 *  - Autoplay berhenti saat tab tidak terlihat / fokus keyboard di hero, dan
 *    timer di-reset setelah navigasi manual.
 *  - Tanpa onclick inline: tombol pakai event listener.
 */
import { html, raw } from './dom.js';
import { watchUrl } from '../routes.js';
import { episodeLabel, scoreLabel } from '../api/normalize.js';
import { UI } from '../config.js';
import { icon } from './icons.js';

const DEFAULT_DESC = 'Anime trending yang sedang populer. Cek server untuk pilihan Multi Sub dan bahasa subtitle yang tersedia.';
const ICON_PLAY = raw('<svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>');
const ICON_BM_OFF = raw('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>');
const ICON_BM_ON = raw('<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>');

const truncate = (text, max = 220) => (text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text);

/**
 * @param {HTMLElement} root  elemen <section class="hero">
 * @param {{interval?: number, isBookmarked?: (a) => boolean, onBookmark?: (a) => void}} [opts]
 */
export function createHeroSlider(root, { interval = UI.heroInterval, isBookmarked = () => false, onBookmark = () => {} } = {}) {
    const sliderEl = root.querySelector('#heroSlider');
    const contentEl = root.querySelector('#heroContent');
    const dotsEl = root.querySelector('#heroDots');
    const prevBtn = root.querySelector('[data-hero="prev"]');
    const nextBtn = root.querySelector('[data-hero="next"]');

    let slides = [];
    let current = 0;
    let timer = null;
    let paused = false;
    const loaded = new Map(); // url → Promise<boolean>

    function preload(url) {
        if (!url) return Promise.resolve(false);
        if (!loaded.has(url)) {
            loaded.set(url, new Promise((resolve) => {
                const img = new Image();
                img.decoding = 'async';
                img.onload = () => resolve(true);
                img.onerror = () => resolve(false);
                img.src = url;
            }));
        }
        return loaded.get(url);
    }

    async function loadBackground(index) {
        const slide = slides[index];
        const el = sliderEl.children[index];
        if (!slide || !el || el.dataset.bg) return;
        el.dataset.bg = 'pending';
        // Banner dulu, lalu poster sebagai cadangan
        for (const url of [slide.banner, slide.image]) {
            if (url && (await preload(url))) {
                el.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
                el.dataset.bg = 'ok';
                return;
            }
        }
        el.dataset.bg = 'failed'; // tetap gradient --hero-bg dari CSS
    }

    function contentHTML(slide) {
        const bookmarked = isBookmarked(slide);
        const genres = slide.genres.slice(0, 3).join(', ') || 'Anime';
        return html`
        <div class="hero-info">
            <div class="hero-badge"><span class="dot"></span><span>Trending Now</span></div>
            <h1 class="hero-title">${slide.title}</h1>
            <p class="hero-description">${truncate(slide.description || DEFAULT_DESC)}</p>
            <div class="hero-meta">
                <span class="hero-meta-score">${icon('star', { cls: 'ic--rating' })}${scoreLabel(slide)}</span>
                <span>${icon('tags')}${genres}</span>
                ${slide.year ? html`<span>${icon('calendar')}${slide.year}</span>` : ''}
                ${episodeLabel(slide) ? html`<span>${icon('film')}${episodeLabel(slide)}</span>` : ''}
                <span>${icon('captions')}Multi Sub</span>
            </div>
            <div class="hero-buttons">
                <a class="btn-watch" href="${watchUrl(slide, 1)}">${ICON_PLAY} Tonton Sekarang</a>
                <button type="button" class="btn-bookmark-hero ${bookmarked ? 'bookmarked' : ''}" data-hero="bookmark" aria-pressed="${bookmarked ? 'true' : 'false'}">
                    ${bookmarked ? ICON_BM_ON : ICON_BM_OFF} ${bookmarked ? 'Bookmarked' : 'Bookmark'}
                </button>
            </div>
        </div>`;
    }

    function renderEmpty() {
        sliderEl.innerHTML = '<div class="hero-slide active"></div>';
        dotsEl.innerHTML = '';
        contentEl.innerHTML = String(html`
            <div class="hero-info">
                <h1 class="hero-title">Selamat Datang di Kazanime</h1>
                <p class="hero-description">Temukan anime dengan pilihan Multi Sub; bahasa yang tersedia bergantung pada judul dan server.</p>
            </div>`);
        prevBtn.hidden = true;
        nextBtn.hidden = true;
    }

    function goTo(index, { user = false } = {}) {
        if (!slides.length) return;
        current = (index + slides.length) % slides.length;
        Array.from(sliderEl.children).forEach((el, i) => el.classList.toggle('active', i === current));
        Array.from(dotsEl.children).forEach((el, i) => {
            el.classList.toggle('active', i === current);
            el.setAttribute('aria-current', i === current ? 'true' : 'false');
        });
        contentEl.innerHTML = String(contentHTML(slides[current]));
        loadBackground(current);
        loadBackground((current + 1) % slides.length); // pre-load slide berikutnya
        if (user) restart();
    }

    function start() {
        stop();
        if (slides.length > 1 && !paused && !document.hidden) {
            timer = setInterval(() => goTo(current + 1), interval);
        }
    }
    function stop() {
        clearInterval(timer);
        timer = null;
    }
    function restart() {
        start();
    }

    /* ---------- Event listener (pengganti onclick inline) ---------- */
    prevBtn.addEventListener('click', () => goTo(current - 1, { user: true }));
    nextBtn.addEventListener('click', () => goTo(current + 1, { user: true }));
    dotsEl.addEventListener('click', (e) => {
        const dot = e.target.closest('.hero-dot');
        if (dot) goTo(Number(dot.dataset.index), { user: true });
    });
    contentEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-hero="bookmark"]') && slides[current]) {
            onBookmark(slides[current]);
            refresh();
        }
    });
    // Jeda hanya untuk fokus KEYBOARD (klik mouse pada tombol tidak menghentikan autoplay)
    root.addEventListener('focusin', (e) => {
        if (e.target instanceof Element && e.target.matches(':focus-visible')) { paused = true; stop(); }
    });
    root.addEventListener('focusout', (e) => {
        if (paused && !root.contains(e.relatedTarget)) { paused = false; start(); }
    });
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

    /** Ganti isi slider. */
    function setSlides(list) {
        slides = (list || []).slice(0, UI.heroMaxSlides);
        current = 0;
        if (!slides.length) {
            stop();
            renderEmpty();
            return;
        }
        prevBtn.hidden = slides.length < 2;
        nextBtn.hidden = slides.length < 2;
        sliderEl.innerHTML = String(html`${slides.map((_, i) => html`<div class="hero-slide${i === 0 ? ' active' : ''}"></div>`)}`);
        dotsEl.innerHTML = String(html`${slides.map((s, i) => html`<button type="button" class="hero-dot${i === 0 ? ' active' : ''}" data-index="${i}" aria-label="Slide ${i + 1}: ${s.title}"></button>`)}`);
        goTo(0);
        start();
    }

    /** Render ulang konten slide aktif (mis. setelah status bookmark/login berubah). */
    function refresh() {
        if (slides[current]) contentEl.innerHTML = String(contentHTML(slides[current]));
    }

    return { setSlides, refresh, next: () => goTo(current + 1, { user: true }), prev: () => goTo(current - 1, { user: true }) };
}
