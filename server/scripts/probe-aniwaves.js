#!/usr/bin/env node
/**
 * Kazanime — scripts/probe-aniwaves.js
 *
 * Utilitas pemeriksaan (bukan bagian dari runtime) untuk memastikan **aniwaves.ru** bisa
 * dijadikan sumber: mengambil halaman dengan UA bot yang jujur, lalu mencetak ringkasan
 * struktur yang dibutuhkan adapter (tautan /watch, iframe server, m3u8, JSON state).
 *
 * Aturan yang dipegang (sama seperti scraper):
 *  - UA deskriptif `KazanimeBot/1.0`, tanpa header peramban palsu, tanpa cookie/proxy.
 *  - Tidak mengulang 403/429/challenge; robots.txt dibaca lebih dulu.
 *  - Hanya path yang diizinkan robots (`/home`, `/watch/...`); `/api`, `/ajax`, `/filter`,
 *    `/random` tidak disentuh.
 *  - Badan respons tidak dicetak utuh — hanya potongan yang cocok dengan pola yang dicari.
 *
 * Jalankan: node server/scripts/probe-aniwaves.js [url-episode]
 */
const USER_AGENT = 'KazanimeBot/1.0 (+https://github.com/Kazaamii/Kazaanime)';
const HOME = 'https://aniwaves.ru/home';
const SAMPLE_EP = 'https://aniwaves.ru/watch/cyberpunk-edgerunners-2-82821/ep-1';
const TIMEOUT_MS = 20000;
const MAX_BYTES = 3 * 1024 * 1024;

/** Potongan di sekitar setiap kecocokan (maks `max` kecocokan). */
function snippets(text, pattern, { max = 3, pad = 140 } = {}) {
    const out = [];
    const re = new RegExp(pattern, 'gi');
    let m;
    while ((m = re.exec(text)) && out.length < max) {
        const start = Math.max(0, m.index - pad);
        out.push(text.slice(start, Math.min(text.length, m.index + m[0].length + pad)).replace(/\s+/g, ' '));
    }
    return out;
}

async function get(url) {
    const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_BYTES);
    return { status: res.status, type: res.headers.get('content-type') || '', text: buf.toString('utf8') };
}

async function main() {
    const epUrl = process.argv[2] || SAMPLE_EP;
    const robots = await get('https://aniwaves.ru/robots.txt').catch((err) => ({ status: 0, text: String(err) }));
    console.log('ROBOTS', robots.status, robots.text.replace(/\s+/g, ' ').slice(0, 300));

    const home = await get(HOME);
    console.log('HOME', home.status, home.type, 'len', home.text.length);
    const watchLinks = [...home.text.matchAll(/href="([^"]*\/watch\/[^"]+)"/g)].map((m) => m[1]).slice(0, 12);
    console.log('HOME_WATCH_LINKS', JSON.stringify([...new Set(watchLinks)].slice(0, 8)));

    const ep = await get(epUrl);
    console.log('EP', ep.status, ep.type, 'len', ep.text.length);
    for (const [name, pattern] of [
        ['IFRAME', '<iframe[^>]{0,400}'],
        ['M3U8', 'https?:[^"\'\\s]{0,200}\\.m3u8[^"\'\\s]{0,80}'],
        ['SERVER_KEYS', '"(?:servers?|links?|sources?|embed|player)"\\s*:'],
        ['VIDPLAY', 'vidplay|vidcloud|megacloud|mycloud|datsav|byfms|dghg|mul-?aud'],
        ['WINDOW_VAR', 'window\\.[A-Za-z_$]{2,40}\\s*='],
    ]) {
        const found = snippets(ep.text, pattern, { max: 4 });
        console.log(`${name}_COUNT`, (ep.text.match(new RegExp(pattern, 'gi')) || []).length);
        found.forEach((s, i) => console.log(`  ${name}[${i}]`, s.slice(0, 420)));
    }
    // Kerangka HTML di sekitar nama server (untuk menemukan atribut data-*).
    const idx = ep.text.search(/Vidplay|MuL-AuD|DatSaV/i);
    if (idx > -1) console.log('AROUND_SERVER_NAME', ep.text.slice(Math.max(0, idx - 600), idx + 900).replace(/\s+/g, ' ').slice(0, 1500));
}

main().catch((err) => {
    console.error('PROBE_ERROR', err?.name || '', err?.message || err);
    process.exitCode = 1;
});
