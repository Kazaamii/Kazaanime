/**
 * Kazanime — round11-adblock.test.js
 * Putaran 11 (24 Okt 2026).
 *
 * Permintaan pengguna (dengan tangkapan layar player berganti menjadi JSON
 * `{"success":false,"reject_reason":"iclick link error"}`):
 *   "iklan masih saja muncul dan memaksa new tab tolong gunakan dns seperti ini
 *    atau terapkan di web saya agar tidak ada iklan muncul ++https://dns.adguard.com/dns-query++"
 *
 * Yang dijaga tes ini:
 *  1. URL iklan / gateway klik (`…/iclick?…`, popunder, dll) TIDAK PERNAH dipasang di pemutar —
 *     baik dari backend (makeEpisode, /api/stream/servers) maupun di klien (player, watch).
 *  2. AdGuard DNS DoH benar-benar dipakai server untuk memeriksa reputasi host, fail-open
 *     (DoH mati → `null`, situs tetap jalan), dengan cache + cooldown.
 *  3. Mode Aman = **opt-in** (default mati): sandbox TANPA allow-popups/allow-top-navigation,
 *     sehingga iklan tidak bisa membuka tab baru; pemutar tanpa Mode Aman tetap seperti
 *     putaran 8 (tanpa atribut sandbox) supaya embed tidak menolak diputar.
 *  4. Iklan yang memindahkan pemutar memunculkan bilah pemulihan (bukan layar JSON mati)
 *     dan server itu dilewati setelah beberapa kali.
 *  5. Panduan AdGuard DNS tersedia di UI + jujur bahwa halaman web tidak bisa mengubah DNS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createApp } from '../app.js';
import { ADS } from '../config.js';
import {
    AD_HOSTS,
    AD_URL_PATTERNS,
    adHostMatch,
    adFilterSummary,
    filterAdServers,
    inspectAdUrl,
    isAdUrl,
} from '../lib/adblock.js';
import { createDnsFilter } from '../lib/dns.js';
import { readHosts } from '../routes/ads.js';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const playerJs = read('js/ui/player.js');
const watchJs = read('js/watch.js');
const watchHtml = read('watch.html');
const watchCss = read('css/watch.css');
const componentsCss = read('css/components.css');
const adGuideJs = read('js/ui/ad-guide.js');
const clientAdblock = read('js/services/adblock.js');
const configJs = read('js/config.js');
const sourcesJs = read('js/api/sources.js');

/* ------------------------------------------------------------------ */
/* 1 · Aturan URL iklan                                                */
/* ------------------------------------------------------------------ */
test('adblock: URL gateway klik yang dulu membajak pemutar dianggap iklan', () => {
    // Tangkapan layar pengguna: halaman JSON "iclick link error" di dalam player.
    for (const url of [
        'https://animeku.lol/iclick?aff_id=1132',
        'https://oploverz.ch/iclick?u=abc',
        'https://xyz.example/adclick/1234',
        'https://xyz.example/popunder.js',
        'https://xyz.example/ad/redirect?to=spam',
        'https://xyz.example/advert/click?x=1',
        'https://xyz.example/?aff_id=99',
    ]) {
        const verdict = inspectAdUrl(url);
        assert.equal(verdict.blocked, true, `harus diblokir: ${url}`);
        assert.ok(verdict.reason, 'alasan blokir tersedia');
        assert.equal(isAdUrl(url), true);
    }
});

test('adblock: embed sah tidak ikut diblokir', () => {
    for (const url of [
        'https://animeku.lol/nonton/one-piece-episode-1/',
        'https://oploverz.ch/one-piece-episode-1/',
        'https://flixcloud.cc/e/abc?v=2',
        'https://suzaku.xin-cdn.xyz/77/master.m3u8',
        'https://example.com/embed.php?id=5&affiliate=no',
    ]) {
        assert.equal(inspectAdUrl(url).blocked, false, `tidak boleh diblokir: ${url}`);
    }
    assert.equal(inspectAdUrl('bukan url').blocked, false);
    assert.equal(inspectAdUrl('').blocked, false);
    assert.equal(inspectAdUrl(null).blocked, false);
});

test('adblock: daftar host memakai pencocokan subdomain, bukan sekadar teks', () => {
    assert.ok(AD_HOSTS.length >= 40, 'daftar host cukup lengkap');
    assert.ok(AD_URL_PATTERNS.length >= 5);
    assert.equal(adHostMatch('popads.net'), 'popads.net');
    assert.equal(adHostMatch('cdn.popads.net'), 'popads.net');
    assert.equal(adHostMatch('notpopads.net.evil.example'), null, 'domain tempelan tidak cocok');
    assert.equal(adHostMatch('animeku.lol'), null);
    assert.equal(adHostMatch(''), null);
});

test('adblock: filterAdServers membuang server iklan & mempertahankan HLS/native', () => {
    const list = [
        { id: 'a', name: 'AnimeKu', url: 'https://animeku.lol/iclick?aff_id=1', kind: 'embed' },
        { id: 'b', name: 'Oploverz', url: 'https://oploverz.ch/one-piece-episode-1/', kind: 'embed' },
        { id: 'c', name: 'HLS', url: 'https://popads.net/x.m3u8', kind: 'hls', direct: 'https://popads.net/x.m3u8' },
        { id: 'd', name: 'Video', url: 'https://cdn.example/v.mp4', kind: 'video' },
    ];
    const result = filterAdServers(list);
    assert.deepEqual(result.servers.map((s) => s.id), ['b', 'c', 'd']);
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].name, 'AnimeKu');
    assert.equal(adFilterSummary().hosts, AD_HOSTS.length);
    assert.equal(adFilterSummary().patterns, AD_URL_PATTERNS.length);
});

/* ------------------------------------------------------------------ */
/* 2 · AdGuard DNS DoH (fail-open)                                     */
/* ------------------------------------------------------------------ */
const dohResponse = (body, status = 200) => ({ ok: status === 200, status, async json() { return body; } });
const dohBlocked = () => dohResponse({ Status: 0, Answer: [{ type: 1, data: '0.0.0.0' }] });
const dohNx = () => dohResponse({ Status: 3, Answer: [] });
const dohOk = () => dohResponse({ Status: 0, Answer: [{ type: 1, data: '104.21.32.1' }] });

test('dns: endpoint default AdGuard DoH yang diminta pengguna', () => {
    assert.equal(ADS.dohEndpoint, 'https://dns.adguard.com/dns-query');
    assert.equal(ADS.dnsCheck, true);
    const dns = createDnsFilter({ fetchImpl: async () => dohOk() });
    assert.equal(dns.endpoint, 'https://dns.adguard.com/dns-query');
});

test('dns: jawaban 0.0.0.0 / NXDOMAIN = diblokir, A record normal = tidak', async () => {
    /** @type {string[]} */
    const calls = [];
    const dns = createDnsFilter({
        fetchImpl: async (url, opts) => {
            calls.push(url);
            assert.equal(opts.headers.accept, 'application/dns-json');
            return url.includes('popads') ? dohBlocked() : url.includes('mati') ? dohNx() : dohOk();
        },
    });
    assert.equal(await dns.isBlocked('popads.net'), true);
    assert.equal(await dns.isBlocked('mati.example'), true);
    assert.equal(await dns.isBlocked('animeku.lol'), false);
    assert.ok(calls[0].startsWith('https://dns.adguard.com/dns-query?name='));
    assert.ok(calls[0].includes('&type=A'));
});

test('dns: cache 6 jam (tidak menembak DoH berulang) dan checkMany maksimal 20 host', async () => {
    let n = 0;
    const dns = createDnsFilter({ fetchImpl: async () => { n++; return dohOk(); } });
    await dns.isBlocked('a.example');
    await dns.isBlocked('a.example');
    assert.equal(n, 1, 'hasil di-cache');
    const many = await dns.checkMany(Array.from({ length: 25 }, (_, i) => `h${i}.example`));
    assert.equal(Object.keys(many).length, 20, 'dibatasi 20 host');
    assert.equal(dns.status().requests, 21);
});

test('dns: FAIL-OPEN — DoH error/timeout → null, lalu cooldown 10 menit', async () => {
    let n = 0;
    const dns = createDnsFilter({ fetchImpl: async () => { n++; throw new Error('offline'); } });
    assert.equal(await dns.isBlocked('popads.net'), null);
    assert.equal(await dns.isBlocked('lain.example'), null, 'cooldown → tidak mencoba lagi');
    assert.equal(n, 1);
    const status = dns.status();
    assert.equal(status.failures, 1);
    assert.equal(status.coolingDown, true);
});

test('dns: ADS_DNS_CHECK=0 mematikan pemeriksaan tanpa error', async () => {
    let n = 0;
    const dns = createDnsFilter({ enabled: false, fetchImpl: async () => { n++; return dohOk(); } });
    assert.equal(await dns.isBlocked('popads.net'), null);
    assert.equal(dns.enabled, false);
    assert.equal(n, 0);
});

/* ------------------------------------------------------------------ */
/* 3 · Endpoint /api/ads/*                                             */
/* ------------------------------------------------------------------ */
async function withAdsApp(opts, fn) {
    const app = createApp({ log: false, rateLimitPerMinute: 0, budgetMs: 5000, ...opts });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await fn(base);
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
}

test('GET /api/ads/blocklist: versi, host, pola, endpoint DoH, cache lama', async () => {
    await withAdsApp({}, async (base) => {
        const res = await fetch(`${base}/api/ads/blocklist`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('cache-control'), /s-maxage=86400/);
        const json = await res.json();
        assert.equal(json.ok, true);
        assert.equal(json.data.version, 1);
        assert.deepEqual(json.data.hosts, [...AD_HOSTS]);
        assert.equal(json.data.patterns.length, AD_URL_PATTERNS.length);
        assert.equal(typeof json.data.patterns[0], 'string');
        assert.equal(json.data.dohEndpoint, 'https://dns.adguard.com/dns-query');
    });
});

test('GET /api/ads/check: hasil per host, validasi 400, maks 20 host', async () => {
    const dns = createDnsFilter({ fetchImpl: async (url) => (url.includes('mati') ? dohNx() : dohOk()) });
    await withAdsApp({ adDns: dns }, async (base) => {
        const res = await fetch(`${base}/api/ads/check?host=PopAds.net,animeku.lol,mati.example`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('cache-control'), /no-store/);
        const json = await res.json();
        assert.equal(json.data.hosts['popads.net'].blocked, true);
        assert.equal(json.data.hosts['popads.net'].source, 'rule', 'daftar host lokal lebih murah daripada DoH');
        assert.equal(json.data.hosts['animeku.lol'].blocked, false);
        assert.equal(json.data.hosts['animeku.lol'].source, 'adguard-dns');
        assert.equal(json.data.hosts['mati.example'].blocked, true);
        assert.equal(json.data.hosts['mati.example'].source, 'adguard-dns');

        assert.equal((await fetch(`${base}/api/ads/check`)).status, 400, 'host wajib');
        assert.equal((await fetch(`${base}/api/ads/check?host=https%3A%2F%2Fpopads.net`)).status, 400);
        const many = Array.from({ length: 21 }, (_, i) => `h${i}.example`).join(',');
        assert.equal((await fetch(`${base}/api/ads/check?host=${many}`)).status, 400);
    });
});

test('GET /api/ads/status & /api/health: ringkasan penyaring tersedia', async () => {
    main: {
        const dns = createDnsFilter({ fetchImpl: async () => dohBlocked() });
        await withAdsApp({ adDns: dns }, async (base) => {
            const res = await fetch(`${base}/api/ads/status?host=videohost.example`);
            const json = await res.json();
            assert.equal(json.ok, true);
            assert.equal(json.data.enabled, true);
            assert.equal(json.data.hosts, AD_HOSTS.length, 'ringkasan tetap berupa jumlah host');
            assert.equal(json.data.patterns, AD_URL_PATTERNS.length);
            assert.equal(json.data.checked['videohost.example'].blocked, true);
            assert.equal(json.data.dns.endpoint, 'https://dns.adguard.com/dns-query');
            assert.equal(json.data.dns.coolingDown, false);

            const health = await (await fetch(`${base}/api/health`)).json();
            assert.equal(health.data.adFilter.enabled, true);
            assert.equal(health.data.adFilter.hosts, AD_HOSTS.length);
        });
    }
});

test('readHosts: normalisasi huruf besar & tolak skema/path', () => {
    assert.deepEqual(readHosts('A.Example, a.example ,b.example'), ['a.example', 'b.example']);
    assert.deepEqual(readHosts(['x.example']), ['x.example']);
    assert.throws(() => readHosts(''));
    assert.throws(() => readHosts('https://x.example/a'));
    assert.throws(() => readHosts('.example.com'));
});

/* ------------------------------------------------------------------ */
/* 4 · Backend tidak pernah mengirim URL iklan                         */
/* ------------------------------------------------------------------ */
test('/api/stream/servers: server ber-URL iklan dibuang + dilaporkan', async () => {
    const streams = {
        seen: [],
        async servers(q) {
            this.seen.push(q);
            return {
                servers: [
                    { provider: 'anizone', kind: 'embed', name: 'Iklan', url: 'https://animeku.lol/iclick?aff_id=1', lang: 'id' },
                    { provider: 'reanime', kind: 'embed', name: 'ReAnime HD-2', url: 'https://flixcloud.cc/e/a?v=2', lang: 'en' },
                ],
                status: { reanime: 'ok', anizone: 'ok' },
                errors: [],
            };
        },
        health: () => [],
    };
    const media = { async stream() { return { status: 404, headers: new Headers(), body: null, url: '' }; } };
    const app = createApp({ registry: { async latest() { return { source: 'x', data: [], fallback: false, stale: false, errors: [] }; }, health: () => ({ sources: [], metadata: {}, cache: {} }) }, streams, mediaClient: media, log: false, rateLimitPerMinute: 0, proxyRateLimitPerMinute: 0, budgetMs: 5000 });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const json = await (await fetch(`${base}/api/stream/servers?ep=1&anilist=21&title=One%20Piece`)).json();
        assert.equal(json.data.servers.length, 1);
        assert.equal(json.data.servers[0].name, 'ReAnime HD-2');
        assert.equal(json.data.blockedByAdFilter, 1);
        assert.ok(!JSON.stringify(json.data.servers).includes('iclick'));
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
});

/* ------------------------------------------------------------------ */
/* 5 · Klien: pemutar, Mode Aman, pemulihan, Watch                     */
/* ------------------------------------------------------------------ */
test('config: Mode Aman opt-in (default mati) dengan kebijakan tanpa pop-up', () => {
    assert.match(configJs, /safeFrame: Object\.freeze\(\{/);
    assert.match(configJs, /defaultOn:\s*false/);
    assert.match(configJs, /policy:\s*'[^']*allow-scripts[^']*allow-same-origin[^']*'/);
    const policy = configJs.match(/policy:\s*'([^']+)'/)[1];
    assert.doesNotMatch(policy, /allow-popups/, 'iklan tidak boleh membuka tab baru');
    assert.doesNotMatch(policy, /allow-top-navigation/, 'iklan tidak boleh membajak tab Kazanime');
    assert.match(configJs, /maxTakeovers:\s*2/);
    assert.match(configJs, /adCheckCache:\s*'kz:adcheck'/);
});

test('player: Mode Aman tidak pernah dipaksa & tetap kompatibel putaran 8', () => {
    // Tes putaran 8 tetap berlaku: default tanpa sandbox.
    assert.doesNotMatch(playerJs, /setAttribute\('sandbox'/);
    assert.doesNotMatch(playerJs, /PLAYER\.sandbox/);
    assert.match(playerJs, /iframe\.dataset\.popupGuard = 'off';/);
    // Putaran 11: hanya dipasang lewat setSafeFrame (opt-in), dibaca dari penyimpanan.
    assert.match(playerJs, /export function isSafeFrameOn\(\)/);
    assert.match(playerJs, /export function saveSafeFrame\(on\)/);
    assert.match(playerJs, /iframe\.sandbox\.value = PLAYER\.safeFrame\.policy;/);
    assert.match(playerJs, /setSafeFrame: \(on\) => applySafeFrame\(on\),/);
    assert.match(playerJs, /iframe\.dataset\.safeFrame = safeFrame \? 'on' : 'off';/);
    assert.match(configJs, /safeFrame: 'kz:safe-frame'/);
});

test('player: deteksi iklan yang memindahkan pemutar + bilah pemulihan', () => {
    assert.match(playerJs, /function noteFrameReload\(my\)/);
    assert.match(playerJs, /PLAYER\.adTakeover\?\.ignoreWithinMs/);
    assert.match(playerJs, /function mountAdRecovery\(my\)/);
    assert.match(playerJs, /playerAdRecovery/);
    assert.match(playerJs, /emit\('adblock', \{ type: 'takeover'/);
    assert.match(playerJs, /emit\('adblock', \{ type: 'skipped'/);
    assert.match(playerJs, /Pulihkan pemutar/);
    assert.match(playerJs, /Server lain/);
    assert.match(playerJs, /failed\.add\(active\.id\)/);
    // Bilah pemulihan bukan layar penuh yang menutupi player (pelajaran putaran 3).
    assert.doesNotMatch(watchCss, /\.player-ad-recovery\{[^}]*inset:\s*0/);
    assert.doesNotMatch(watchCss, /\.player-ad-recovery\{[^}]*position:\s*fixed/);
});

test('player: Mode Aman bisa dinyalakan dari bilah pemulihan & gagal-timeout melepasnya otomatis', () => {
    // Bug yang ditemukan saat smoke: `setSafeFrame` hanya ada di objek API, bukan fungsi lokal,
    // sehingga pemanggilan dari dalam createPlayer (bilah pemulihan & fail) melempar ReferenceError.
    assert.match(playerJs, /function applySafeFrame\(on\) \{/, 'logika sandbox tersedia sebagai fungsi lokal');
    assert.match(playerJs, /setSafeFrame: \(on\) => applySafeFrame\(on\),/, 'API meneruskan ke fungsi lokal');
    assert.match(playerJs, /const on = applySafeFrame\(true\);/, 'tombol "Aktifkan Mode Aman" di bilah pemulihan');
    assert.match(playerJs, /data-ad-action="safe"/);
    assert.match(playerJs, /Aktifkan Mode Aman/);
    // Timeout + Mode Aman → sandbox dilepas dulu, server yang sama diulang (playback prioritas).
    const timeoutBlock = playerJs.slice(playerJs.indexOf("if (reason === 'timeout' && safeFrame)"));
    assert.match(timeoutBlock.slice(0, 700), /applySafeFrame\(false\);/);
    assert.match(timeoutBlock.slice(0, 700), /play\(server\);/, 'server yang sama dicoba ulang, tidak dilewati');
    assert.doesNotMatch(timeoutBlock.slice(0, 700), /failed\.add\(server\.id\)/);
});

test('player: URL iklan dibuang sebelum iframe dipasang (keepPlayable)', () => {
    assert.match(playerJs, /import \{ filterAdServers \} from '\.\.\/services\/adblock\.js';/);
    assert.match(playerJs, /const keepPlayable = \(list\) =>/);
    assert.match(playerJs, /servers = keepPlayable\(list\);/);
    assert.equal((playerJs.match(/servers = keepPlayable\(list\);/g) || []).length, 2, 'load() dan setServers()');
});

test('klien adblock: cermin daftar server + cek host + cache 24 jam', () => {
    assert.match(clientAdblock, /export function inspectAdUrl/);
    assert.match(clientAdblock, /export function filterAdServers/);
    assert.match(clientAdblock, /export async function checkHosts/);
    assert.match(clientAdblock, /\/api\/ads\/check\?host=/);
    assert.match(clientAdblock, /STORAGE_KEYS\.adCheckCache/);
    assert.match(clientAdblock, /catch \{\s*\n\s*\/\/ backend mati/, 'fail-open tanpa melempar');
});

test('sources.js: muatan cache lama pun disaring dari URL iklan', () => {
    assert.match(sourcesJs, /import \{ inspectAdUrl \} from '\.\.\/services\/adblock\.js';/);
    assert.match(sourcesJs, /filter\(\(server\) => server && !inspectAdUrl\(server\.url\)\.blocked\)/);
});

test('watch: tombol Mode Aman, panduan iklan, dan penyaringan server', () => {
    assert.match(watchHtml, /id="btnSafeMode"/);
    assert.match(watchHtml, /id="btnSafeMode" aria-pressed="false"/);
    assert.match(watchHtml, /id="btnAdGuide"/);
    // Urutan tetap: Server → Episode (putaran 9) dengan tombol baru di baris kontrol yang sama.
    const controls = watchHtml.slice(watchHtml.indexOf('player-controls'), watchHtml.indexOf('server-hint'));
    assert.ok(controls.indexOf('btnNextServer') < controls.indexOf('btnSafeMode'), 'Mode Aman setelah Server Lain');
    assert.ok(controls.indexOf('btnSafeMode') < controls.indexOf('btnExternalPlayer'));

    assert.match(watchJs, /import \{ createPlayer, isSafeFrameOn \} from '\.\/ui\/player\.js';/);
    assert.match(watchJs, /import \{ openAdGuide \} from '\.\/ui\/ad-guide\.js';/);
    assert.match(watchJs, /import \{ filterAdServers, checkHosts \} from '\.\/services\/adblock\.js';/);
    assert.match(watchJs, /player\.setSafeFrame\(!player\.isSafeFrame\(\)\)/);
    assert.match(watchJs, /const safe = guardAdServers\(list\);/, 'semua daftar server lewat saringan');
    assert.match(watchJs, /player\.on\('adblock'/);
    assert.match(watchJs, /player\.on\('adguide', \(\) => openAdGuide\(\)\)/);
    assert.match(watchJs, /els\.adGuideBtn\?\.addEventListener\('click', \(\) => openAdGuide\(\)\)/);
    // Server bertanda hanya diberi peringatan; tidak diblokir otomatis.
    assert.match(watchJs, /adRisk: true/);
    assert.doesNotMatch(watchJs, /filter\(\(server\) => !adRiskHosts/);
});

test('css: bilah pemulihan, titik status Mode Aman, tanda server berisiko', () => {
    assert.match(watchCss, /\.player-ad-recovery\{/);
    assert.match(watchCss, /\.player-ad-recovery\{[^}]*position:absolute/);
    assert.match(watchCss, /\.player-ad-recovery\{[^}]*bottom:12px/);
    assert.match(watchCss, /\.player-ctrl-btn--safe\.is-on/);
    assert.match(watchCss, /\.server-badge--ad\{/);
    assert.match(watchCss, /\.server-hint-link\{/);
    // Mobile: tombol pemulihan melebar penuh, bukan menutup video.
    assert.match(watchCss, /\.player-ad-recovery-actions\{width:100%\}/);
});

/* ------------------------------------------------------------------ */
/* 6 · Panduan AdGuard DNS (jujur & bisa diikuti)                      */
/* ------------------------------------------------------------------ */
test('panduan: alamat DNS AdGuard persis seperti yang diminta pengguna', () => {
    assert.match(adGuideJs, /export const ADGUARD_DOH = 'https:\/\/dns\.adguard\.com\/dns-query';/);
    assert.match(adGuideJs, /ADGUARD_DOT = 'dns\.adguard-dns\.com'/);
    assert.match(adGuideJs, /'94\.140\.14\.14', '94\.140\.15\.15'/);
    assert.match(adGuideJs, /2a10:50c0::ad1:ff/);
    assert.match(adGuideJs, /navigator\.clipboard\.writeText/);
    for (const device of ['Android', 'iPhone', 'Windows', 'macOS', 'Router', 'Peramban']) {
        assert.ok(adGuideJs.includes(device), `langkah untuk ${device} ada`);
    }
});

test('panduan: menyatakan batas jujur — halaman web tidak bisa mengubah DNS pengunjung', () => {
    assert.match(adGuideJs, /tidak bisa mengubah DNS/);
    assert.match(adGuideJs, /lintas-domain/);
    assert.match(adGuideJs, /hardsub/);
    assert.match(adGuideJs, /registerModal|openModal/, 'memakai modal bersama (bukan alert)');
});

test('components.css: gaya panduan iklan ada dan modal bisa di-scroll di ponsel', () => {
    for (const cls of ['.ad-guide-container', '.ad-guide-steps', '.ad-guide-row', '.ad-guide-copy', '.ad-guide-links']) {
        assert.ok(componentsCss.includes(cls), `${cls} ada`);
    }
    assert.match(componentsCss, /\.ad-guide-container\{[^}]*max-height:min\(88vh/);
    assert.match(componentsCss, /\.ad-guide-container\{[^}]*overflow-y:auto/);
});
