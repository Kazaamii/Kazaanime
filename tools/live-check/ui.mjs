/**
 * Uji UI SEMENTARA (runner GitHub Actions) — tahap 2: pemutaran server AniZone (HLS) & ReAnime (embed).
 * Halaman AniZone/ReAnime diblokir Cloudflare dari IP runner, jadi respons /api/stream/servers DICEGAT
 * dan diisi data asli dari fixture (URL master AniZone & embed flixcloud yang ditangkap 22 Okt 2026),
 * ditandatangani dengan secret server yang sama. Yang diuji: player.js (video + hls.js), proxy
 * /api/stream/hls + /sub milik server asli, CDN AniZone asli, konversi ASS → VTT, iframe embed ReAnime.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { STREAMS } from '../../server/config.js';
import { createSigner, encodeTarget } from '../../server/lib/stream-proxy.js';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const OUT = '.live-check/ui3';
await mkdir(OUT, { recursive: true });
const signer = createSigner(STREAMS.secret);
const hls = (u) => `/api/stream/hls?u=${encodeTarget(u)}&s=${signer.sign(u)}`;
const sub = (u, f) => `/api/stream/sub?u=${encodeTarget(u)}&f=${f}&s=${signer.sign(`${u}|${f}`)}`;
const ROOT = 'https://suzaku.xin-cdn.xyz/77511fce-546a-42ed-b5ea-d454a5f07a23';
const FAKE = {
    ok: true, source: 'streams', fallback: false, stale: false, generatedAt: new Date().toISOString(),
    data: {
        episode: 3,
        status: { reanime: 'ok', anizone: 'ok' },
        servers: [
            { provider: 'reanime', kind: 'embed', name: 'ReAnime HD-2', label: 'HD-2', lang: 'en', url: 'https://flixcloud.cc/e/lmumbaiq7x0v?v=2' },
            { provider: 'reanime', kind: 'embed', name: 'ReAnime HD-1', label: 'HD-1', lang: 'en', url: 'https://flixcloud.cc/e/lmumbaiq7x0v?v=1' },
            {
                provider: 'anizone', kind: 'hls', name: 'AniZone', lang: 'multi', url: hls(`${ROOT}/master.m3u8`), direct: `${ROOT}/master.m3u8`,
                poster: `${ROOT}/snapshot.webp`,
                subtitles: [
                    { label: 'Indonesia', lang: 'id', default: true, url: sub(`${ROOT}/subtitles/8_id.ass`, 'ass') },
                    { label: 'English', lang: 'en', default: false, url: sub(`${ROOT}/subtitles/1_en.ass`, 'ass') },
                    { label: 'English (SDH)', lang: 'en', default: false, url: sub(`${ROOT}/subtitles/2_en.srt`, 'srt') },
                ],
            },
        ],
    },
};

const result = { console: [], api: [], steps: {} };
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') result.console.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => result.console.push(`pageerror: ${String(e).slice(0, 300)}`));
page.on('response', async (r) => {
    const u = r.url();
    if (!u.includes('/api/stream/')) return;
    let target = '';
    try { target = Buffer.from(new URL(u).searchParams.get('u') || '', 'base64url').toString('utf8').replace('https://suzaku.xin-cdn.xyz/77511fce-546a-42ed-b5ea-d454a5f07a23', '…'); } catch { /* abaikan */ }
    let body = '';
    if (r.status() >= 400) { try { body = (await r.text()).slice(0, 200); } catch { /* abaikan */ } }
    result.api.push(`${r.status()} ${(r.headers()['content-type'] || '').split(';')[0]} ${u.includes('/servers') ? '/servers' : target} ${body}`);
});
await page.route('**/api/stream/servers**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE) }));

await page.goto(`${BASE}/watch.html?anilist=159042&ep=3&title=Reincarnated%20as%20a%20Sword%20Season%202`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15000);
result.steps.servers = await page.evaluate(() => [...document.querySelectorAll('.server-btn')].map((b) => `${b.dataset.server}: ${b.textContent.replace(/\s+/g, ' ').trim()} [${b.className}]`));

// ---- AniZone Multi Sub (HLS) ----
await page.click('.server-btn[data-server="anizone"]');
await page.waitForTimeout(22000);
result.steps.anizone = await page.evaluate(async () => {
    const v = document.querySelector('video.player-video');
    if (!v) return { video: false, status: document.querySelector('#playerStatusText')?.textContent, stage: document.querySelector('#playerStage')?.innerText?.slice(0, 200) };
    v.muted = true;
    let played;
    try { await v.play(); played = true; } catch (e) { played = String(e); }
    const t0 = v.currentTime;
    await new Promise((r) => setTimeout(r, 10000));
    const tracks = [...v.textTracks].map((t) => ({ label: t.label, lang: t.language, mode: t.mode, cues: t.cues ? t.cues.length : null }));
    return {
        video: true, mode: v.dataset.mode, readyState: v.readyState, played, t0, t1: v.currentTime, duration: v.duration,
        size: `${v.videoWidth}x${v.videoHeight}`, error: v.error ? `${v.error.code} ${v.error.message}` : null, tracks,
        audioTracks: v.audioTracks ? v.audioTracks.length : 'n/a',
        status: document.querySelector('#playerStatusText')?.textContent,
    };
});
await page.screenshot({ path: `${OUT}/anizone-playing.jpg`, type: 'jpeg', quality: 75 });
// subtitle: tampilkan cue aktif pertama agar terlihat di screenshot
result.steps.firstCues = await page.evaluate(() => {
    const v = document.querySelector('video.player-video');
    const t = v && [...v.textTracks].find((x) => x.mode === 'showing');
    return t && t.cues ? [...t.cues].slice(0, 3).map((c) => `${c.startTime.toFixed(1)}–${c.endTime.toFixed(1)} ${c.text.replace(/\n/g, ' / ').slice(0, 80)}`) : null;
});

// ---- ReAnime (embed flixcloud) ----
await page.click('.server-btn[data-server="reanime"]');
await page.waitForTimeout(15000);
result.steps.reanime = await page.evaluate(() => ({
    iframe: document.querySelector('iframe.player-frame')?.src || null,
    status: document.querySelector('#playerStatusText')?.textContent,
}));
await page.screenshot({ path: `${OUT}/reanime-embed.jpg`, type: 'jpeg', quality: 75 });
const frame = page.frames().find((f) => f.url().includes('flixcloud.cc'));
if (frame) {
    try {
        result.steps.reanimeFrame = await frame.evaluate(() => ({ title: document.title, text: document.body.innerText.slice(0, 200) }));
    } catch (e) { result.steps.reanimeFrame = String(e).slice(0, 200); }
}

await browser.close();
await writeFile(`${OUT}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1).slice(0, 5000));
