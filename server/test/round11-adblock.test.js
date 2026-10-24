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
import { buildDnsQuery, createDnsFilter, isBlockedResult, parseDnsResponse } from '../lib/dns.js';
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
/**
 * Bikin paket DNS biner tiruan (jawaban) untuk satu host + daftar A record.
 * @param {string} host
 * @param {string[]} addresses
 * @param {number} [rcode]
 */
function dnsPacket(host, addresses, rcode = 0) {
    const query = buildDnsQuery(host, 0x1234);
    const question = query.slice(12); // QNAME + QTYPE + QCLASS
    const answerName = Buffer.from([0xc0, 0x0c]); // pointer ke nama di question
    const records = addresses.map((ip) => {
        const body = Buffer.alloc(14);
        body.writeUInt16BE(1, 0);        // TYPE A
        body.writeUInt16BE(1, 2);        // CLASS IN
        body.writeUInt32BE(60, 4);       // TTL
        body.writeUInt16BE(4, 8);        // RDLENGTH
        Buffer.from(ip.split('.').map(Number)).copy(body, 10);
        return Buffer.concat([answerName, body]);
    });
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x1234, 0);
    header.writeUInt16BE(0x8180 | rcode, 2); // QR + RD + RA (+ RCODE)
    header.writeUInt16BE(1, 4);              // QDCOUNT
    header.writeUInt16BE(records.length, 6);
    return Buffer.concat([header, question, ...records]);
}

/** Jawaban wireformat (RFC 8484) berupa ArrayBuffer. */
const wireResponse = (packet, status = 200) => ({
    ok: status === 200,
    status,
    async arrayBuffer() { return packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength); },
});

/** Jawaban JSON (endpoint `/resolve`). */
const dohResponse = (body, status = 200) => ({ ok: status === 200, status, async json() { return body; } });
const dohJsonBlocked = () => dohResponse({ Status: 0, Answer: [{ type: 1, data: '0.0.0.0' }] });
const dohJsonOk = () => dohResponse({ Status: 0, Answer: [{ type: 1, data: '104.21.32.1' }] });
const dohJsonNx = () => dohResponse({ Status: 3, Answer: [] });

test('dns: endpoint default AdGuard DoH yang diminta pengguna', () => {
    assert.equal(ADS.dohEndpoint, 'https://dns.adguard.com/dns-query');
    assert.equal(ADS.dnsJsonEndpoint, 'https://dns.adguard.com/resolve');
    assert.equal(ADS.dnsCheck, true);
    const dns = createDnsFilter({ fetchImpl: async () => wireResponse(dnsPacket('x.example', ['1.2.3.4'])) });
    assert.equal(dns.endpoint, 'https://dns.adguard.com/dns-query');
    assert.equal(dns.status().jsonEndpoint, 'https://dns.adguard.com/resolve');
});

test('dns: wireformat RFC 8484 — query biner valid, 0.0.0.0/NXDOMAIN diblokir, A record normal tidak', async () => {
    /** @type {string[]} */
    const calls = [];
    const dns = createDnsFilter({
        fetchImpl: async (url, opts) => {
            calls.push(url);
            assert.equal(opts.method, 'POST', 'endpoint /dns-query menerima POST biner');
            assert.equal(opts.headers['content-type'], 'application/dns-message');
            assert.ok(opts.body instanceof Uint8Array, 'body = paket DNS biner');
            const host = Buffer.from(opts.body).includes(Buffer.from('popads')) ? 'popads'
                : Buffer.from(opts.body).includes(Buffer.from('mati')) ? 'mati' : 'ok';
            if (host === 'popads') return wireResponse(dnsPacket('popads.net', ['0.0.0.0']));
            if (host === 'mati') return wireResponse(dnsPacket('mati.example', [], 3));
            return wireResponse(dnsPacket('animeku.lol', ['104.21.32.1']));
        },
    });
    assert.equal(await dns.isBlocked('popads.net'), true);
    assert.equal(await dns.isBlocked('mati.example'), true, 'NXDOMAIN dari resolver penyaring = diblokir');
    assert.equal(await dns.isBlocked('animeku.lol'), false);
    assert.equal(calls[0], 'https://dns.adguard.com/dns-query');
    assert.equal(calls.length, 3);
});

test('dns: packet encoder & parser wireformat', () => {
    const query = buildDnsQuery('a.b.example', 0xbeef);
    const buf = Buffer.from(query);
    assert.equal(buf.readUInt16BE(0), 0xbeef, 'ID dipertahankan');
    assert.equal(buf.readUInt16BE(4), 1, 'QDCOUNT = 1');
    assert.equal(buf.readUInt16BE(buf.length - 4), 1, 'QTYPE A');
    assert.equal(buf.readUInt16BE(buf.length - 2), 1, 'QCLASS IN');
    assert.deepEqual(parseDnsResponse(dnsPacket('a.b.example', ['93.184.216.34'])), { status: 0, answers: 1, addresses: ['93.184.216.34'] });
    assert.deepEqual(parseDnsResponse(dnsPacket('a.b.example', ['0.0.0.0'])).addresses, ['0.0.0.0']);
    assert.equal(parseDnsResponse(dnsPacket('a.b.example', [], 3)).status, 3);
    assert.equal(isBlockedResult(0, 1, ['0.0.0.0']), true);
    assert.equal(isBlockedResult(0, 0, []), true, 'tanpa Answer = diblokir daftar');
    assert.equal(isBlockedResult(3, 0, []), true);
    assert.equal(isBlockedResult(0, 1, ['104.21.32.1']), false);
    assert.throws(() => parseDnsResponse(new Uint8Array(4)));
});

test('dns: endpoint DoH menolak → otomatis pakai JSON AdGuard /resolve', async () => {
    /** @type {string[]} */
    const calls = [];
    const dns = createDnsFilter({
        fetchImpl: async (url, opts) => {
            calls.push(url);
            if (opts.method === 'POST') return { ok: false, status: 405 };
            assert.equal(opts.headers.accept, 'application/dns-json');
            return url.includes('popads') ? dohJsonBlocked() : dohJsonOk();
        },
    });
    assert.equal(await dns.isBlocked('popads.net'), true);
    assert.equal(await dns.isBlocked('animeku.lol'), false);
    assert.equal(calls[0], 'https://dns.adguard.com/dns-query');
    assert.ok(calls[1].startsWith('https://dns.adguard.com/resolve?name=popads.net'));
    assert.ok(calls[1].includes('&type=A'));
});

test('dns: cache 6 jam (tidak menembak DoH berulang) dan checkMany maksimal 20 host', async () => {
    let n = 0;
    const dns = createDnsFilter({ fetchImpl: async () => { n++; return wireResponse(dnsPacket('h.example', ['1.1.1.1'])); } });
    await dns.isBlocked('a.example');
    await dns.isBlocked('a.example');
    assert.equal(n, 1, 'hasil di-cache');
    const many = await dns.checkMany(Array.from({ length: 25 }, (_, i) => `h${i}.example`));
    assert.equal(Object.keys(many).length, 20, 'dibatasi 20 host');
    assert.equal(dns.status().requests, 21);
});

test('dns: FAIL-OPEN — DoH error/timeout → null, lalu cooldown 10 menit', async () => {
    let n = 0;
    /** @type {string[]} */
    const calls = [];
    const dns = createDnsFilter({ fetchImpl: async (url) => { n++; calls.push(url); throw new Error('offline'); } });
    assert.equal(await dns.isBlocked('popads.net'), null);
    assert.equal(n, 2, 'wireformat lalu JSON dicoba sekali masing-masing');
    assert.equal(calls[0], 'https://dns.adguard.com/dns-query');
    assert.ok(calls[1].startsWith('https://dns.adguard.com/resolve?name='));
    assert.equal(await dns.isBlocked('lain.example'), null, 'cooldown → tidak mencoba lagi');
    assert.equal(n, 2);
    const status = dns.status();
    assert.equal(status.failures, 1);
    assert.equal(status.coolingDown, true);
});

test('dns: ADS_DNS_CHECK=0 mematikan pemeriksaan tanpa error', async () => {
    let n = 0;
    const dns = createDnsFilter({ enabled: false, fetchImpl: async () => { n++; return wireResponse(dnsPacket('h.example', ['1.1.1.1'])); } });
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
    const dns = createDnsFilter({
        fetchImpl: async (url, opts) => (Buffer.from(opts.body || '').includes(Buffer.from('mati'))
            ? wireResponse(dnsPacket('mati.example', [], 3))
            : wireResponse(dnsPacket('ok.example', ['1.2.3.4']))),
    });
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
        const dns = createDnsFilter({ fetchImpl: async () => wireResponse(dnsPacket('videohost.example', ['0.0.0.0'])) });
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
test('config: penahan pop-up selalu aktif (tanpa mode) & kebijakan tanpa pop-up', () => {
    // Putaran 12: tombol/mode "Mode Aman" dihapus; penahan pop-up kini otomatis.
    assert.doesNotMatch(configJs, /safeFrame: Object\.freeze\(\{/, 'config Mode Aman sudah tidak ada');
    assert.match(configJs, /frameGuard: Object\.freeze\(\{/);
    assert.match(configJs, /releaseAfterMs:\s*\d+/);
    assert.match(configJs, /hintAfterMs:\s*\d+/);
    const policy = configJs.match(/frameGuard: Object\.freeze\(\{[\s\S]{0,800}?policy: '([^']+)'/)?.[1] || '';
    assert.ok(policy.includes('allow-scripts') && policy.includes('allow-same-origin'));
    assert.ok(!policy.includes('allow-popups'), 'iklan tidak boleh membuka tab baru');
    assert.ok(!policy.includes('allow-top-navigation'), 'iklan tidak boleh membajak tab Kazanime');
    assert.match(configJs, /noSandboxHosts: 'kz:no-sandbox'/);
    assert.match(configJs, /adCheckCache: 'kz:adcheck'/);
    // Layar penuh standar player (putaran 12).
    assert.match(configJs, /fullscreen: Object\.freeze\(\{/);
    assert.match(configJs, /orientation: 'landscape'/);
});

test('player: penahan pop-up dipasang otomatis + pelepas per host (bukan tombol)', () => {
    assert.match(playerJs, /const guarded = !hostRefusesSandbox\(urlOf\(server\)\);/);
    assert.match(playerJs, /iframe\.dataset\.frameGuard = guarded \? 'on' : 'off';/);
    assert.match(playerJs, /function releaseFrameGuard\(reason\)/);
    assert.match(playerJs, /rememberNoSandboxHost\(hostOf\(urlOf\(active\)\)\)/);
    assert.match(playerJs, /sessionStorage\.getItem\(STORAGE_KEYS\.noSandboxHosts\)/);
    // Jalan keluar manual di bawah player (bukan mode yang harus dinyalakan).
    assert.match(playerJs, /function mountFrameHint\(my\)/);
    assert.match(playerJs, /Muat ulang tanpa pengaman/);
    assert.doesNotMatch(playerJs, /btnSafeMode|isSafeFrameOn|saveSafeFrame/);
});

test('player: sandbox tetap aktif saat timeout; pelepasan hanya manual', () => {
    const releaseBlock = playerJs.slice(playerJs.indexOf('function releaseFrameGuard'), playerJs.indexOf('function releaseFrameGuard') + 1200);
    assert.match(releaseBlock, /applyFramePolicy\(frame, false\)/);
    assert.match(releaseBlock, /play\(active\)/, 'pelepasan manual memuat ulang server yang sama');
    assert.match(releaseBlock, /reason === 'manual'/);
    const timeoutBlock = playerJs.slice(playerJs.indexOf('// Jangan melepas sandbox otomatis'), playerJs.indexOf('// Jangan melepas sandbox otomatis') + 500);
    assert.match(timeoutBlock, /fail\(server, 'timeout'\)/, 'timeout mencoba server berikutnya dengan sandbox tetap aktif');
    assert.doesNotMatch(timeoutBlock, /releaseFrameGuard\('timeout'\)/);
    const guardTimerBlock = playerJs.slice(playerJs.indexOf('guardTimer = setTimeout'));
    assert.match(guardTimerBlock.slice(0, 250), /Tidak ada pelepasan otomatis/);
    assert.doesNotMatch(guardTimerBlock.slice(0, 250), /releaseFrameGuard\('timeout'\)/);
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
    const baseRecovery = watchCss.match(/(?:^|\n)\.player-ad-recovery\{([^}]*)\}/)?.[1] || '';
    assert.ok(baseRecovery, 'aturan dasar bilah pemulihan ada');
    assert.doesNotMatch(baseRecovery, /inset:\s*0|position:\s*fixed/, 'tidak pernah menutupi seluruh player');
    assert.match(baseRecovery, /position:absolute/);
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

test('watch: tombol layar penuh, panduan iklan, dan penyaringan server', () => {
    assert.doesNotMatch(watchHtml, /btnSafeMode/, 'tombol Mode Aman sudah dihapus');
    assert.match(watchHtml, /id="btnFullscreen"/);
    assert.match(watchHtml, /id="btnAdGuide"/);
    const controls = watchHtml.slice(watchHtml.indexOf('player-controls'), watchHtml.indexOf('server-hint'));
    assert.ok(controls.indexOf('btnNextServer') < controls.indexOf('btnFullscreen'), 'Layar Penuh setelah Server Lain');
    assert.ok(controls.indexOf('btnFullscreen') < controls.indexOf('btnExternalPlayer'));

    assert.match(watchJs, /import \{ createPlayer \} from '\.\/ui\/player\.js';/);
    assert.match(watchJs, /import \{ openAdGuide \} from '\.\/ui\/ad-guide\.js';/);
    assert.match(watchJs, /import \{ filterAdServers, checkHosts \} from '\.\/services\/adblock\.js';/);
    assert.match(watchJs, /player\.toggleFullscreen\(\)\.then/);
    assert.match(watchJs, /player\.on\('fullscreen'/);
    assert.doesNotMatch(watchJs, /safeFrame|setSafeFrame|btnSafeMode|syncSafeModeButton/);
    assert.match(watchJs, /player\.on\('adblock'/);
    assert.match(watchJs, /player\.on\('adguide', \(\) => openAdGuide\(\)\)/);
    assert.match(watchJs, /els\.adGuideBtn\?\.addEventListener\('click', \(\) => openAdGuide\(\)\)/);
    // Server bertanda hanya diberi peringatan; tidak diblokir otomatis.
    assert.match(watchJs, /adRisk: true/);
    assert.doesNotMatch(watchJs, /filter\(\(server\) => !adRiskHosts/);
});

test('css: bilah pemulihan, tanda server berisiko, layar penuh', () => {
    assert.match(watchCss, /\.player-ad-recovery\{/);
    assert.match(watchCss, /\.player-ad-recovery\{[^}]*position:absolute/);
    assert.match(watchCss, /\.player-ad-recovery\{[^}]*bottom:12px/);
    assert.match(watchCss, /\.server-badge--ad\{/);
    assert.match(watchCss, /\.server-hint-link\{/);
    assert.doesNotMatch(watchCss, /\.player-ctrl-btn--safe/, 'gaya Mode Aman sudah dihapus');
    // Mobile: tombol pemulihan melebar penuh, bukan menutup video.
    assert.match(watchCss, /\.player-ad-recovery-actions\{width:100%\}/);
    // Layar penuh: wadah player mengisi layar & tombol keluar tersedia.
    assert.match(watchCss, /\.streaming-player-wrapper:fullscreen/);
    assert.match(watchCss, /\.player-fs-exit\{/);
    assert.match(watchCss, /\.player-frame-hint\{/);
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
