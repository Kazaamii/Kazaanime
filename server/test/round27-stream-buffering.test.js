/**
 * Kazanime — round27-stream-buffering.test.js
 * Putaran 27 (22 Nov 2026).
 *
 * Permintaan pengguna: *"Perbaiki Web Error kembali Stream selalu bufering"*.
 *
 * Bukti produksi (22 Nov 2026):
 *  - `GET /api/stream/servers` → `servers: []`, `errors: [{ source: 'reanime', kind: 'policy' },
 *    { source: 'anizone', kind: 'blocked' }]`. `reanime.to` menolak koneksi TLS bahkan untuk `/`
 *    (situs pindah ke `reanime.cz`, `/api/flix/<id>/<ep>` normal), jadi semua request ReAnime
 *    berakhir `policy` dan panel server kosong → pemutar hanya menampilkan spinner.
 *  - Embed statis (MegaPlay/VidNest) mengirim `load` walau videonya gagal
 *    ("This video file cannot be played", "Brave browser does not support our player").
 *    Sebelum putaran ini `load` langsung dianggap `playing` → layar buffering tanpa akhir tanpa
 *    fallback dan tanpa penjelasan.
 *  - Proxy HLS memakai satu `AbortSignal.timeout(20 dtk)` untuk SELURUH body: segmen lambat
 *    diputus di tengah dan hls.js mengulang segmen yang sama terus-menerus.
 *
 * Tes ini mengunci perbaikan yang bisa diuji tanpa browser:
 *  A. pengawas pemutaran (`js/ui/playback-watch.js`) memutuskan macet/rusak dengan benar;
 *  B. player memakai pengawas itu dan menyetel ulang hls.js;
 *  C. fetcher `stream()` memakai batas TANPA KEMAJUAN (bukan batas total) dan tidak membuka
 *     circuit karena satu segmen lambat;
 *  D. ReAnime memakai `reanime.cz` dengan cadangan `.to` hanya untuk kegagalan jaringan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import { SourceError } from '../lib/errors.js';
import { createClient, createNetwork } from '../lib/fetcher.js';
import { createSigner, decodeTarget, encodeTarget } from '../lib/stream-proxy.js';
import { createReanime, streamBases } from '../providers/reanime.js';
import { TtlCache } from '../lib/cache.js';
import { createPlaybackWatch, playbackProblemText } from '../../js/ui/playback-watch.js';
import { startServer } from './helpers.js';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const SECRET = 'rahasia-uji-yang-cukup-panjang-123';

/* ------------------------------------------------------------------ */
/* A · pengawas pemutaran                                             */
/* ------------------------------------------------------------------ */
/** Waktu palsu: `now()` hanya berubah saat `advance()`. */
function fakeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

test('playback-watch: video bawaan yang tidak pernah bergerak → dipulihkan lalu pindah server', () => {
    const clock = fakeClock();
    const events = [];
    const watch = createPlaybackWatch({
        startupTimeoutMs: 20000,
        stallTimeoutMs: 12000,
        hardStallMs: 20000,
        maxRecoveries: 2,
        now: clock.now,
        onEvent: (e) => events.push(e),
    });
    watch.start('metadata');
    assert.equal(watch.tick(), null, 'belum melewati batas');
    clock.advance(20000);
    const first = watch.tick();
    assert.equal(first.phase, 'stalled');
    assert.deepEqual(first.actions, ['reload', 'nudge']);
    clock.advance(20000);
    const second = watch.tick();
    assert.equal(second.phase, 'stalled', 'pemulihan kedua masih boleh');
    clock.advance(20000);
    const third = watch.tick();
    assert.equal(third.phase, 'failed', 'setelah batas keras → pindah server, bukan buffering');
    assert.deepEqual(third.actions, ['next-server']);
    assert.deepEqual(events.map((e) => e.phase), ['started', 'stalled', 'stalled', 'failed']);
});

test('playback-watch: progres nyata menahan keputusan; diam setelah berjalan → pulihkan lalu gagal', () => {
    const clock = fakeClock();
    const events = [];
    const watch = createPlaybackWatch({
        startupTimeoutMs: 20000,
        stallTimeoutMs: 12000,
        hardStallMs: 20000,
        now: clock.now,
        onEvent: (e) => events.push(e),
    });
    watch.start();
    watch.progress({ time: 3.5 });
    clock.advance(8000);
    assert.equal(watch.tick(), null, 'masih dalam batas diam');
    clock.advance(5000); // total 13 dtk diam > stallMs
    assert.equal(watch.tick().phase, 'stalled');
    clock.advance(4000);
    watch.progress({ time: 4.2 }); // pulih sendiri
    clock.advance(5000);
    assert.equal(watch.tick(), null, 'setelah pulih, hitungan mulai lagi');
    clock.advance(40000);
    assert.equal(watch.tick().phase, 'failed');
});

test('playback-watch: embed tanpa laporan progres TIDAK dipindah otomatis (hanya hint)', () => {
    const clock = fakeClock();
    const events = [];
    const watch = createPlaybackWatch({
        startupTimeoutMs: 20000,
        stallTimeoutMs: 12000,
        hardStallMs: 20000,
        failBeforeProgress: false,
        now: clock.now,
        onEvent: (e) => events.push(e),
    });
    watch.start('iframe-loaded');
    clock.advance(21000);
    assert.deepEqual(watch.tick().actions, ['hint'], 'embed yang tidak melapor tidak dihukum');
    clock.advance(60000);
    assert.equal(watch.tick(), null, 'hint hanya sekali');
    assert.ok(!events.some((e) => e.phase === 'failed'), 'tidak pernah memindahkan server tanpa bukti');
});

test('playback-watch: video yang DIJEDA tidak dianggap macet (suspend/resume)', () => {
    const clock = fakeClock();
    const watch = createPlaybackWatch({ stallTimeoutMs: 12000, hardStallMs: 20000, now: clock.now });
    watch.start();
    watch.progress({ time: 10 });
    watch.suspend();
    clock.advance(120000); // dijeda 2 menit
    assert.equal(watch.tick(), null, 'tidak ada reload/pindah server saat video dijeda');
    watch.resume();
    clock.advance(13000);
    assert.equal(watch.tick().phase, 'stalled', 'setelah lanjut, diam tetap terdeteksi');
});

test('playback-watch: embed lintas-domain (autoRecover=false) hanya diberi petunjuk, tidak disentuh', () => {
    const clock = fakeClock();
    const events = [];
    const watch = createPlaybackWatch({
        startupTimeoutMs: 20000,
        stallTimeoutMs: 12000,
        hardStallMs: 20000,
        failBeforeProgress: false,
        autoRecover: false,
        now: clock.now,
        onEvent: (e) => events.push(e),
    });
    watch.start('iframe-loaded');
    clock.advance(30000);
    assert.deepEqual(watch.tick().actions, ['hint']);
    // Bahkan setelah video sempat bergerak lalu diam, embed tidak dimuat ulang otomatis.
    watch.progress({ time: 5 });
    clock.advance(200000);
    assert.equal(watch.tick(), null);
    assert.ok(!events.some((e) => e.phase === 'failed' || e.actions.includes('reload')));
});

test('playback-watch: fail() langsung (hls fatal) & teks masalah untuk pengguna', () => {
    const clock = fakeClock();
    const watch = createPlaybackWatch({ now: clock.now });
    watch.start();
    const e = watch.fail('hls bufferStalledError');
    assert.equal(e.phase, 'failed');
    assert.match(playbackProblemText('startup'), /tidak mulai diputar/i);
    assert.match(playbackProblemText('stalled'), /berhenti \(buffering\)/i);
    assert.match(playbackProblemText('hls manifestParsingError'), /tidak bisa diputar/i);
    assert.match(playbackProblemText('timeout'), /terlalu lama/i);
});

/* ------------------------------------------------------------------ */
/* B · player memakai pengawas + tuning hls.js                        */
/* ------------------------------------------------------------------ */
test('player: memakai pengawas buffering, menyetel hls.js, & membersihkan timer saat ganti server', () => {
    const playerJs = read('js/ui/player.js');
    assert.match(playerJs, /import \{ createPlaybackWatch, playbackProblemText \} from '\.\/playback-watch\.js';/);
    assert.match(playerJs, /function startWatch\(server, my, hooks = \{\}\) \{/);
    assert.match(playerJs, /function stopWatch\(\) \{/);
    // Timer pengawas dihentikan di clearFrame (ganti server/episode) → tidak ada timer yatim.
    const clearFn = playerJs.slice(playerJs.indexOf('function clearFrame()'), playerJs.indexOf('function clearFrame()') + 1200);
    assert.match(clearFn, /stopWatch\(\);/, 'pengawas berhenti saat frame dibersihkan');
    // Progres nyata diteruskan (timeupdate video & postMessage embed).
    assert.match(playerJs, /noteMediaProgress\(\{ time: v\.currentTime \}\);/);
    assert.match(playerJs, /noteMediaProgress\(\{ percent: pct, time: Number\(data\.currentTime \?\? data\.position\) \}\);/);
    // hls.js: buffer & kebijakan pemuatan disetel (maxBufferLength lama 30 dtk tidak cukup).
    assert.match(playerJs, /maxBufferLength: 40,/);
    assert.match(playerJs, /maxMaxBufferLength: 120,/);
    assert.match(playerJs, /maxBufferSize: 60 \* 1000 \* 1000,/);
    assert.match(playerJs, /startFragPrefetch: true,/);
    assert.match(playerJs, /fragLoadPolicy: \{/);
    assert.match(playerJs, /manifestLoadPolicy: \{/);
    assert.match(playerJs, /nudgeMaxRetry: 5,/);
    // Error hls fatal tetap memicu fail() (fallback server), bukan macet.
    assert.match(playerJs, /watch\?\.fail\(`hls \$\{data\.details \|\| data\.type\}`\);/);
});

test('player: embed tanpa progres mendapat bilah "video belum berjalan" (non-blocking, bukan layar penuh)', () => {
    const playerJs = read('js/ui/player.js');
    const watchCss = read('css/watch.css');
    assert.match(playerJs, /const PLAYBACK_HINT_ID = 'playerPlaybackHint';/);
    assert.match(playerJs, /function mountPlaybackHint\(my, server\) \{/);
    assert.match(playerJs, /function removePlaybackHint\(\) \{/);
    assert.match(playerJs, /mountPlaybackHint\(my, server\);/, 'dipasang saat pengawas memberi hint');
    // Dibersihkan saat frame dibersihkan (ganti server/episode) — tidak ada bilah tertinggal.
    const clearFn = playerJs.slice(playerJs.indexOf('function clearFrame()'), playerJs.indexOf('function clearFrame()') + 1200);
    assert.match(clearFn, /removePlaybackHint\(\);/);
    // Aksi tersedia: muat ulang server yang sama & pindah server.
    assert.match(playerJs, /data-hint-action=\"reload\"/);
    assert.match(playerJs, /data-hint-action=\"next\"/);
    assert.match(playerJs, /Video belum berjalan di server ini\?/);
    // CSS: bilah TIDAK menutupi seluruh pemutar (tidak `inset:0` seperti ad shield).
    const rule = watchCss.match(/\n\.player-playback-hint\{([^}]*)\}/)?.[1] || '';
    assert.ok(rule, 'aturan .player-playback-hint ada');
    assert.match(rule, /position:absolute/);
    assert.match(rule, /bottom:10px/);
    assert.doesNotMatch(rule, /inset:0/, 'tidak menutupi gambar pemutar');
});

test('config: PLAYER.buffering berisi batas waktu yang dipakai pengawas', async () => {
    globalThis.window ||= {
        addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    };
    const { PLAYER } = await import('../../js/config.js');
    assert.equal(PLAYER.buffering.startupMs, 20000);
    assert.equal(PLAYER.buffering.stallMs, 12000);
    assert.ok(PLAYER.buffering.hardStallMs > 0);
    assert.ok(PLAYER.buffering.maxRecoveries >= 1);
    assert.ok(PLAYER.buffering.checkEveryMs >= 1000);
    // Pemutaran tetap dilindungi: lapisan anti-iklan & sandbox Sub Indo tidak berubah.
    assert.equal(PLAYER.adShield, true);
    assert.match(PLAYER.frameGuard.policy, /allow-scripts/);
    assert.doesNotMatch(PLAYER.frameGuard.policy, /allow-popups/);
});

test('player: layar "tidak ada server" menjelaskan penyebab, bukan buffering tanpa akhir', () => {
    const playerJs = read('js/ui/player.js');
    assert.match(playerJs, /Belum ada server yang bisa memutar episode ini dari sumber Sub Indo\./);
    assert.match(playerJs, /Sumber Sub Indo biasanya pulih beberapa menit lagi — tekan Coba lagi/);
});

/* ------------------------------------------------------------------ */
/* C · fetcher stream(): batas idle, bukan batas total                */
/* ------------------------------------------------------------------ */
test('fetcher stream(): transfer lambat tetapi terus mengalir tidak diputus oleh timeout', async () => {
    // 6 potongan × 120 ms = 720 ms total; timeout 250 ms. Dengan timeout TOTAL fungsi lama,
    // body akan terputus di tengah (hls.js lalu mengulang segmen = buffering).
    const chunk = Buffer.alloc(20_000, 7);
    const upstream = await startServer((req, res) => {
        res.writeHead(200, { 'content-type': 'video/mp2t' });
        let sent = 0;
        const timer = setInterval(() => {
            res.write(chunk);
            sent += 1;
            if (sent >= 6) {
                clearInterval(timer);
                res.end();
            }
        }, 120);
        req.on('close', () => clearInterval(timer));
    });
    const net = createNetwork({ userAgent: 'KazanimeBot/1.0 (+test)' });
    const media = createClient(net, {
        source: 'uji-media', allowedHosts: ['127.0.0.1'], robots: false, intervalMs: 0, retries: 0, timeoutMs: 30000,
    });
    try {
        const up = await media.stream(`${upstream.url}/seg.ts`, { timeoutMs: 250, maxBytes: 10 * 1024 * 1024 });
        const body = Buffer.from(await new Response(up.body).arrayBuffer());
        assert.equal(body.length, 120_000, 'segmen utuh walau lebih lama dari timeout idle');
        assert.equal(net.circuit.check('uji-media').open, false, 'segmen lambat tidak membuka circuit');
    } finally {
        await upstream.close();
    }
});

test('fetcher stream(): idle melewati batas TETAP memutus (tidak menggantung) tanpa membuka circuit', async () => {
    const upstream = await startServer((req, res) => {
        res.writeHead(200, { 'content-type': 'video/mp2t' });
        res.write(Buffer.alloc(1000, 1));
        // lalu diam selamanya (tidak pernah `end`)
    });
    const net = createNetwork({ userAgent: 'KazanimeBot/1.0 (+test)' });
    const media = createClient(net, {
        source: 'uji-idle', allowedHosts: ['127.0.0.1'], robots: false, intervalMs: 0, retries: 0, timeoutMs: 30000,
    });
    try {
        const up = await media.stream(`${upstream.url}/diam.ts`, { timeoutMs: 300, maxBytes: 10 * 1024 * 1024 });
        await assert.rejects(
            new Response(up.body).arrayBuffer(),
            (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError' || /abort|idle/i.test(String(err?.message || err)),
            'body yang berhenti total diputus oleh batas idle',
        );
        assert.equal(net.circuit.check('uji-idle').open, false, 'satu segmen lambat bukan pemblokiran sumber');
    } finally {
        await upstream.close();
    }
});

test('config & route: proxy memakai batas idle + batas total, ukuran segmen sesuai batas respons Vercel', async () => {
    const { STREAMS } = await import('../config.js');
    assert.equal(STREAMS.proxyTimeoutMs, 20000);
    assert.ok(STREAMS.proxyMaxDurationMs > STREAMS.proxyTimeoutMs, 'batas total lebih longgar dari batas idle');
    assert.ok(STREAMS.proxyMaxDurationMs <= 55_000, 'masih di dalam batas fungsi Vercel 60 dtk');
    assert.ok(STREAMS.maxSegmentBytes <= 4.5 * 1024 * 1024, 'tidak melebihi batas respons Vercel');
    const route = read('server/routes/stream.js');
    assert.match(route, /maxDurationMs: STREAMS\.proxyMaxDurationMs,/);
    assert.match(route, /timeoutMs: STREAMS\.proxyTimeoutMs,/);
});

test('GET /api/stream/hls: proxy meneruskan segmen lambat (fetcher sungguhan, batas idle)', async () => {
    const seg = Buffer.alloc(240_000, 3);
    const upstream = await startServer((req, res) => {
        if (req.url.endsWith('.ts')) {
            res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(seg.length) });
            let i = 0;
            const timer = setInterval(() => {
                res.write(seg.subarray(i * 60_000, (i + 1) * 60_000));
                i += 1;
                if (i >= 4) {
                    clearInterval(timer);
                    res.end();
                }
            }, 130);
            req.on('close', () => clearInterval(timer));
            return;
        }
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n');
    });
    const net = createNetwork({ userAgent: 'KazanimeBot/1.0 (+test)' });
    const media = createClient(net, {
        source: 'uji-proxy', allowedHosts: ['127.0.0.1'], robots: false, intervalMs: 0, retries: 0, timeoutMs: 30000,
    });
    const signer = createSigner(SECRET);
    const app = createApp({
        registry: { async latest() { return { source: 'x', data: [], fallback: false, stale: false, errors: [] }; }, health: () => ({}) },
        streams: { async servers() { return { servers: [], status: {}, errors: [] }; }, health: () => [] },
        mediaClient: media,
        signer,
        log: false,
        rateLimitPerMinute: 0,
        proxyRateLimitPerMinute: 0,
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const target = `${upstream.url}/video/720/00000.ts`;
        const url = `${base}/api/stream/hls?u=${encodeTarget(target)}&s=${signer.sign(target)}`;
        assert.equal(decodeTarget(new URL(url).searchParams.get('u')), target);
        const res = await fetch(url);
        assert.equal(res.status, 200);
        const body = Buffer.from(await res.arrayBuffer());
        assert.equal(body.length, seg.length, 'segmen utuh walau 520 ms (di atas batas idle 3 dtk? tidak) — tetap utuh');
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
        await upstream.close();
    }
});

/* ------------------------------------------------------------------ */
/* D · ReAnime pindah domain                                          */
/* ------------------------------------------------------------------ */
test('reanime: basis utama reanime.cz (reanime.to tidak lagi menerima koneksi)', async () => {
    const { STREAMS } = await import('../config.js');
    assert.equal(STREAMS.reanime.baseUrl, 'https://reanime.cz');
    assert.equal(STREAMS.reanime.fallbackBaseUrl, 'https://reanime.to');
    assert.deepEqual(streamBases('https://reanime.cz', 'https://reanime.to').map((b) => b.base),
        ['https://reanime.cz', 'https://reanime.to']);
    // Duplikat/tidak valid dibuang (tidak ada request ganda ke host yang sama).
    assert.deepEqual(streamBases('https://reanime.cz', 'https://reanime.cz/').map((b) => b.base), ['https://reanime.cz']);
    assert.deepEqual(streamBases('bukan-url', 'https://reanime.to').map((b) => b.base), ['https://reanime.to']);
});

test('reanime: challenge/403 tidak pernah memicu basis cadangan (tanpa retry/bypass)', async () => {
    const calls = [];
    const createClient = (_net, opts) => ({
        opts,
        async json(url) {
            calls.push(url);
            throw new SourceError('challenge', { kind: 'blocked', source: 'reanime' });
        },
    });
    const r = createReanime({ network: {}, createClient });
    await assert.rejects(r.servers({ anilist: 21, ep: 1 }), (e) => e.kind === 'blocked');
    assert.deepEqual(calls, ['https://reanime.cz/api/flix/21/1']);
});

test('reanime: hasil provider tetap di-cache & dipakai route /servers', async () => {
    const servers = [{ name: 'ReAnime HD-2', label: 'HD-2', url: 'https://flixcloud.cc/e/a?v=2', lang: 'en', kind: 'embed' }];
    let n = 0;
    const cache = new TtlCache();
    const { createStreamProviders } = await import('../providers/index.js');
    const providers = createStreamProviders({
        providers: [{ id: 'reanime', name: 'ReAnime', baseUrl: 'https://reanime.cz', async servers() { n += 1; return { servers }; } }],
        cache,
    });
    const first = await providers.servers({ anilist: 21, ep: 1 });
    await providers.servers({ anilist: 21, ep: 1 });
    assert.equal(first.servers.length, 1);
    assert.equal(n, 1, 'hasil di-cache (satu request per episode)');
});
