/**
 * Probe sementara (dijalankan di runner GitHub Actions, BUKAN bagian aplikasi).
 * Mengambil halaman asli situs sumber untuk fixture test + mengecek akses/header.
 * Hasil ditulis ke .live-check/ lalu di-commit oleh workflow.
 */
import { writeFile, mkdir } from 'node:fs/promises';

const OUT = '.live-check';
const RAW = `${OUT}/raw`;
const UA_BOT = 'KazanimeBot/1.0 (+https://github.com/Kazaamii/Kazaanime)';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const BROWSER = {
    'User-Agent': UA_BROWSER,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
};
const PICK = ['content-type', 'content-length', 'access-control-allow-origin', 'access-control-allow-credentials',
    'x-frame-options', 'content-security-policy', 'cross-origin-resource-policy', 'server', 'cf-mitigated',
    'cache-control', 'location', 'set-cookie', 'x-ratelimit-limit'];

const summary = [];

async function get(name, url, { ua = 'bot', headers = {}, save = true, max = 450_000, timeout = 25_000, method = 'GET' } = {}) {
    const h = ua === 'bot' ? { 'User-Agent': UA_BOT, Accept: '*/*' } : ua === 'browser' ? { ...BROWSER } : {};
    Object.assign(h, headers);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const rec = { name, url, ua, sentHeaders: Object.keys(headers) };
    try {
        const res = await fetch(url, { method, headers: h, redirect: 'follow', signal: ctrl.signal });
        const buf = Buffer.from(await res.arrayBuffer());
        rec.status = res.status;
        rec.finalUrl = res.url;
        rec.size = buf.length;
        rec.headers = Object.fromEntries(PICK.filter((k) => res.headers.get(k)).map((k) => [k, String(res.headers.get(k)).slice(0, 300)]));
        rec.head = buf.subarray(0, 160).toString('latin1').replace(/\s+/g, ' ');
        const text = /text|json|xml|mpegurl|vtt|javascript|css/i.test(res.headers.get('content-type') || '') || /\.(m3u8|vtt|ass|srt)(\?|$)/i.test(url);
        if (save && text) {
            const file = `${RAW}/${name}`;
            await writeFile(file, buf.subarray(0, max));
            rec.saved = file;
        }
        rec.text = text ? buf.toString('utf8') : '';
    } catch (e) {
        rec.status = 0;
        rec.error = String(e?.cause?.code || e?.name || e?.message || e);
        rec.text = '';
    } finally {
        clearTimeout(timer);
    }
    const { text, ...log } = rec;
    summary.push(log);
    console.log(`${String(rec.status).padStart(3)} ${ua.padEnd(7)} ${name}  ${rec.error || ''} ${rec.size ?? ''}`);
    return rec;
}

/** Coba UA jujur dulu; bila ditolak (403/503/0) ulangi dengan header browser. */
async function getAny(name, url, opts = {}) {
    const a = await get(`${name}.bot`, url, { ...opts, ua: 'bot', save: false });
    if (a.status === 200) return get(name, url, { ...opts, ua: 'bot' });
    return get(name, url, { ...opts, ua: 'browser' });
}

const first = (text, re) => (String(text || '').match(re) || [])[1] || '';
const abs = (u, base) => { try { return new URL(u.replace(/&amp;/g, '&'), base).href; } catch { return ''; } };

await mkdir(RAW, { recursive: true });

/* ---------------- ANICHIN ---------------- */
{
    const B = 'https://anichin.moe';
    await getAny('anichin-robots.txt', `${B}/robots.txt`);
    const home = await getAny('anichin-home.html', `${B}/`);
    await getAny('anichin-schedule.html', `${B}/schedule/`);
    await getAny('anichin-search.html', `${B}/?s=renegade+immortal`);
    await getAny('anichin-list.html', `${B}/anime/?status=&type=&order=update`);
    const series = await getAny('anichin-series.html', `${B}/renegade-immortal/`);
    await getAny('anichin-series-prefixed.html', `${B}/anime/martial-master/`);
    const epUrl = first(series.text, /href="(https:\/\/anichin\.moe\/renegade-immortal-episode-[^"]+)"/i);
    if (epUrl) await getAny('anichin-episode.html', epUrl);
    const img = first(home.text, /(https:\/\/anichin\.moe\/wp-content\/uploads\/[^"' )]+\.(?:webp|jpg|jpeg|png))/i);
    if (img) {
        await get('anichin-image.noref', img, { ua: 'browser', save: false });
        await get('anichin-image.ref', img, { ua: 'browser', save: false, headers: { Referer: 'https://kazanime.vercel.app/' } });
    }
}

/* ---------------- OTAKUDESU ---------------- */
{
    const B = 'https://otakudesu.blog';
    await get('otakudesu-robots.bot', `${B}/robots.txt`, { ua: 'bot', save: false });
    await get('otakudesu-robots.txt', `${B}/robots.txt`, { ua: 'browser' });
    const home = await getAny('otakudesu-home.html', `${B}/`);
    await getAny('otakudesu-ongoing.html', `${B}/ongoing-anime/`);
    await getAny('otakudesu-search.html', `${B}/?s=one+piece&post_type=anime`);
    await getAny('otakudesu-schedule.html', `${B}/jadwal-rilis/`);
    const animeUrl = first(home.text, /href="(https:\/\/otakudesu\.blog\/anime\/[^"]+)"/i);
    const anime = animeUrl ? await getAny('otakudesu-anime.html', animeUrl) : { text: '' };
    const epUrl = first(anime.text, /href="(https:\/\/otakudesu\.blog\/episode\/[^"]+)"/i);
    if (epUrl) await getAny('otakudesu-episode.html', epUrl);
}

/* ---------------- HIANIME.RO ---------------- */
{
    const B = 'https://hianime.ro';
    await getAny('hianime-robots.txt', `${B}/robots.txt`);
    const home = await getAny('hianime-home.html', `${B}/home/`);
    await getAny('hianime-search.html', `${B}/?s=one+piece`);
    const animeUrl = first(home.text, /href="(https:\/\/hianime\.ro\/anime\/[^"]+)"/i);
    const anime = animeUrl ? await getAny('hianime-anime.html', animeUrl) : { text: '' };
    const watchUrl = first(anime.text, /href="(https:\/\/hianime\.ro\/watch\/[^"]+)"/i) || first(home.text, /href="(https:\/\/hianime\.ro\/watch\/[^"]+)"/i);
    if (watchUrl) await getAny('hianime-watch.html', watchUrl);
    await getAny('hianime-wpjson.json', `${B}/wp-json/`, { max: 300_000 });
}

/* ---------------- ANIZONE ---------------- */
{
    const B = 'https://anizone.to';
    await getAny('anizone-robots.txt', `${B}/robots.txt`);
    await getAny('anizone-search.html', `${B}/anime?search=${encodeURIComponent('Tensei Shitara Ken Deshita')}`);
    await getAny('anizone-anime.html', `${B}/anime/a1vkn86p`);
    const ep = await getAny('anizone-episode.html', `${B}/anime/a1vkn86p/3`);
    const m3u8 = first(ep.text, /<media-player[^>]*\ssrc="([^"]+)"/i) || first(ep.text, /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    if (m3u8) {
        const master = await get('anizone-master.noref.m3u8', m3u8, { ua: 'browser' });
        await get('anizone-master.ref.m3u8', m3u8, { ua: 'browser', headers: { Referer: `${B}/`, Origin: B } });
        await get('anizone-master.foreign.m3u8', m3u8, { ua: 'browser', save: false, headers: { Referer: 'https://kazanime.vercel.app/', Origin: 'https://kazanime.vercel.app' } });
        await get('anizone-master.botua', m3u8, { ua: 'bot', save: false });
        const body = master.text || '';
        const variant = body.split(/\r?\n/).find((l) => l && !l.startsWith('#'));
        if (variant) {
            const vUrl = abs(variant.trim(), m3u8);
            const v = await get('anizone-variant.noref.m3u8', vUrl, { ua: 'browser' });
            await get('anizone-variant.foreign.m3u8', vUrl, { ua: 'browser', save: false, headers: { Referer: 'https://kazanime.vercel.app/', Origin: 'https://kazanime.vercel.app' } });
            const seg = (v.text || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
            if (seg) {
                const sUrl = abs(seg.trim(), vUrl);
                await get('anizone-segment.noref', sUrl, { ua: 'browser', save: false, headers: { Range: 'bytes=0-65535' } });
                await get('anizone-segment.foreign', sUrl, { ua: 'browser', save: false, headers: { Range: 'bytes=0-65535', Referer: 'https://kazanime.vercel.app/', Origin: 'https://kazanime.vercel.app' } });
                await get('anizone-segment.ref', sUrl, { ua: 'browser', save: false, headers: { Range: 'bytes=0-65535', Referer: `${B}/`, Origin: B } });
            }
            const audio = first(body, /TYPE=AUDIO[^\n]*URI="([^"]+)"/);
            if (audio) await get('anizone-audio.noref.m3u8', abs(audio, m3u8), { ua: 'browser' });
        }
    }
    const track = first(ep.text, /<track[^>]*\ssrc="([^"]+)"/i);
    if (track) {
        await get('anizone-subtitle.noref.txt', abs(track, B), { ua: 'browser', max: 20_000 });
        await get('anizone-subtitle.foreign', abs(track, B), { ua: 'browser', save: false, headers: { Origin: 'https://kazanime.vercel.app' } });
    }
}

/* ---------------- REANIME ---------------- */
{
    const B = 'https://reanime.to';
    await get('reanime-robots.txt', `${B}/robots.txt`, { ua: 'bot' });
    await get('reanime-flix.json', `${B}/api/flix/159042/1`, { ua: 'bot' });
    await get('reanime-flix-missing.json', `${B}/api/flix/1/99999`, { ua: 'bot' });
    await get('reanime-search.json', `${B}/api/v1/search?q=${encodeURIComponent('Reincarnated as a Sword')}&limit=5`, { ua: 'bot', max: 120_000 });
    await get('flixcloud-embed.html', 'https://flixcloud.cc/e/lmumbaiq7x0v?v=2', { ua: 'browser', max: 60_000 });
    await get('flixcloud-embed.foreignref', 'https://flixcloud.cc/e/lmumbaiq7x0v?v=2', { ua: 'browser', save: false, headers: { Referer: 'https://kazanime.vercel.app/' } });
}

/* ---------------- FONT REFERENSI ---------------- */
const fonts = {};
for (const [site, url] of [['reanime', 'https://reanime.to/home'], ['anizone', 'https://anizone.to/']]) {
    const page = await get(`${site}-design.html`, url, { ua: 'browser', max: 200_000 });
    const css = [...String(page.text).matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"/gi)].map((m) => abs(m[1], url)).slice(0, 6);
    const found = new Set();
    const faces = new Set();
    const inline = [...String(page.text).matchAll(/font-family:\s*([^;"}]+)/gi)].map((m) => m[1].trim());
    inline.forEach((f) => found.add(f));
    for (const [i, c] of css.entries()) {
        const r = await get(`${site}-css-${i}.css`, c, { ua: 'browser', save: false, max: 2_000_000 });
        for (const m of String(r.text).matchAll(/font-family:\s*([^;}]+)/gi)) found.add(m[1].trim().slice(0, 120));
        for (const m of String(r.text).matchAll(/@font-face\s*{[^}]*}/gi)) faces.add(m[0].replace(/src:[^;]+;/, 'src:…;').slice(0, 200));
    }
    const googleFonts = [...String(page.text).matchAll(/fonts\.(?:googleapis|bunny)\.net\/css2?\?family=([^"&]+)/gi)].map((m) => decodeURIComponent(m[1]));
    fonts[site] = { css, googleFonts, families: [...found].slice(0, 40), faces: [...faces].slice(0, 20) };
}

await writeFile(`${OUT}/fonts.json`, JSON.stringify(fonts, null, 2));
await writeFile(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log('done', summary.length);
