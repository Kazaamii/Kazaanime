/**
 * Probe sementara tahap 3 (runner GitHub Actions, BUKAN bagian aplikasi).
 */
import { writeFile, mkdir } from 'node:fs/promises';

const OUT = '.live-check';
const RAW = `${OUT}/raw3`;
const UA_BOT = 'KazanimeBot/1.0 (+https://github.com/Kazaamii/Kazaanime)';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FOREIGN = 'https://kazanime.vercel.app';
const PICK = ['content-type', 'content-length', 'content-range', 'access-control-allow-origin', 'access-control-allow-credentials',
    'access-control-allow-headers', 'access-control-expose-headers', 'cross-origin-resource-policy', 'server', 'cf-mitigated',
    'cache-control', 'location', 'accept-ranges', 'vary'];
const summary = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(name, url, { ua = 'bot', headers = {}, save = true, max = 450_000, timeout = 25_000, method = 'GET' } = {}) {
    const h = ua === 'bot' ? { 'User-Agent': UA_BOT, Accept: '*/*' } : { 'User-Agent': UA_BROWSER, Accept: '*/*' };
    Object.assign(h, headers);
    const rec = { name, url, ua, sent: headers };
    try {
        const res = await fetch(url, { method, headers: h, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
        const buf = Buffer.from(await res.arrayBuffer());
        rec.status = res.status;
        rec.size = buf.length;
        rec.headers = Object.fromEntries(PICK.filter((k) => res.headers.get(k)).map((k) => [k, String(res.headers.get(k)).slice(0, 300)]));
        rec.head = buf.subarray(0, 100).toString('latin1').replace(/\s+/g, ' ');
        rec.title = (buf.subarray(0, 6000).toString('latin1').match(/<title>([^<]*)/i) || [])[1];
        const ct = res.headers.get('content-type') || '';
        const text = /text|json|xml|mpegurl|vtt|javascript|css/i.test(ct) || /\.(m3u8|vtt|ass|srt)(\?|$)/i.test(url);
        if (save && text && res.status === 200) {
            await writeFile(`${RAW}/${name}`, buf.subarray(0, max));
            rec.saved = `${RAW}/${name}`;
        }
        rec.text = text ? buf.toString('utf8') : '';
    } catch (e) {
        rec.status = 0;
        rec.error = String(e?.cause?.code || e?.name || e?.message || e);
        rec.text = '';
    }
    const { text, ...log } = rec;
    summary.push(log);
    console.log(`${String(rec.status).padStart(3)} ${ua.padEnd(7)} ${name}  ${rec.error || ''} ${rec.size ?? ''} ${rec.title || ''}`);
    return rec;
}

/** Ulangi (UA bot) sampai bukan challenge, maks n kali. */
async function retry(name, url, n = 5, opts = {}) {
    let r;
    for (let i = 0; i < n; i++) {
        r = await get(i ? `${name}.try${i}` : name, url, { ...opts, save: true });
        if (r.status === 200) return r;
        await sleep(2500 + i * 1500);
    }
    return r;
}

const first = (text, re) => (String(text || '').match(re) || [])[1] || '';
const abs = (u, base) => { try { return new URL(u, base).href; } catch { return ''; } };
const firstUri = (m3u8) => (String(m3u8 || '').split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '').trim();
function jsJson(literal) {
    const unescaped = literal.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
    return JSON.parse(JSON.parse(`"${unescaped.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`));
}

await mkdir(RAW, { recursive: true });

/* ---------------- ANIZONE: CDN media ---------------- */
{
    const B = 'https://anizone.to';
    const ep = await retry('anizone-episode.html', `${B}/anime/a1vkn86p/3`);
    let player = null;
    try { player = jsJson(first(ep.text, /vidstackPlayer\(JSON\.parse\('([\s\S]*?)'\)\)/)); } catch (e) { console.log('parse gagal', String(e)); }
    await writeFile(`${OUT}/anizone-player.json`, JSON.stringify(player, null, 2));
    const src = player?.src || '';
    const V = {
        none: {},
        foreignOrigin: { Origin: FOREIGN },
        foreignBoth: { Referer: `${FOREIGN}/watch.html`, Origin: FOREIGN },
        anizone: { Referer: `${B}/`, Origin: B },
    };
    if (src) {
        let master = '';
        for (const [k, h] of Object.entries(V)) {
            const r = await get(`az-master.${k}.m3u8`, src, { ua: 'browser', headers: h, save: k === 'none' || k === 'anizone' });
            if (r.status === 200 && !master) master = r.text;
            await sleep(400);
        }
        // preflight CORS (hls.js tidak mengirim header khusus → biasanya tanpa preflight, tetap dicek)
        await get('az-master.preflight', src, { ua: 'browser', method: 'OPTIONS', save: false, headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'GET' } });
        const vUri = firstUri(master);
        const audio = first(master, /TYPE=AUDIO[^\n]*URI="([^"]+)"/);
        if (vUri) {
            const vUrl = abs(vUri, src);
            let variant = '';
            for (const [k, h] of Object.entries(V)) {
                const r = await get(`az-variant.${k}.m3u8`, vUrl, { ua: 'browser', headers: h, save: k === 'none' });
                if (r.status === 200 && !variant) variant = r.text;
                await sleep(300);
            }
            const sUri = firstUri(variant);
            if (sUri) {
                const sUrl = abs(sUri, vUrl);
                for (const [k, h] of Object.entries(V)) {
                    await get(`az-segment.${k}`, sUrl, { ua: 'browser', save: false, headers: { ...h, Range: 'bytes=0-65535' } });
                    await sleep(300);
                }
            }
        }
        if (audio) await get('az-audio.none.m3u8', abs(audio, src), { ua: 'browser' });
        const subs = player?.subtitles || [];
        const idSub = subs.find((s) => s.language === 'id') || subs[0];
        if (idSub?.file) {
            await get('az-sub.none.ass', idSub.file, { ua: 'browser', max: 60_000 });
            await get('az-sub.foreignOrigin', idSub.file, { ua: 'browser', save: false, headers: { Origin: FOREIGN } });
        }
        const srt = subs.find((s) => s.format === 'srt');
        if (srt?.file) await get('az-sub.none.srt', srt.file, { ua: 'browser', max: 20_000 });
        if (player?.chapter) await get('az-chapters.vtt', player.chapter, { ua: 'browser', max: 20_000 });
    }
    await retry('anizone-search-tensei.html', `${B}/anime?search=${encodeURIComponent('Tensei Shitara Ken Deshita')}`, 3);
}

/* ---------------- HIANIME.RO: REST ---------------- */
{
    const R = 'https://hianime.ro/wp-json/v1/otakuthemes';
    await get('hianime-eplist.json', `${R}/episode/list/215883`, { ua: 'bot' });
    await get('hianime-servers.json', `${R}/episode/servers?episodeId=215886`, { ua: 'bot' });
    await get('hianime-suggest-keyword.json', `${R}/search/suggestions?keyword=${encodeURIComponent('one piece')}`, { ua: 'bot' });
    await get('hianime-suggest-q.json', `${R}/search/suggestions?q=${encodeURIComponent('one piece')}`, { ua: 'bot' });
    await get('hianime-schedule-day.json', `${R}/schedule/day`, { ua: 'bot' });
    await get('hianime-watch.min.js', 'https://hianime.ro/wp-content/themes/hianime/assets/js/watch.min.js?ver=1.0.3', { ua: 'bot', max: 300_000 });
    await get('hianime-main.js', 'https://hianime.ro/wp-content/themes/hianime/assets/js/main.js?ver=1.0.3', { ua: 'bot', max: 300_000 });
    await get('hianime-latest.html', 'https://hianime.ro/recently-updated/', { ua: 'bot', max: 300_000 });
}

/* ---------------- ANICHIN: episode + gambar ---------------- */
{
    const B = 'https://anichin.moe';
    await retry('anichin-episode.html', `${B}/renegade-immortal-episode-163-subtitle-indonesia/`, 5);
    const img = 'https://anichin.moe/wp-content/uploads/2023/09/RENEGADE-IMMORTAL-SUBTITLE-INDONESIA-3.webp';
    await get('anichin-image.none', img, { ua: 'browser', save: false });
    await get('anichin-image.foreign', img, { ua: 'browser', save: false, headers: { Referer: `${FOREIGN}/` } });
}

await writeFile(`${OUT}/summary3.json`, JSON.stringify(summary, null, 2));
console.log('done', summary.length);
