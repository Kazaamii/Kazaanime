import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRAPER } from '../config.js';
import { createClient, createNetwork, looksLikeChallenge, retryAfterSeconds } from '../lib/fetcher.js';
import { fixture, startServer } from './helpers.js';

/** Konfigurasi cepat untuk test (tanpa jeda panjang). */
const FAST = {
    ...SCRAPER,
    timeoutMs: 800,
    retries: 1,
    minIntervalMs: 0,
    maxQueueWaitMs: 5000,
    robots: { ...SCRAPER.robots, timeoutMs: 800 },
    circuit: { failures: 2, openMs: 60000, blockedMs: 120000 },
};

function setup(routes, { scraper = FAST, robots = true, requireExplicitRobots = false } = {}) {
    const hits = [];
    let srv;
    const ready = startServer((req, res) => {
        hits.push({ url: req.url, ua: req.headers['user-agent'] });
        const route = routes[req.url.split('?')[0]] || routes['*'];
        if (!route) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('nope');
            return;
        }
        route(req, res, hits);
    }).then((s) => {
        srv = s;
        const net = createNetwork({ userAgent: 'KazanimeBot/1.0 (+test)', scraper });
        const client = createClient(net, { source: 'uji', allowedHosts: ['127.0.0.1'], robots, requireExplicitRobots });
        return { srv, net, client, hits, base: s.url };
    });
    return { ready, close: () => srv?.close() };
}

const send = (status, body, headers = {}) => (req, res) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
};

test('fetcher: User-Agent jujur, robots.txt dicek sekali, halaman yang dilarang tidak pernah diminta', async () => {
    const t = setup({
        '/robots.txt': send(200, 'User-agent: KazanimeBot\nDisallow: /rahasia/', { 'content-type': 'text/plain' }),
        '/ok': send(200, '<p>halo</p>'),
        '/rahasia/x': send(200, 'JANGAN'),
    });
    const { client, hits, base } = await t.ready;
    try {
        const r = await client.request(`${base}/ok`);
        assert.equal(r.text, '<p>halo</p>');
        await assert.rejects(client.request(`${base}/rahasia/x`), (e) => e.kind === 'robots');
        await client.request(`${base}/ok?lagi=1`);
        assert.ok(hits.every((h) => h.ua === 'KazanimeBot/1.0 (+test)'), 'semua request memakai UA bot');
        assert.equal(hits.filter((h) => h.url === '/robots.txt').length, 1, 'robots.txt di-cache');
        assert.equal(hits.filter((h) => h.url.startsWith('/rahasia')).length, 0, 'path terlarang tidak diakses');
    } finally {
        await t.close();
    }
});

test('fetcher: 5xx di-retry sekali lalu berhasil; 404 → not_found tanpa retry', async () => {
    let n = 0;
    const t = setup({
        '/robots.txt': send(404, ''),
        '/flaky': (req, res) => { n++; send(n === 1 ? 503 : 200, n === 1 ? 'down' : 'pulih')(req, res); },
        '/hilang': send(404, 'tidak ada'),
    });
    const { client, hits, base } = await t.ready;
    try {
        assert.equal((await client.request(`${base}/flaky`)).text, 'pulih');
        assert.equal(n, 2);
        await assert.rejects(client.request(`${base}/hilang`), (e) => e.kind === 'not_found' && e.status === 404);
        assert.equal(hits.filter((h) => h.url === '/hilang').length, 1);
    } finally {
        await t.close();
    }
});

test('fetcher: halaman blokir Cloudflare → blocked, circuit terbuka, request berikutnya tidak dikirim', async () => {
    const t = setup({
        '/robots.txt': send(200, 'User-agent: *\nDisallow:'),
        '/cf': send(403, fixture('cloudflare-block.html'), { server: 'cloudflare', 'cf-ray': 'abc' }),
    });
    const { client, net, hits, base } = await t.ready;
    try {
        await assert.rejects(client.request(`${base}/cf`), (e) => e.kind === 'blocked' && e.status === 503);
        assert.equal(net.circuit.check('uji').open, true);
        await assert.rejects(client.request(`${base}/cf`), (e) => e.kind === 'blocked');
        assert.equal(hits.filter((h) => h.url === '/cf').length, 1, 'tidak dipaksa mengulang');
    } finally {
        await t.close();
    }
});

test('fetcher: robots.txt diblokir Cloudflare → seluruh sumber blocked (kasus kuramanime)', async () => {
    const t = setup({ '*': send(403, fixture('cloudflare-block.html'), { server: 'cloudflare' }) }, { requireExplicitRobots: true });
    const { client, hits, base } = await t.ready;
    try {
        await assert.rejects(client.request(`${base}/anime?order_by=updated`), (e) => e.kind === 'blocked');
        assert.deepEqual(hits.map((h) => h.url), ['/robots.txt'], 'hanya robots.txt yang sempat diminta');
    } finally {
        await t.close();
    }
});

test('fetcher: ToS belum ditinjau + robots.txt 404 → tidak diakses (policy)', async () => {
    const t = setup({ '/robots.txt': send(404, ''), '/x': send(200, 'isi') }, { requireExplicitRobots: true });
    const { client, hits, base } = await t.ready;
    try {
        await assert.rejects(client.request(`${base}/x`), (e) => e.kind === 'policy');
        assert.equal(hits.filter((h) => h.url === '/x').length, 0);
    } finally {
        await t.close();
    }
});

test('fetcher: timeout tidak di-retry; host lain & redirect ke host lain ditolak', async () => {
    const t = setup({
        '/robots.txt': send(404, ''),
        '/lambat': (req, res) => { setTimeout(() => send(200, 'telat')(req, res), 1500); },
        '/kabur': send(302, '', { location: 'http://localhost:1/luar' }),
    });
    const { client, hits, base } = await t.ready;
    try {
        const t0 = Date.now();
        await assert.rejects(client.request(`${base}/lambat`), (e) => e.kind === 'timeout' && e.status === 504);
        assert.ok(Date.now() - t0 < 1400, 'berhenti di batas timeout');
        assert.equal(hits.filter((h) => h.url === '/lambat').length, 1, 'timeout tidak diulang');
        await assert.rejects(client.request('https://evil.example/x'), (e) => e.kind === 'policy');
        await assert.rejects(client.request(`${base}/kabur`), (e) => e.kind === 'policy' || e.kind === 'network');
    } finally {
        await t.close();
    }
});

test('fetcher: 429 → rate_limited + Retry-After, sumber diistirahatkan', async () => {
    const t = setup({ '/robots.txt': send(404, ''), '/sibuk': send(429, 'pelan-pelan', { 'retry-after': '120' }) });
    const { client, net, base } = await t.ready;
    try {
        await assert.rejects(client.request(`${base}/sibuk`), (e) => e.kind === 'rate_limited' && e.retryAfter === 120);
        assert.equal(net.circuit.check('uji').open, true);
    } finally {
        await t.close();
    }
});

test('fetcher: respons terlalu besar ditolak; deadline total dihormati', async () => {
    const big = 'x'.repeat(4096);
    const t = setup({ '/robots.txt': send(404, ''), '/besar': send(200, big), '/ok': send(200, 'ok') }, { scraper: { ...FAST, maxBodyBytes: 1024 } });
    const { client, base } = await t.ready;
    try {
        await assert.rejects(client.request(`${base}/besar`), (e) => e.kind === 'parse');
        await assert.rejects(client.request(`${base}/ok`, { deadline: Date.now() + 100 }), (e) => e.kind === 'timeout');
    } finally {
        await t.close();
    }
});

test('fetcher: jeda per host (throttle) benar-benar diterapkan', async () => {
    const t = setup({ '/robots.txt': send(404, ''), '/a': send(200, 'a') }, { scraper: { ...FAST, minIntervalMs: 300 } });
    const { client, base } = await t.ready;
    try {
        await client.request(`${base}/a`); // robots + /a
        const t0 = Date.now();
        await client.request(`${base}/a`);
        await client.request(`${base}/a`);
        assert.ok(Date.now() - t0 >= 550, `dua request beruntun berjarak ≥ 300 ms (aktual ${Date.now() - t0} ms)`);
    } finally {
        await t.close();
    }
});

test('looksLikeChallenge & retryAfterSeconds', () => {
    const h = (o) => new Headers(o);
    assert.equal(looksLikeChallenge({ status: 403, headers: h({ server: 'cloudflare' }), text: fixture('cloudflare-block.html') }), true);
    assert.equal(looksLikeChallenge({ status: 503, headers: h({ 'cf-ray': '1' }), text: '<title>Just a moment...</title>' }), true);
    assert.equal(looksLikeChallenge({ status: 200, headers: h({ 'cf-mitigated': 'challenge' }), text: '' }), true);
    assert.equal(looksLikeChallenge({ status: 403, headers: h({ server: 'nginx' }), text: 'Forbidden' }), false);
    assert.equal(looksLikeChallenge({ status: 200, headers: h({ server: 'cloudflare' }), text: 'Just a moment... (konten biasa)' }), false);
    assert.equal(retryAfterSeconds('120'), 120);
    assert.equal(retryAfterSeconds(''), 0);
    assert.ok(retryAfterSeconds(new Date(Date.now() + 5000).toUTCString()) >= 4);
});
