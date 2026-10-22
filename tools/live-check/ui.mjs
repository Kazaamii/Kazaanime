/**
 * Uji UI SEMENTARA di runner GitHub Actions (Playwright + Chromium). Bukan bagian aplikasi.
 * Hasil: .live-check/ui/*.jpg + .live-check/ui/result.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, devices } from 'playwright';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const OUT = '.live-check/ui';
const result = { console: [], api: [], pages: {} };
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

async function open(name, url, { mobile = false } = {}) {
    const ctx = await browser.newContext(mobile ? { ...devices['iPhone 13'] } : { viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') result.console.push({ page: name, type: m.type(), text: m.text().slice(0, 400) });
    });
    page.on('pageerror', (e) => result.console.push({ page: name, type: 'pageerror', text: String(e?.stack || e).slice(0, 600) }));
    page.on('response', (r) => {
        const u = r.url();
        if (u.includes('/api/') && !u.includes('/api/stream/hls')) result.api.push({ page: name, status: r.status(), url: u.replace(BASE, '').slice(0, 200) });
        if (u.includes('/api/stream/hls') && r.status() >= 400) result.api.push({ page: name, status: r.status(), url: u.replace(BASE, '').slice(0, 120) });
    });
    page.on('requestfailed', (r) => {
        const u = r.url();
        if (u.startsWith(BASE)) result.console.push({ page: name, type: 'requestfailed', text: `${u.replace(BASE, '')} ${r.failure()?.errorText}` });
    });
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return { ctx, page };
}
const shot = (page, name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 72, ...opts });

/* ---------------- Beranda ---------------- */
for (const mobile of [false, true]) {
    const name = mobile ? 'home-mobile' : 'home-desktop';
    const { ctx, page } = await open(name, '/', { mobile });
    await page.waitForTimeout(14000);
    await shot(page, `${name}-top`);
    await shot(page, `${name}-full`, { fullPage: true });
    result.pages[name] = await page.evaluate(() => ({
        order: [...document.querySelectorAll('main > section')].map((s) => s.id),
        iconsHydrated: document.querySelectorAll('.ic-slot').length === 0,
        svgIcons: document.querySelectorAll('svg.ic').length,
        bodyFont: getComputedStyle(document.body).fontFamily,
        titleFont: getComputedStyle(document.querySelector('.section-title')).fontFamily,
        fontsLoaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`).slice(0, 12),
        cards: document.querySelectorAll('.anime-card').length,
        bookmarkBtn: (() => {
            const b = document.querySelector('.anime-card .card-bookmark-btn');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            const img = b.closest('.anime-card-img').getBoundingClientRect();
            return { top: Math.round(r.top - img.top), right: Math.round(img.right - r.right), opacity: getComputedStyle(b).opacity, w: Math.round(r.width) };
        })(),
        schedule: document.querySelectorAll('.schedule-item').length,
        scheduleNote: document.querySelector('#scheduleNote')?.textContent?.slice(0, 200),
        emojiLeft: (document.querySelector('main').innerText.match(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu) || []).slice(0, 20),
    }));
    if (!mobile) {
        // klik genre → hasil langsung di bawah tombol
        await page.click('.genre-tag[data-genre="Action"]');
        await page.waitForTimeout(7000);
        const genre = await page.$('#genre');
        await genre.screenshot({ path: `${OUT}/home-genre-results.jpg`, type: 'jpeg', quality: 72 });
        result.pages['genre-click'] = await page.evaluate(() => ({
            visible: !document.querySelector('#genreResults').hidden,
            title: document.querySelector('#genreResultsTitle').textContent,
            cards: document.querySelectorAll('#genreGrid .anime-card').length,
            popularTitle: document.querySelector('#popular .section-title')?.textContent?.trim(),
        }));
        await page.click('#genreClose');
        await page.waitForTimeout(500);
        result.pages['genre-close'] = await page.evaluate(() => ({ hidden: document.querySelector('#genreResults').hidden }));
    }
    await ctx.close();
}

/* ---------------- Halaman nonton ---------------- */
async function watch(name, url, { mobile = false, anizone = false } = {}) {
    const { ctx, page } = await open(name, url, { mobile });
    await page.waitForTimeout(26000);
    await shot(page, `${name}-top`);
    const info = await page.evaluate(() => ({
        title: document.querySelector('#watchTitle')?.textContent,
        status: document.querySelector('#playerStatusText')?.textContent,
        servers: [...document.querySelectorAll('.server-btn')].map((b) => `${b.textContent.replace(/\s+/g, ' ').trim()} [${b.className.replace('server-btn', '').trim()}] (${b.getAttribute('title') || ''})`),
        iframe: document.querySelector('.player-frame')?.getAttribute('src')?.slice(0, 120) || null,
        meta: document.querySelector('#watchMeta')?.innerText?.replace(/\s+/g, ' ').slice(0, 200),
        downloads: document.querySelectorAll('.download-item').length,
    }));
    result.pages[name] = info;
    if (anizone) {
        const btn = await page.$('.server-btn[data-server="anizone"]');
        if (btn && !(await btn.getAttribute('aria-disabled')).includes('true')) {
            await btn.click();
            await page.waitForTimeout(20000);
            const state = await page.evaluate(async () => {
                const v = document.querySelector('video.player-video');
                if (!v) return { video: false, status: document.querySelector('#playerStatusText')?.textContent };
                v.muted = true;
                let played = null;
                try { await v.play(); played = true; } catch (e) { played = String(e); }
                await new Promise((r) => setTimeout(r, 9000));
                return {
                    video: true, mode: v.dataset.mode, readyState: v.readyState, currentTime: v.currentTime, duration: v.duration,
                    played, error: v.error ? `${v.error.code} ${v.error.message}` : null, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
                    tracks: [...v.textTracks].map((t) => `${t.label}:${t.mode}:${t.cues ? t.cues.length : 'null'}`),
                    status: document.querySelector('#playerStatusText')?.textContent,
                };
            });
            result.pages[`${name}-anizone`] = state;
            await shot(page, `${name}-anizone`);
        } else {
            result.pages[`${name}-anizone`] = { button: btn ? await btn.getAttribute('title') : 'tidak ada tombol' };
        }
    }
    await ctx.close();
}
await watch('watch-desktop', '/watch.html?anilist=159042&ep=3&title=Reincarnated%20as%20a%20Sword%20Season%202&alt=Tensei%20Shitara%20Ken%20Deshita%202nd%20Season', { anizone: true });
await watch('watch-mobile', '/watch.html?anilist=21&ep=1&title=One%20Piece', { mobile: true });

/* ---------------- Pencarian ---------------- */
{
    const { ctx, page } = await open('search', '/search.html?q=frieren');
    await page.waitForTimeout(12000);
    await shot(page, 'search-desktop');
    result.pages.search = await page.evaluate(() => ({
        tabs: [...document.querySelectorAll('.search-source-tab')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
        cards: document.querySelectorAll('.anime-card').length,
    }));
    await ctx.close();
}

await browser.close();
await writeFile(`${OUT}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.pages, null, 1).slice(0, 4000));
console.log('console errors:', result.console.length);
