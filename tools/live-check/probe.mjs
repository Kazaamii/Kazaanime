/**
 * Probe sementara tahap 2 (runner GitHub Actions, BUKAN bagian aplikasi).
 */
import { writeFile, mkdir } from 'node:fs/promises';

const OUT = '.live-check';
const RAW = `${OUT}/raw2`;
const UA_BOT = 'KazanimeBot/1.0 (+https://github.com/Kazaamii/Kazaanime)';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const BROWSER = {
    'User-Agent': UA_BROWSER,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
};
const FOREIGN = 'https://kazanime.vercel.app';
const PICK = ['content-type', 'content-length', 'content-range', 'access-control-allow-origin', 'access-control-allow-credentials',
    'access-control-expose-headers', 'x-frame-options', 'content-security-policy', 'cross-origin-resource-policy', 'server',
    'cf-mitigated', 'cache-control', 'location', 'x-ratelimit-limit', 'timing-allow-origin'];

const summary = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(name, url, { ua = 'bot', headers = {}, save = true, max = 450_000, timeout = 25_000, method = 'GET', body } = {}) {
    const h = ua === 'bot' ? { 'User-Agent': UA_BOT, Accept: '*/*' } : ua === 'browser' ? { ...BROWSER } : {};
    Object.assign(h, headers);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const rec = { name, url, ua, sent: headers };
    try {
        const res = await fetch(url, { method, body, headers: h, redirect: 'follow', signal: ctrl.signal });
        const buf = Buffer.from(await res.arrayBuffer());
        rec.status = res.status;
        rec.finalUrl = res.url;
        rec.size = buf.length;
        rec.headers = Object.fromEntries(PICK.filter((k) => res.headers.get(k)).map((k) => [k, String(res.headers.get(k)).slice(0, 300)]));
        rec.head = buf.subarray(0, 120).toString('latin1').replace(/\s+/g, ' ');
        const ct = res.headers.get('content-type') || '';
        const text = /text|json|xml|mpegurl|vtt|javascript|css/i.test(ct) || /\.(m3u8|vtt|ass|srt)(\?|$)/i.test(url);
        if (/<title>[^<]*/i.test(rec.head + buf.subarray(0, 4000).toString('latin1'))) rec.title = (buf.subarray(0, 6000).toString('latin1').match(/<title>([^<]*)/i) || [])[1];
        if (save && text) {
            await writeFile(`${RAW}/${name}`, buf.subarray(0, max));
            rec.saved = `${RAW}/${name}`;
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
    console.log(`${String(rec.status).padStart(3)} ${ua.padEnd(7)} ${name}  ${rec.error || ''} ${rec.size ?? ''} ${rec.title || ''}`);
    return rec;
}

const first = (text, re) => (String(text || '').match(re) || [])[1] || '';
const abs = (u, base) => { try { return new URL(u.replace(/&amp;/g, '&'), base).href; } catch { return ''; } };
const firstUri = (m3u8) => (String(m3u8 || '').split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '').trim();

await mkdir(RAW, { recursive: true });

/* ---------------- ANIZONE: media + search ---------------- */
{
    const B = 'https://anizone.to';
    const ep = await get('anizone-episode2.html', `${B}/anime/a1vkn86p/3`, { ua: 'bot' });
    // vidstackPlayer(JSON.parse('...')) → atribut x-data ber-escape HTML + \u0022
    const raw = first(ep.text, /vidstackPlayer\(JSON\.parse\('([\s\S]*?)'\)\)/);
    let player = null;
    try {
        const unescaped = raw.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
        player = JSON.parse(JSON.parse(`"${unescaped.replace(/"/g, '\\"')}"`));
    } catch (e) { console.log('parse player gagal', String(e)); }
    await writeFile(`${OUT}/anizone-player.json`, JSON.stringify(player, null, 2));
    const src = player?.src || '';
    if (src) {
        const variants = {
            none: {},
            foreignOrigin: { Origin: FOREIGN },
            foreignBoth: { Referer: `${FOREIGN}/watch.html`, Origin: FOREIGN },
            anizone: { Referer: `${B}/`, Origin: B },
        };
        let master = '';
        for (const [k, h] of Object.entries(variants)) {
            const r = await get(`az-master.${k}.m3u8`, src, { ua: 'browser', headers: h, save: k === 'none' || k === 'anizone' });
            if (r.status === 200 && !master) master = r.text;
        }
        const vUri = firstUri(master);
        const audio = first(master, /TYPE=AUDIO[^\n]*URI="([^"]+)"/);
        if (vUri) {
            const vUrl = abs(vUri, src);
            let variant = '';
            for (const [k, h] of Object.entries(variants)) {
                const r = await get(`az-variant.${k}.m3u8`, vUrl, { ua: 'browser', headers: h, save: k === 'none' || k === 'anizone' });
                if (r.status === 200 && !variant) variant = r.text;
            }
            const sUri = firstUri(variant);
            const key = first(variant, /#EXT-X-KEY:[^\n]*URI="([^"]+)"/);
            if (key) await get('az-key', abs(key, vUrl), { ua: 'browser', save: false });
            if (sUri) {
                const sUrl = abs(sUri, vUrl);
                for (const [k, h] of Object.entries(variants)) {
                    await get(`az-segment.${k}`, sUrl, { ua: 'browser', save: false, headers: { ...h, Range: 'bytes=0-65535' } });
                }
            }
        }
        if (audio) await get('az-audio.none.m3u8', abs(audio, src), { ua: 'browser' });
        const subs = player?.subtitles || [];
        const idSub = subs.find((s) => s.language === 'id') || subs[0];
        if (idSub?.file) {
            await get('az-sub.none.ass', idSub.file, { ua: 'browser', max: 40_000 });
            await get('az-sub.foreignOrigin', idSub.file, { ua: 'browser', save: false, headers: { Origin: FOREIGN } });
        }
        const srt = subs.find((s) => s.format === 'srt');
        if (srt?.file) await get('az-sub.none.srt', srt.file, { ua: 'browser', max: 20_000 });
    }
    // pencarian: ulangi untuk melihat apakah challenge konsisten
    for (let i = 0; i < 2; i++) {
        await get(`anizone-search.bot.${i}`, `${B}/anime?search=sword`, { ua: 'bot', save: i === 0 });
        await sleep(3000);
        await get(`anizone-search.browser.${i}`, `${B}/anime?search=sword`, { ua: 'browser', save: false });
        await sleep(3000);
    }
    await get('anizone-list.html', `${B}/anime`, { ua: 'bot' });
    await get('anizone-sitemap.xml', `${B}/sitemap.xml`, { ua: 'bot' });
    await get('anizone-anime-other.html', `${B}/anime/siuvpqmq`, { ua: 'bot' });
}

/* ---------------- REANIME: konsistensi challenge ---------------- */
{
    const B = 'https://reanime.to';
    for (let i = 0; i < 3; i++) {
        await get(`reanime-flix-159042.bot.${i}`, `${B}/api/flix/159042/1`, { ua: 'bot', save: i === 0 });
        await sleep(2500);
        await get(`reanime-flix-21.bot.${i}`, `${B}/api/flix/21/1`, { ua: 'bot', save: i === 0 });
        await sleep(2500);
        await get(`reanime-flix-159042.browser.${i}`, `${B}/api/flix/159042/1`, { ua: 'browser', save: false, headers: { Accept: 'application/json' } });
        await sleep(2500);
    }
    await get('reanime-search2.json', `${B}/api/v1/search?q=${encodeURIComponent('one piece')}&limit=3`, { ua: 'bot' });
    await get('flixcloud-embed.bot', 'https://flixcloud.cc/e/lmumbaiq7x0v?v=2', { ua: 'bot', save: false });
}

/* ---------------- OTAKUDESU: halaman anime dari hasil pencarian ---------------- */
{
    const B = 'https://otakudesu.blog';
    const s = await get('otakudesu-search2.html', `${B}/?s=${encodeURIComponent('kusuriya')}&post_type=anime`, { ua: 'bot' });
    const animeUrl = first(s.text, /href="(https:\/\/otakudesu\.blog\/anime\/[^"]+)"/i);
    if (animeUrl) {
        const a1 = await get('otakudesu-anime.bot.html', animeUrl, { ua: 'bot' });
        const a2 = a1.status === 200 ? a1 : await get('otakudesu-anime.browser.html', animeUrl, { ua: 'browser' });
        const epUrl = first(a2.text, /href="(https:\/\/otakudesu\.blog\/episode\/[^"]+)"/i);
        if (epUrl) {
            const e1 = await get('otakudesu-episode.bot.html', epUrl, { ua: 'bot' });
            if (e1.status !== 200) await get('otakudesu-episode.browser.html', epUrl, { ua: 'browser' });
        }
    }
    await get('otakudesu-feed.xml', `${B}/feed/`, { ua: 'bot' });
    await get('otakudesu-wpjson.json', `${B}/wp-json/wp/v2/posts?per_page=2`, { ua: 'bot', max: 60_000 });
}

/* ---------------- ANICHIN: episode + gambar + beranda lagi ---------------- */
{
    const B = 'https://anichin.moe';
    await get('anichin-episode.html', `${B}/renegade-immortal-episode-163-subtitle-indonesia/`, { ua: 'bot' });
    const list = await get('anichin-list2.html', `${B}/anime/?status=&type=&order=update`, { ua: 'bot', save: false });
    const img = first(list.text, /(https:\/\/anichin\.moe\/wp-content\/uploads\/[^"' )]+\.(?:webp|jpg|jpeg|png))/i);
    if (img) {
        await get('anichin-image.none', img, { ua: 'browser', save: false });
        await get('anichin-image.foreign', img, { ua: 'browser', save: false, headers: { Referer: `${FOREIGN}/` } });
    }
    await sleep(2000);
    await get('anichin-home.again', `${B}/`, { ua: 'bot', save: false });
    await get('anichin-page2', `${B}/page/2/`, { ua: 'bot', save: false });
    await get('anichin-ongoing.html', `${B}/ongoing/`, { ua: 'bot', save: false });
}

/* ---------------- HIANIME.RO: AJAX server (bila ada) ---------------- */
{
    const B = 'https://hianime.ro';
    await get('hianime-otakuthemes.json', `${B}/wp-json/v1/otakuthemes`, { ua: 'bot', max: 100_000 });
}

await writeFile(`${OUT}/summary2.json`, JSON.stringify(summary, null, 2));
console.log('done', summary.length);
