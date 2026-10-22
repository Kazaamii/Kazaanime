import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { TtlCache } from '../lib/cache.js';
import { SourceError } from '../lib/errors.js';
import { assToVtt, createSigner, decodeTarget, encodeTarget, rewritePlaylist, srtToVtt, toVtt } from '../lib/stream-proxy.js';
import { createAnizone, decodeJsJson, parsePlayer, parseSearchItems } from '../providers/anizone.js';
import { createStreamProviders } from '../providers/index.js';
import { bestTitleMatch, looseKey } from '../providers/match.js';
import { anilistIdOf, createReanime, parseFlix } from '../providers/reanime.js';
import { fixture } from './helpers.js';

const SECRET = 'rahasia-uji-yang-cukup-panjang-123';

/* ------------------------------------------------------------------ */
/* lib/stream-proxy.js                                                 */
/* ------------------------------------------------------------------ */
test('stream-proxy: signer HMAC + encode/decode target', () => {
    const s = createSigner(SECRET);
    const url = 'https://suzaku.xin-cdn.xyz/abc/master.m3u8';
    const sig = s.sign(url);
    assert.equal(sig.length, 22);
    assert.ok(s.verify(url, sig));
    assert.ok(!s.verify(`${url}x`, sig));
    assert.ok(!s.verify(url, 'salah'));
    assert.ok(!createSigner('secret-lain-yang-juga-panjang!!').verify(url, sig));
    assert.equal(decodeTarget(encodeTarget(url)), url);
    assert.equal(decodeTarget('bukan base64!!'), '');
    assert.throws(() => createSigner('pendek'));
});

test('stream-proxy: playlist AniZone asli → semua URI (audio, varian, key, segmen) lewat proxy', () => {
    const to = (u) => `/p?u=${encodeURIComponent(u)}`;
    const master = rewritePlaylist(fixture('anizone-master.m3u8'), 'https://suzaku.xin-cdn.xyz/77/master.m3u8', to);
    assert.match(master, /URI="\/p\?u=https%3A%2F%2Fsuzaku\.xin-cdn\.xyz%2F77%2Faudio%2F0_ja%2Fplaylist\.m3u8"/);
    assert.match(master, /^\/p\?u=https%3A%2F%2Fsuzaku\.xin-cdn\.xyz%2F77%2Fvideo%2F1080%2Fplaylist\.m3u8$/m);
    assert.ok(!/\nvideo\//.test(master), 'tidak ada URI relatif tersisa');
    const variant = rewritePlaylist(fixture('anizone-variant.m3u8'), 'https://suzaku.xin-cdn.xyz/77/video/720/playlist.m3u8', to);
    assert.match(variant, /#EXT-X-KEY:METHOD=AES-128,URI="\/p\?u=https%3A%2F%2Fsuzaku\.xin-cdn\.xyz%2F77%2Fkeys%2F[^"]+\.key",IV=0x/);
    assert.match(variant, /^\/p\?u=https%3A%2F%2Fsuzaku\.xin-cdn\.xyz%2F77%2Fvideo%2F720%2F00000\.ts$/m);
    assert.match(variant, /#EXT-X-ENDLIST/);
});

test('stream-proxy: ASS → WebVTT (dialog, \\N, posisi \\pos/\\an, gambar vektor dibuang, escape)', () => {
    const ass = [
        '[Script Info]', 'PlayResX: 1920', 'PlayResY: 1080', '',
        '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.50,0:00:03.20,Default,,0,0,0,,{\\i1}Halo,{\\i0} dunia!\\NBaris dua',
        'Dialogue: 0,0:00:02.00,0:00:04.00,Sign,,0,0,0,,{\\an8\\pos(960,108)}TOKO RAMEN',
        'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0{\\p0}',
        'Dialogue: 0,1:02:07.00,1:02:08.00,Top,,0,0,0,,{\\an8}a < b & c',
    ].join('\n');
    const vtt = assToVtt(ass);
    assert.ok(vtt.startsWith('WEBVTT\n'));
    assert.match(vtt, /00:00:01\.500 --> 00:00:03\.200\nHalo, dunia!\nBaris dua/);
    assert.match(vtt, /00:00:02\.000 --> 00:00:04\.000 line:10% position:50% align:center\nTOKO RAMEN/);
    assert.ok(!/m 0 0 l/.test(vtt));
    assert.match(vtt, /01:02:07\.000 --> 01:02:08\.000 line:5%\na &lt; b &amp; c/);
});

test('stream-proxy: SRT → WebVTT & deteksi format', () => {
    const vtt = srtToVtt('1\r\n00:00:01,000 --> 00:00:02,500\r\n<font color="red">Merah</font> <i>miring</i>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n{\\an8}Atas\r\n');
    assert.match(vtt, /00:00:01\.000 --> 00:00:02\.500\nMerah <i>miring<\/i>/);
    assert.match(vtt, /00:00:03\.000 --> 00:00:04\.000\nAtas/);
    assert.ok(toVtt('WEBVTT\n\n00:00.000 --> 00:01.000\nx').startsWith('WEBVTT'));
    assert.match(toVtt('[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:02.00,D,Hai', ''), /Hai/);
});

/* ------------------------------------------------------------------ */
/* providers                                                           */
/* ------------------------------------------------------------------ */
test('match: kunci longgar menyamakan "2nd Season" = "Season 2" = "II" tanpa mengubah kata romaji', () => {
    assert.equal(looseKey('Tensei Shitara Ken Deshita 2nd Season'), looseKey('Tensei Shitara Ken Deshita II'));
    assert.equal(looseKey('Reincarnated as a Sword Season 2'), looseKey('Reincarnated as a Sword: Season 2'));
    assert.notEqual(looseKey('Overlord II'), looseKey('Overlord III'));
    assert.equal(looseKey('Kawaii Dake ja Nai'), 'kawaiidakejanai');
    const items = parseSearchItems(fixture('anizone-search.html'));
    const s2 = bestTitleMatch(items, (i) => i.titles, ['Reincarnated as a Sword Season 2', 'Tensei Shitara Ken Deshita 2nd Season'], { year: 2026, yearOf: (i) => i.year });
    assert.equal(s2.slug, 'ivt095hh');
    const s1 = bestTitleMatch(items, (i) => i.titles, ['Reincarnated as a Sword'], {});
    assert.equal(s1.slug, 'gvm4eknu', 'season lain tidak ikut tercocokkan');
    assert.equal(bestTitleMatch(items, (i) => i.titles, ['Judul Lain Sama Sekali']), null);
});

test('anizone: data player asli → HLS + subtitle (Indonesia default, Forced dibuang), host media wajib di allowlist', () => {
    assert.deepEqual(decodeJsJson('{\\u0022a\\u0022:\\u0022x\\\\\\/y\\u0022}'), { a: 'x/y' });
    const p = parsePlayer(fixture('anizone-episode.html'), ['xin-cdn.xyz']);
    assert.equal(p.src, 'https://suzaku.xin-cdn.xyz/77511fce-546a-42ed-b5ea-d454a5f07a23/master.m3u8');
    assert.equal(p.subtitles[0].lang, 'id');
    assert.equal(p.subtitles[0].label, 'Indonesia');
    assert.equal(p.subtitles[0].default, true);
    assert.equal(p.subtitles.filter((s) => s.default).length, 1);
    assert.ok(p.subtitles.length >= 10 && p.subtitles.length <= 16);
    assert.ok(p.subtitles.every((s) => s.file.startsWith('https://suzaku.xin-cdn.xyz/')));
    assert.equal(parsePlayer(fixture('anizone-episode.html'), ['cdn-lain.example']), null, 'src di host lain ditolak');
    assert.equal(parsePlayer('<div>tanpa player</div>', ['xin-cdn.xyz']), null);
});

test('reanime: respons /api/flix asli → HD-2 lalu HD-1 (sub saja), host embed wajib di allowlist; id AniList dari cover', () => {
    const json = JSON.parse(fixture('reanime-flix.json'));
    const servers = parseFlix(json, ['flixcloud.cc']);
    assert.deepEqual(servers.map((s) => s.label), ['HD-2', 'HD-1']);
    assert.ok(servers.every((s) => s.url.startsWith('https://flixcloud.cc/e/') && s.lang === 'en'));
    assert.deepEqual(parseFlix({ success: true, servers: [{ serverName: 'X', dataLink: 'https://evil.example/e/1', dataType: 'sub' }] }, ['flixcloud.cc']), []);
    assert.deepEqual(parseFlix({ success: true, servers: [] }, ['flixcloud.cc']), []);
    const search = JSON.parse(fixture('reanime-search.json'));
    const s2 = search.results.find((r) => r.anime_id === 'reincarnated-as-a-sword-season-2-qf47ug');
    assert.equal(s2.anilist_id, 0);
    assert.equal(anilistIdOf(s2), 159042, 'anilist_id 0 → dari URL cover bx159042');
});

/** Klien palsu untuk provider: URL → {text}|JSON|Error. */
function providerClient(routes) {
    const calls = [];
    const createClient = (_net, opts) => ({
        opts,
        async request(url) {
            calls.push(url);
            const v = routes[url];
            if (v instanceof Error) throw v;
            if (v === undefined) throw new SourceError('404', { kind: 'not_found', source: opts.source });
            return { status: 200, url, text: String(v) };
        },
        async json(url) {
            calls.push(url);
            const v = routes[url];
            if (v instanceof Error) throw v;
            if (v === undefined) throw new SourceError('404', { kind: 'not_found', source: opts.source });
            return typeof v === 'string' ? JSON.parse(v) : v;
        },
    });
    return { createClient, calls };
}

test('reanime provider: pakai id AniList langsung; tanpa id → cari judul dulu', async () => {
    const flix = fixture('reanime-flix.json');
    const { createClient, calls } = providerClient({
        'https://reanime.to/api/flix/21/1': flix,
        'https://reanime.to/api/v1/search?q=Reincarnated+as+a+Sword+Season+2&limit=8': fixture('reanime-search.json'),
        'https://reanime.to/api/flix/159042/3': flix,
    });
    const r = createReanime({ network: {}, createClient });
    const a = await r.servers({ anilist: 21, ep: 1 });
    assert.equal(a.servers[0].label, 'HD-2');
    const b = await r.servers({ ep: 3, titles: ['Reincarnated as a Sword Season 2'] });
    assert.equal(b.anilist, 159042);
    assert.ok(calls.includes('https://reanime.to/api/flix/159042/3'));
    await assert.rejects(r.servers({ ep: 1, titles: [] }), (e) => e.kind === 'not_found');
});

test('anizone provider: cari slug lewat judul → halaman episode → server HLS', async () => {
    const { createClient, calls } = providerClient({
        'https://anizone.to/anime?search=Tensei+Shitara+Ken+Deshita+2nd+Season': fixture('anizone-search.html'),
        'https://anizone.to/anime/ivt095hh/3': fixture('anizone-episode.html'),
    });
    const z = createAnizone({ network: {}, createClient });
    const r = await z.servers({ ep: 3, titles: ['Tensei Shitara Ken Deshita 2nd Season'], year: 2026 });
    assert.equal(r.slug, 'ivt095hh');
    assert.equal(r.servers[0].kind, 'hls');
    assert.equal(r.servers[0].lang, 'multi');
    assert.match(r.servers[0].src, /\.xin-cdn\.xyz\/.+\/master\.m3u8$/);
    assert.ok(calls.every((u) => u.startsWith('https://anizone.to/')));
    await assert.rejects(z.servers({ ep: 99, titles: ['Tensei Shitara Ken Deshita 2nd Season'] }), (e) => e.kind === 'not_found');
});

test('createStreamProviders: paralel, status per penyedia, not_found di-cache singkat, error tidak menjatuhkan yang lain', async () => {
    let n = 0;
    const ok = { id: 'reanime', name: 'R', baseUrl: 'x', async servers() { n++; return { servers: [{ name: 'ReAnime HD-2', url: 'https://flixcloud.cc/e/a?v=2', lang: 'en', kind: 'embed' }] }; } };
    const nf = { id: 'anizone', name: 'A', baseUrl: 'y', async servers() { throw new SourceError('tidak ada', { kind: 'not_found', source: 'anizone' }); } };
    const bad = { id: 'lain', name: 'L', baseUrl: 'z', async servers() { throw new SourceError('diblokir', { kind: 'blocked', source: 'lain' }); } };
    const p = createStreamProviders({ providers: [ok, nf, bad], cache: new TtlCache() });
    const r = await p.servers({ anilist: 21, ep: 1, titles: ['One Piece'] });
    assert.deepEqual(r.status, { reanime: 'ok', anizone: 'not_found', lain: 'blocked' });
    assert.equal(r.servers.length, 1);
    assert.equal(r.servers[0].provider, 'reanime');
    assert.equal(r.errors.length, 1);
    await p.servers({ anilist: 21, ep: 1, titles: ['One Piece'] });
    assert.equal(n, 1, 'hasil di-cache');
});

/* ------------------------------------------------------------------ */
/* routes/stream.js                                                    */
/* ------------------------------------------------------------------ */
const fakeRegistry = () => ({
    async latest() { return { source: 'x', data: [], fallback: false, stale: false, errors: [] }; },
    health: () => ({ sources: [], metadata: { enabled: false }, cache: { entries: 0 } }),
});

function fakeMedia(routes) {
    const calls = [];
    return {
        calls,
        async stream(url, opts = {}) {
            calls.push({ url, range: opts.headers?.Range || null });
            let v = routes[url];
            if (typeof v === 'function') v = v(calls.filter((c) => c.url === url).length);
            if (!v) return { status: 404, headers: new Headers(), body: new Response('nope').body, url };
            const body = typeof v.body === 'string' || v.body instanceof Uint8Array ? new Response(v.body).body : null;
            return { status: v.status || 200, headers: new Headers(v.headers || {}), body, url };
        },
    };
}

async function withStreamApp({ streams, media }, fn) {
    const signer = createSigner(SECRET);
    const app = createApp({ registry: fakeRegistry(), streams, mediaClient: media, signer, log: false, rateLimitPerMinute: 0, proxyRateLimitPerMinute: 0, budgetMs: 5000 });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await fn(base, signer);
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
}

const fakeStreams = (servers, status = { reanime: 'ok', anizone: 'ok' }) => ({
    seen: [],
    async servers(q) { this.seen.push(q); return { servers, status, errors: [] }; },
    health: () => [],
});

test('GET /api/stream/servers: validasi, URL HLS & subtitle ditandatangani, embed apa adanya', async () => {
    const streams = fakeStreams([
        { provider: 'reanime', kind: 'embed', name: 'ReAnime HD-2', label: 'HD-2', url: 'https://flixcloud.cc/e/a?v=2', lang: 'en' },
        { provider: 'anizone', kind: 'hls', name: 'AniZone', lang: 'multi', src: 'https://suzaku.xin-cdn.xyz/u/master.m3u8', subtitles: [{ label: 'Indonesia', lang: 'id', format: 'ass', file: 'https://suzaku.xin-cdn.xyz/u/subtitles/8_id.ass', default: true }] },
    ]);
    await withStreamApp({ streams, media: fakeMedia({}) }, async (base, signer) => {
        assert.equal((await fetch(`${base}/api/stream/servers?ep=1`)).status, 400, 'butuh anilist/title');
        assert.equal((await fetch(`${base}/api/stream/servers?ep=0&anilist=1`)).status, 400);
        const res = await fetch(`${base}/api/stream/servers?ep=3&anilist=159042&title=Reincarnated%20as%20a%20Sword&title=x&year=2026`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('cache-control'), /s-maxage=600/);
        const json = await res.json();
        assert.equal(json.ok, true);
        assert.deepEqual(streams.seen[0], { anilist: 159042, ep: 3, titles: ['Reincarnated as a Sword'], year: 2026 });
        const [embed, hls] = json.data.servers;
        assert.deepEqual(embed, { provider: 'reanime', kind: 'embed', name: 'ReAnime HD-2', label: 'HD-2', lang: 'en', url: 'https://flixcloud.cc/e/a?v=2' });
        assert.equal(hls.direct, 'https://suzaku.xin-cdn.xyz/u/master.m3u8');
        const u = new URL(hls.url, base);
        assert.equal(u.pathname, '/api/stream/hls');
        assert.ok(signer.verify(decodeTarget(u.searchParams.get('u')), u.searchParams.get('s')));
        const t = new URL(hls.subtitles[0].url, base);
        assert.equal(t.searchParams.get('f'), 'ass');
        assert.ok(signer.verify(`${decodeTarget(t.searchParams.get('u'))}|ass`, t.searchParams.get('s')));
    });
});

test('GET /api/stream/hls: playlist ditulis ulang; segmen diteruskan (Range/206, cache lama); tanda tangan salah → 403', async () => {
    const MASTER = 'https://suzaku.xin-cdn.xyz/77/master.m3u8';
    const SEG = 'https://suzaku.xin-cdn.xyz/77/video/720/00000.ts';
    const bytes = new Uint8Array([0x47, 1, 2, 3, 4, 5, 6, 7]);
    const media = fakeMedia({
        [MASTER]: { headers: { 'content-type': 'application/vnd.apple.mpegurl' }, body: fixture('anizone-master.m3u8') },
        [SEG]: { status: 206, headers: { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-7/8', 'content-length': '8' }, body: bytes },
    });
    await withStreamApp({ streams: fakeStreams([]), media }, async (base, signer) => {
        const q = (u) => `${base}/api/stream/hls?u=${encodeTarget(u)}&s=${signer.sign(u)}`;
        const pl = await fetch(q(MASTER));
        assert.equal(pl.status, 200);
        assert.match(pl.headers.get('content-type'), /mpegurl/);
        const text = await pl.text();
        const firstUri = text.split('\n').find((l) => l && !l.startsWith('#'));
        const inner = new URL(firstUri, base);
        assert.equal(decodeTarget(inner.searchParams.get('u')), 'https://suzaku.xin-cdn.xyz/77/video/360/playlist.m3u8');
        assert.ok(signer.verify(decodeTarget(inner.searchParams.get('u')), inner.searchParams.get('s')), 'URI anak ikut ditandatangani');

        const seg = await fetch(q(SEG), { headers: { Range: 'bytes=0-7' } });
        assert.equal(seg.status, 206);
        assert.equal(seg.headers.get('content-range'), 'bytes 0-7/8');
        assert.match(seg.headers.get('cache-control'), /immutable/);
        assert.deepEqual([...new Uint8Array(await seg.arrayBuffer())], [...bytes]);
        assert.equal(media.calls.find((c) => c.url === SEG).range, 'bytes=0-7');

        assert.equal((await fetch(`${base}/api/stream/hls?u=${encodeTarget(SEG)}&s=palsu`)).status, 403);
        assert.equal((await fetch(`${base}/api/stream/hls?u=${encodeTarget('https://evil.example/x')}&s=${signer.sign('https://evil.example/y')}`)).status, 403);
        const missing = 'https://suzaku.xin-cdn.xyz/77/tidak-ada.ts';
        assert.equal((await fetch(q(missing))).status, 404);
    });
});

test('GET /api/stream/sub: ASS → VTT; challenge acak diulang; gagal terus → 503', async () => {
    const ASS = 'https://suzaku.xin-cdn.xyz/u/subtitles/8_id.ass';
    const BLOCKED = 'https://suzaku.xin-cdn.xyz/u/subtitles/9_x.ass';
    const challenge = { status: 403, headers: { server: 'cloudflare', 'cf-ray': 'x', 'content-type': 'text/html' }, body: '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>' };
    const assText = '[Script Info]\nPlayResY: 1080\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Halo\n';
    const media = fakeMedia({
        [ASS]: (n) => (n === 1 ? challenge : { headers: { 'content-type': 'text/plain' }, body: assText }),
        [BLOCKED]: () => challenge,
    });
    const signer = createSigner(SECRET);
    const app = createApp({ registry: fakeRegistry(), streams: fakeStreams([]), mediaClient: media, signer, log: false, rateLimitPerMinute: 0, proxyRateLimitPerMinute: 0 });
    // jeda ulang dipercepat lewat router langsung tidak tersedia → cukup terima jeda default (±1,5 dtk + 3 dtk)
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const ok = await fetch(`${base}/api/stream/sub?u=${encodeTarget(ASS)}&f=ass&s=${signer.sign(`${ASS}|ass`)}`);
        assert.equal(ok.status, 200);
        assert.match(ok.headers.get('content-type'), /text\/vtt/);
        assert.match(await ok.text(), /^WEBVTT[\s\S]*00:00:01\.000 --> 00:00:02\.000\nHalo/);
        assert.equal(media.calls.filter((c) => c.url === ASS).length, 2, 'challenge pertama diulang sekali');
        assert.equal((await fetch(`${base}/api/stream/sub?u=${encodeTarget(ASS)}&f=ass&s=${signer.sign(ASS)}`)).status, 403, 'format ikut ditandatangani');
        assert.equal((await fetch(`${base}/api/stream/sub?u=${encodeTarget(ASS)}&f=exe&s=x`)).status, 400);
        const blocked = await fetch(`${base}/api/stream/sub?u=${encodeTarget(BLOCKED)}&f=ass&s=${signer.sign(`${BLOCKED}|ass`)}`);
        assert.equal(blocked.status, 503);
        assert.equal((await blocked.json()).code, 'UPSTREAM_BLOCKED');
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
});

test('GET /api/stream/hls dengan fetcher SUNGGUHAN + upstream lambat: tidak dibatalkan dini, segmen utuh', async () => {
    const { createClient, createNetwork } = await import('../lib/fetcher.js');
    const { startServer } = await import('./helpers.js');
    const seg = Buffer.alloc(200_000, 7);
    const upstream = await startServer((req, res) => {
        setTimeout(() => {
            if (req.url.endsWith('.m3u8')) {
                res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
                res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n');
            } else {
                res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(seg.length) });
                res.write(seg.subarray(0, 100_000));
                setTimeout(() => res.end(seg.subarray(100_000)), 150);
            }
        }, 300); // CDN lambat: request GET kita sudah selesai dibaca jauh sebelum respons datang
    });
    const net = createNetwork({ userAgent: 'KazanimeBot/1.0 (+test)' });
    const media = createClient(net, { source: 'uji-media', allowedHosts: ['127.0.0.1'], robots: false, intervalMs: 0, retries: 0, timeoutMs: 5000 });
    const signer = createSigner(SECRET);
    const app = createApp({ registry: fakeRegistry(), streams: fakeStreams([]), mediaClient: media, signer, log: false, rateLimitPerMinute: 0, proxyRateLimitPerMinute: 0 });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const q = (u) => `${base}/api/stream/hls?u=${encodeTarget(u)}&s=${signer.sign(u)}`;
        const pl = await fetch(q(`${upstream.url}/v/index.m3u8`));
        assert.equal(pl.status, 200);
        const segUri = (await pl.text()).split('\n').find((l) => l.startsWith('/api/stream/hls'));
        assert.ok(segUri, 'URI segmen ditulis ulang');
        const r = await fetch(new URL(segUri, base));
        assert.equal(r.status, 200);
        const body = Buffer.from(await r.arrayBuffer());
        assert.equal(body.length, seg.length, 'segmen utuh (tidak terputus oleh abort dini)');
    } finally {
        server.closeAllConnections?.();
        await new Promise((res) => server.close(res));
        await upstream.close();
    }
});
