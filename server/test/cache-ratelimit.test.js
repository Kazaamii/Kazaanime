import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../lib/cache.js';
import { CircuitBreaker, HostThrottle, ipRateLimit } from '../lib/rate-limit.js';

function clock(start = 1000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

test('TtlCache: TTL kedaluwarsa & LRU membatasi jumlah entri', () => {
    const c = clock();
    const cache = new TtlCache({ max: 2, now: c.now });
    cache.set('a', 1, 100);
    cache.set('b', 2, 100);
    assert.equal(cache.get('a'), 1); // a jadi paling baru dipakai
    cache.set('c', 3, 100);          // b dibuang (paling lama tidak dipakai)
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 1);
    c.advance(101);
    assert.equal(cache.get('a'), undefined);
});

test('TtlCache.wrap: request identik bersamaan hanya menjalankan producer sekali', async () => {
    const cache = new TtlCache();
    let runs = 0;
    const producer = async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return 'v'; };
    const [a, b] = await Promise.all([cache.wrap('k', { ttl: 1000 }, producer), cache.wrap('k', { ttl: 1000 }, producer)]);
    assert.equal(runs, 1);
    assert.equal(a.value, 'v');
    assert.equal(b.value, 'v');
    const c2 = await cache.wrap('k', { ttl: 1000 }, producer);
    assert.equal(c2.cache, 'hit');
    assert.equal(runs, 1);
});

test('TtlCache.wrap: stale-if-error memakai data lama, lalu error bila jendela stale habis', async () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now });
    await cache.wrap('k', { ttl: 100, stale: 1000 }, async () => 'lama');
    c.advance(200);
    const r = await cache.wrap('k', { ttl: 100, stale: 1000 }, async () => { throw new Error('sumber mati'); });
    assert.equal(r.cache, 'stale');
    assert.equal(r.value, 'lama');
    assert.equal(r.error.message, 'sumber mati');
    c.advance(2000);
    await assert.rejects(cache.wrap('k', { ttl: 100, stale: 1000 }, async () => { throw new Error('tetap mati'); }), /tetap mati/);
});

test('TtlCache.wrap: TTL bisa berupa fungsi (mis. "tidak ditemukan" di-cache singkat); force melewati cache', async () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now });
    await cache.wrap('nf', { ttl: (v) => (v === 'NF' ? 50 : 1000) }, async () => 'NF');
    c.advance(60);
    assert.equal(cache.get('nf'), undefined);
    let runs = 0;
    await cache.wrap('x', { ttl: 1000 }, async () => ++runs);
    const r = await cache.wrap('x', { ttl: 1000, force: true }, async () => ++runs);
    assert.equal(r.value, 2);
});

test('HostThrottle: jeda minimal per host, host lain tidak ikut menunggu, antrean penuh ditolak', async () => {
    const c = clock(0);
    const waits = [];
    const th = new HostThrottle({ intervalMs: 1000, maxWaitMs: 2500, now: c.now, wait: async (ms) => { waits.push(ms); } });
    await th.acquire('a.test');
    await th.acquire('a.test');
    await th.acquire('b.test');
    await th.acquire('a.test');
    assert.deepEqual(waits, [1000, 2000]);
    await assert.rejects(th.acquire('a.test'), (err) => err.kind === 'rate_limited' && err.retryAfter === 3);
    th.setHostInterval('c.test', 5000); // Crawl-delay
    await th.acquire('c.test');
    await th.acquire('c.test', { intervalMs: 1000 }).catch(() => {});
    assert.equal(th.intervalFor('c.test', 1000), 5000);
});

test('CircuitBreaker: terbuka setelah N gagal, langsung terbuka bila diblokir, tertutup lagi setelah sukses', () => {
    const c = clock();
    const cb = new CircuitBreaker({ failures: 2, openMs: 1000, now: c.now });
    cb.failure('s');
    assert.equal(cb.check('s').open, false);
    cb.failure('s', { reason: 'timeout' });
    assert.deepEqual(cb.check('s'), { open: true, retryAfter: 1, reason: 'timeout' });
    c.advance(1001);
    assert.equal(cb.check('s').open, false);
    cb.success('s');
    cb.failure('s', { reason: 'blocked', immediate: true, openMs: 60000 });
    assert.equal(cb.check('s').open, true);
    assert.equal(cb.snapshot().s.state, 'open');
});

test('ipRateLimit: batas per IP per menit → 429 + Retry-After', () => {
    const c = clock();
    const mw = ipRateLimit({ limit: 2, windowMs: 60000, now: c.now });
    const run = (ip) => {
        const headers = {};
        let status = 200;
        let body = null;
        let passed = false;
        const res = {
            set: (k, v) => { headers[k] = v; return res; },
            status: (s) => { status = s; return res; },
            json: (b) => { body = b; return res; },
        };
        mw({ headers: { 'x-real-ip': ip }, socket: {} }, res, () => { passed = true; });
        return { headers, status, body, passed };
    };
    assert.equal(run('1.1.1.1').passed, true);
    assert.equal(run('1.1.1.1').passed, true);
    const blocked = run('1.1.1.1');
    assert.equal(blocked.passed, false);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'RATE_LIMITED');
    assert.equal(blocked.headers['Retry-After'], '60');
    assert.equal(run('2.2.2.2').passed, true, 'IP lain tidak terpengaruh');
    c.advance(60001);
    assert.equal(run('1.1.1.1').passed, true, 'jendela baru');
});
