import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetch as undiciFetch, Agent } from 'undici';
import { BrowserAutomation } from '../lib/browser-automation.js';
import { createClient, createNetwork } from '../lib/fetcher.js';
import { CookieManager } from '../lib/cookie-manager.js';
import { FingerprintManager } from '../lib/fingerprint-manager.js';
import { ProxyManager, ProxyUnavailableError } from '../lib/proxy-manager.js';
import { RequestManager } from '../lib/request-manager.js';
import { HostThrottle } from '../lib/rate-limit.js';
import { TtlCache } from '../lib/cache.js';
import { SCRAPER, SCRAPER_RUNTIME, SOURCES } from '../config.js';
import { FACTORIES, createRegistry } from '../sources/index.js';

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(server.address().port);
        });
    });
}

function createSocks5Proxy(connectPort, seenHosts) {
    return net.createServer((client) => {
        let buffer = Buffer.alloc(0);
        let state = 'greeting';
        let upstream;
        client.on('data', (chunk) => {
            if (state === 'tunnel') return;
            buffer = Buffer.concat([buffer, chunk]);
            if (state === 'greeting') {
                if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
                const methodCount = buffer[1];
                const methods = buffer.subarray(2, 2 + methodCount);
                buffer = buffer.subarray(2 + methodCount);
                if (!methods.includes(0)) { client.end(Buffer.from([5, 255])); return; }
                client.write(Buffer.from([5, 0]));
                state = 'request';
            }
            if (state !== 'request' || buffer.length < 4) return;
            const addressType = buffer[3];
            let host;
            let offset;
            if (addressType === 1) {
                if (buffer.length < 10) return;
                host = [...buffer.subarray(4, 8)].join('.');
                offset = 8;
            } else if (addressType === 3) {
                if (buffer.length < 5 + buffer[4] + 2) return;
                const length = buffer[4];
                host = buffer.subarray(5, 5 + length).toString('utf8');
                offset = 5 + length;
            } else if (addressType === 4) {
                if (buffer.length < 22) return;
                host = [...Array(8)].map((_, i) => buffer.readUInt16BE(4 + i * 2).toString(16)).join(':');
                offset = 20;
            } else {
                client.destroy();
                return;
            }
            const port = buffer.readUInt16BE(offset);
            const rest = buffer.subarray(offset + 2);
            buffer = Buffer.alloc(0);
            state = 'tunnel';
            seenHosts.push({ host, port });
            upstream = net.connect(connectPort, '127.0.0.1', () => {
                client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                if (rest.length) upstream.write(rest);
                client.pipe(upstream);
                upstream.pipe(client);
            });
            upstream.on('error', () => client.destroy());
            client.on('error', () => upstream.destroy());
        });
    });
}

function cookieHeaders() {
    const headers = new Headers();
    headers.append('set-cookie', 'sid=private-session-value; Path=/; HttpOnly; Secure; SameSite=Lax');
    headers.append('set-cookie', 'anime-pref=private-domain-value; Domain=example.test; Path=/anime; Secure');
    return headers;
}

test('config runtime: sumber default & mode robots yang eksplisit', () => {
    // 24 Okt 2026: Samehadaku/Otakudesu/Sakunime tidak lagi aktif default,
    // tetapi factory-nya tetap tersedia untuk diaktifkan lewat SCRAPER_SOURCES.
    // Putaran 20: Kuramanime & Anichin dihapus total (factory + config tidak ada lagi).
    assert.equal(SOURCES.enabled.includes('samehadaku'), false);
    assert.equal(SOURCES.enabled.includes('otakudesu'), false);
    assert.equal(SOURCES.enabled.includes('sakunime'), false);
    assert.equal(SOURCES.enabled.includes('kuramanime'), false);
    assert.equal(SOURCES.enabled.includes('anichin'), false);
    assert.ok(SOURCES.enabled.includes('anoboy'));
    assert.ok(SOURCES.enabled.includes('animeku'));
    assert.ok(SOURCES.enabled.includes('oploverz'));
    assert.ok(FACTORIES.anoboy);
    assert.ok(FACTORIES.sakunime);
    assert.ok(FACTORIES.samehadaku);
    assert.ok(FACTORIES.otakudesu);
    for (const gone of ['kuramanime', 'anichin']) {
        assert.equal(FACTORIES[gone], undefined, `${gone} masih punya factory`);
        assert.equal(Object.hasOwn(SOURCES, gone), false, `${gone} masih punya konfigurasi`);
    }
    assert.equal(SOURCES.samehadaku.renderJavaScript, false);
    assert.equal(SOURCES.otakudesu.renderJavaScript, false);
    assert.equal(SOURCES.anoboy.baseUrl, 'https://anoboy.be');
    assert.equal(SOURCES.sakunime.baseUrl, 'https://sakunime.com');
    assert.ok(Object.isFrozen(SCRAPER_RUNTIME.proxy.urls));
    assert.ok(SCRAPER_RUNTIME.request.maxConcurrencyPerHost >= 1);
    // 23 Okt 2026: gerbang robots.txt dibuat eksplisit & dapat diubah lewat env (default 'off').
    assert.ok(['enforce', 'warn', 'off'].includes(SCRAPER.robots.mode));
    assert.equal(SCRAPER.robots.mode, 'off');
});

test('health diagnostic merangkum proxy/cookie/browser tanpa URL proxy, kredensial, atau cookie', () => {
    const proxyManager = new ProxyManager({
        urls: ['http://diagnostic-user:diagnostic-password@proxy.private.test:8080'],
        healthCheck: false,
    });
    const network = createNetwork({ proxyManager });
    const registry = createRegistry({
        adapters: [{
            id: 'source-test', name: 'Test source',
            baseUrl: 'https://source-user:source-password@source.private.test/private-path?token=source-token',
            policy: { tos: { verdict: 'unknown' } },
        }],
        network,
    });
    const health = registry.health();
    assert.ok(health.runtime.requests);
    assert.ok(health.runtime.proxies);
    assert.ok(health.runtime.cookies);
    assert.ok(health.runtime.browser);
    const output = JSON.stringify(health);
    assert.doesNotMatch(output, /diagnostic-user|diagnostic-password|proxy\.private\.test/);
    assert.doesNotMatch(output, /source-user|source-password|source-token|private-path/);
    assert.ok(output.includes('https://source.private.test'));
    assert.doesNotMatch(output, /private-session-value/);
    assert.equal(health.runtime.proxies.configured, 1);
});

test('ProxyManager: round-robin, sticky per sumber, diagnostik tidak membocorkan userinfo, fallback langsung ditolak', async () => {
    const manager = new ProxyManager({
        urls: [
            'http://user%40name:secret%3Apass@127.0.0.1:8080',
            'socks5h://socks-user:socks-pass@127.0.0.1:1080',
        ],
        healthCheck: false,
        rotation: 'round-robin',
        makeDispatcher: () => ({ close: async () => {} }),
    });
    try {
        const first = await manager.select({ source: 'samehadaku' });
        const second = await manager.select({ source: 'otakudesu' });
        assert.equal(first.id, 'proxy-1');
        assert.equal(second.id, 'proxy-2');
        assert.deepEqual(manager.browserProxy(first), {
            server: 'http://127.0.0.1:8080', username: 'user@name', password: 'secret:pass',
        });
        const serialized = JSON.stringify(manager.snapshot());
        assert.doesNotMatch(serialized, /secret|user%40name|socks-pass/i);
        assert.equal(manager.snapshot().configured, 2);
    } finally {
        await manager.close();
    }

    const sticky = new ProxyManager({ urls: ['http://one.test:8080', 'http://two.test:8080'], healthCheck: false, rotation: 'sticky' });
    assert.equal((await sticky.select({ source: 'samehadaku' })).id, (await sticky.select({ source: 'samehadaku' })).id);
    assert.notEqual((await sticky.select({ source: 'otakudesu' })).id, '');

    const unavailable = new ProxyManager({
        urls: ['http://proxy.test:8080'],
        healthCheck: true,
        probe: async () => false,
    });
    await assert.rejects(unavailable.select({ source: 'samehadaku' }), (error) => error instanceof ProxyUnavailableError && error.retryAfter >= 1);
});

test('ProxyManager: request timeout menurunkan proxy dan sticky beralih tanpa direct fallback', async () => {
    const selected = [];
    const proxyManager = new ProxyManager({
        urls: ['http://one.test:8080', 'http://two.test:8080'],
        healthCheck: false,
        rotation: 'sticky',
        makeDispatcher: (proxy) => ({ proxyId: proxy.id, close: async () => {} }),
    });
    const network = createNetwork({
        proxyManager,
        fetchImpl: async (_url, init) => {
            selected.push(init.dispatcher.proxyId);
            if (selected.length === 1) {
                return new Promise((_resolve, reject) => {
                    const keepAlive = setTimeout(() => reject(new Error('timeout signal did not abort')), 500);
                    const finish = () => { clearTimeout(keepAlive); reject(init.signal.reason); };
                    if (init.signal.aborted) return finish();
                    init.signal.addEventListener('abort', finish, { once: true });
                });
            }
            return new Response('recovered');
        },
    });
    const client = createClient(network, {
        source: 'timeout-rotation', allowedHosts: ['upstream.test'], robots: false,
        retries: 0, timeoutMs: 20, intervalMs: 0,
    });
    try {
        await assert.rejects(client.request('https://upstream.test/first'), (error) => error.kind === 'timeout');
        const result = await client.request('https://upstream.test/second');
        assert.equal(result.text, 'recovered');
        assert.deepEqual(selected, ['proxy-1', 'proxy-2']);
    } finally {
        await proxyManager.close();
    }
});

test('ProxyManager: Undici ProxyAgent mengirim HTTP request lewat proxy operator', async () => {
    const target = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('target-ok');
    });
    let observedTarget = '';
    let observedProxyAuthorization = '';
    const proxy = http.createServer((req, res) => {
        observedTarget = req.url;
        observedProxyAuthorization = req.headers['proxy-authorization'] || '';
        const targetUrl = new URL(req.url);
        const upstream = http.request({
            hostname: targetUrl.hostname, port: targetUrl.port, path: `${targetUrl.pathname}${targetUrl.search}`,
            method: req.method, headers: req.headers,
        }, (upstreamResponse) => {
            res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
            upstreamResponse.pipe(res);
        });
        req.pipe(upstream);
        upstream.on('error', () => { res.writeHead(502); res.end(); });
    });
    proxy.on('connect', (req, clientSocket, head) => {
        observedTarget = req.url;
        const upstream = net.connect(target.address().port, '127.0.0.1', () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            clientSocket.pipe(upstream);
            upstream.pipe(clientSocket);
        });
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
    });
    const targetPort = await listen(target);
    const proxyPort = await listen(proxy);
    const manager = new ProxyManager({ urls: [`http://proxy%40user:secret%3Apass@127.0.0.1:${proxyPort}`], healthCheck: false });
    try {
        const health = await manager.healthCheckAll({ force: true });
        assert.equal(health.configured, 1);
        assert.equal(health.healthy, 1);
        assert.equal(health.proxies[0].state, 'healthy');
        const lease = await manager.select({ source: 'samehadaku' });
        assert.deepEqual(manager.browserProxy(lease), {
            server: `http://127.0.0.1:${proxyPort}`, username: 'proxy@user', password: 'secret:pass',
        });
        const response = await undiciFetch(`http://127.0.0.1:${targetPort}/check`, { dispatcher: manager.dispatcher(lease) });
        assert.equal(await response.text(), 'target-ok');
        assert.equal(observedTarget, `http://127.0.0.1:${targetPort}/check`);
        assert.equal(observedProxyAuthorization, `Basic ${Buffer.from('proxy@user:secret:pass').toString('base64')}`);
    } finally {
        await manager.close();
        await new Promise((resolve) => proxy.close(resolve));
        await new Promise((resolve) => target.close(resolve));
    }
});

test('ProxyManager: SOCKS5h Undici dispatcher memakai DNS proxy-side; SOCKS4a tidak diteruskan ke Playwright', async () => {
    const target = http.createServer((_req, res) => res.end('socks-target-ok'));
    const targetPort = await listen(target);
    const seenHosts = [];
    const socksServer = createSocks5Proxy(targetPort, seenHosts);
    const socksPort = await listen(socksServer);
    const manager = new ProxyManager({ urls: [`socks5h://user:pass@127.0.0.1:${socksPort}`], healthCheck: false });
    try {
        const lease = await manager.select({ source: 'samehadaku' });
        const dispatcher = manager.dispatcher(lease);
        assert.ok(dispatcher instanceof Agent);
        assert.deepEqual(manager.browserProxy(lease), {
            server: `socks5://127.0.0.1:${socksPort}`, username: 'user', password: 'pass',
        });
        const response = await undiciFetch(`http://target.test:${targetPort}/socks`, { dispatcher });
        assert.equal(await response.text(), 'socks-target-ok');
        assert.deepEqual(seenHosts, [{ host: 'target.test', port: targetPort }]);

        const lookups = [];
        const localDns = new ProxyManager({
            urls: [`socks5://127.0.0.1:${socksPort}`], healthCheck: false,
            lookup: async (hostname, options) => {
                lookups.push({ hostname, options });
                return { address: '127.0.0.1', family: 4 };
            },
        });
        try {
            const localLease = await localDns.select({ source: 'samehadaku' });
            const localResponse = await undiciFetch(`http://target.test:${targetPort}/local-dns`, {
                dispatcher: localDns.dispatcher(localLease),
            });
            assert.equal(await localResponse.text(), 'socks-target-ok');
            assert.deepEqual(lookups, [{ hostname: 'target.test', options: { verbatim: true } }]);
            assert.deepEqual(seenHosts[1], { host: '127.0.0.1', port: targetPort });
        } finally {
            await localDns.close();
        }
    } finally {
        await manager.close();
        await new Promise((resolve) => socksServer.close(resolve));
        await new Promise((resolve) => target.close(resolve));
    }

    const socks4a = new ProxyManager({ urls: ['socks4a://proxy.test:1080'], healthCheck: false });
    await assert.rejects(Promise.resolve().then(async () => socks4a.browserProxy(await socks4a.select())), /SOCKS5 proxy/);
});

test('fetcher: redirect divalidasi per hop, cookies dihitung ulang, header rahasia tidak menyeberang origin', async () => {
    const seen = [];
    const proxyManager = new ProxyManager({ urls: [], healthCheck: false });
    const network = createNetwork({
        proxyManager,
        fetchImpl: async (url, init) => {
            seen.push({ url, headers: new Headers(init.headers), method: init.method, body: init.body });
            if (url === 'https://source.example/start') {
                return new Response(null, { status: 302, headers: { location: 'https://alias.example/final' } });
            }
            if (url === 'https://source.example/post') {
                return new Response(null, { status: 307, headers: { location: 'https://alias.example/receive' } });
            }
            return new Response('redirect-ok', { status: 200 });
        },
    });
    const client = createClient(network, {
        source: 'redirect-test', allowedHosts: ['source.example', 'alias.example'],
        robots: false, intervalMs: 0, retries: 0, timeoutMs: 1000,
    });
    const result = await client.request('https://source.example/start', {
        headers: {
            Authorization: 'Bearer private-token',
            'x-goog-api-key': 'private-api-key',
            Cookie: 'manual=private-cookie',
            Referer: 'https://source.example/page?token=private-referer-token',
        },
    });
    assert.equal(result.text, 'redirect-ok');
    assert.equal(seen.length, 2);
    assert.equal(seen[1].url, 'https://alias.example/final');
    assert.equal(seen[1].headers.has('authorization'), false);
    assert.equal(seen[1].headers.has('x-goog-api-key'), false);
    assert.equal(seen[1].headers.has('cookie'), false);
    assert.equal(seen[1].headers.has('referer'), false);
    await assert.rejects(client.request('https://source.example/post', { method: 'POST', body: 'private-payload' }), (error) => error.kind === 'policy');
    assert.equal(seen.length, 3, 'redirect ber-body lintas origin tidak pernah diikuti');
    assert.equal(JSON.stringify(seen.map((item) => item.url)).includes('private-token'), false);
});

test('CookieManager: jar terisolasi per sumber, host/path/domain mengikuti tough-cookie, browser cookies disimpan', async () => {
    const manager = new CookieManager({ enabled: true });
    assert.equal(await manager.storeResponse('samehadaku', 'https://www.example.test/anime/1', cookieHeaders()), true);
    assert.equal(await manager.getCookieHeader('samehadaku', 'https://www.example.test/anime/2'), 'anime-pref=private-domain-value; sid=private-session-value');
    assert.equal(await manager.getCookieHeader('samehadaku', 'https://www.example.test/'), 'sid=private-session-value');
    assert.equal(await manager.getCookieHeader('samehadaku', 'https://cdn.example.test/anime/2'), 'anime-pref=private-domain-value');
    assert.equal(await manager.getCookieHeader('otakudesu', 'https://www.example.test/anime/2'), '');
    assert.equal(await manager.getCookieHeader('samehadaku', 'https://unrelated.test/anime/2'), '');

    assert.equal(await manager.storeBrowserCookies('samehadaku', 'https://www.example.test/', [{
        name: 'browser-session', value: 'browser-private-value', domain: '.example.test', path: '/',
        expires: -1, httpOnly: true, secure: true, sameSite: 'Lax',
    }]), true);
    assert.match(await manager.getCookieHeader('samehadaku', 'https://www.example.test/'), /browser-session=browser-private-value/);
    const browserCookies = await manager.getCookiesForBrowser('samehadaku', 'https://www.example.test/');
    assert.ok(browserCookies.some((cookie) => cookie.name === 'sid' && cookie.httpOnly && cookie.secure));
    assert.equal(JSON.stringify(manager.snapshot()).includes('private-session-value'), false);
});

test('CookieManager: persistensi AES-GCM, mode file privat, reload berhasil, key salah fail-closed tanpa bocor rahasia', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'kazanime-cookie-test-'));
    const storePath = path.join(folder, 'cookies.enc');
    const key = 'test-encryption-key-do-not-use-in-production-32';
    const warnings = [];
    try {
        const first = new CookieManager({ enabled: true, encryptionKey: key, storePath, logger: { warn: (message) => warnings.push(message) } });
        await first.storeResponse('samehadaku', 'https://www.example.test/', cookieHeaders());
        const encrypted = await readFile(storePath, 'utf8');
        assert.doesNotMatch(encrypted, /private-session-value|anime-pref/);
        assert.equal((await stat(storePath)).mode & 0o777, 0o600);

        const second = new CookieManager({ enabled: true, encryptionKey: key, storePath, logger: { warn: (message) => warnings.push(message) } });
        assert.match(await second.getCookieHeader('samehadaku', 'https://www.example.test/'), /sid=private-session-value/);
        assert.equal(second.snapshot().persistent, true);

        const wrongKey = new CookieManager({ enabled: true, encryptionKey: 'wrong-key-'.repeat(4), storePath, logger: { warn: (message) => warnings.push(message) } });
        assert.equal(await wrongKey.getCookieHeader('samehadaku', 'https://www.example.test/'), '');
        assert.equal(wrongKey.snapshot().persistent, false);
        assert.equal(warnings.length, 1);
        assert.doesNotMatch(warnings.join('\n'), /private-session-value|wrong-key|test-encryption-key/);
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});

test('CookieManager: key pendek menonaktifkan persistensi terenkripsi', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'kazanime-cookie-test-'));
    const warnings = [];
    try {
        const manager = new CookieManager({
            enabled: true,
            encryptionKey: 'too-short',
            storePath: path.join(folder, 'cookies.enc'),
            logger: { warn: (message) => warnings.push(message) },
        });
        await manager.getCookieHeader('samehadaku', 'https://example.test/');
        assert.equal(manager.snapshot().persistent, false);
        assert.equal(warnings.length, 1);
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});

test('RequestManager: semaphore membatasi concurrency per host, host berbeda independen, cache dedupe', async () => {
    const manager = new RequestManager({
        throttle: new HostThrottle({ intervalMs: 0, maxWaitMs: 500 }),
        cache: new TtlCache(),
        maxConcurrencyPerHost: 1,
        maxQueueWaitMs: 500,
    });
    const active = new Map();
    const peaks = new Map();
    const run = (host) => manager.run(host, { source: host }, async () => {
        const count = (active.get(host) || 0) + 1;
        active.set(host, count);
        peaks.set(host, Math.max(peaks.get(host) || 0, count));
        await new Promise((resolve) => setTimeout(resolve, 15));
        active.set(host, active.get(host) - 1);
    });
    await Promise.all([run('one.example'), run('one.example'), run('two.example')]);
    assert.equal(peaks.get('one.example'), 1);
    assert.equal(peaks.get('two.example'), 1);
    assert.equal(manager.snapshot().hosts['one.example'].active, 0);
    assert.equal(manager.snapshot().hosts['one.example'].queued, 0);

    let producers = 0;
    const [a, b] = await Promise.all([
        manager.cached('same-key', { ttl: 1000 }, async () => { producers++; return 'cached'; }),
        manager.cached('same-key', { ttl: 1000 }, async () => { producers++; return 'cached'; }),
    ]);
    assert.equal(a.value, 'cached');
    assert.equal(b.value, 'cached');
    assert.equal(producers, 1);
});

test('FingerprintManager: profil stabil dan transparan, viewport dibatasi', () => {
    const manager = new FingerprintManager({ userAgent: 'KazanimeBot/1.0 (+https://example.test/bot)', viewport: { width: 10, height: 9000 } });
    const first = manager.contextOptions('samehadaku');
    const second = manager.contextOptions('otakudesu');
    assert.equal(first.userAgent, 'KazanimeBot/1.0 (+https://example.test/bot)');
    assert.equal(first.locale, 'id-ID');
    assert.equal(first.timezoneId, 'Asia/Jakarta');
    assert.deepEqual(first.viewport, { width: 1280, height: 800 });
    assert.deepEqual(first, second);
    assert.deepEqual(manager.snapshot(), {
        policy: 'stable-transparent', userAgent: 'KazanimeBot/1.0', locale: 'id-ID', timezoneId: 'Asia/Jakarta', viewport: { width: 1280, height: 800 },
    });
});

test('BrowserAutomation: optional, hanya host allowlist, cookie jar per sumber, konteks transparan, selalu ditutup', async () => {
    let launchOptions;
    let contextOptions;
    let addedCookies = [];
    let routeHandler;
    const routeActions = [];
    let browserClosed = false;
    let contextClosed = false;
    const checkedResources = [];
    const acquiredResources = [];
    let releasedRequests = 0;
    const targetUrl = 'https://samehadaku.example.test/anime/1';
    const page = {
        setDefaultNavigationTimeout() {},
        setDefaultTimeout() {},
        async route(_pattern, handler) { routeHandler = handler; },
        async goto(url) {
            for (const resource of [url, 'https://samehadaku.example.test/app.js', 'https://tracker.evil.test/pixel', 'https://user:secret@samehadaku.example.test/private']) {
                await routeHandler({
                    request: () => ({ url: () => resource }),
                    continue: async () => routeActions.push(['continue', resource]),
                    abort: async () => routeActions.push(['abort', resource]),
                });
            }
            return { status: () => 200, allHeaders: async () => ({ 'content-type': 'text/html' }) };
        },
        url: () => targetUrl,
        async waitForTimeout() {},
        async content() { return '<html><body>rendered</body></html>'; },
        async close() {},
    };
    const context = {
        async addCookies(cookies) { addedCookies = cookies; },
        async newPage() { return page; },
        async cookies() { return [{ name: 'session', value: 'cookie-secret', domain: '.samehadaku.example.test', path: '/', expires: -1 }]; },
        async close() { contextClosed = true; },
    };
    const browser = {
        async newContext(options) { contextOptions = options; return context; },
        async close() { browserClosed = true; },
    };
    const manager = new BrowserAutomation({
        enabled: true,
        settleMs: 0,
        fingerprintManager: new FingerprintManager({ userAgent: 'KazanimeBot/1.0 (+test)' }),
        cookieManager: {
            async getCookiesForBrowser(source, url) {
                assert.equal(source, 'samehadaku');
                assert.equal(url, targetUrl);
                return [{ name: 'existing', value: 'existing-secret', domain: '.samehadaku.example.test', path: '/' }];
            },
        },
        proxyManager: { browserProxy: () => ({ server: 'http://proxy.test:8080', username: 'proxy-user', password: 'proxy-secret' }) },
        requestManager: {
            async acquire(host, options) {
                acquiredResources.push({ host, options });
                return () => { releasedRequests++; };
            },
        },
        robots: {
            async check(url, options) {
                checkedResources.push({ url, options });
                return { allowed: true, crawlDelayMs: 1500 };
            },
        },
        loadPlaywright: async () => ({ chromium: { launch: async (options) => { launchOptions = options; return browser; } } }),
    });
    const result = await manager.render({
        source: 'samehadaku', url: targetUrl, allowedHosts: ['samehadaku.example.test'], timeoutMs: 2000, maxBytes: 1000,
        proxy: { id: 'proxy-1' }, intervalMs: 1000, checkRobots: true,
    });
    assert.equal(result.status, 200);
    assert.match(result.text, /rendered/);
    assert.deepEqual(addedCookies.map((cookie) => cookie.name), ['existing']);
    assert.equal(contextOptions.userAgent, 'KazanimeBot/1.0 (+test)');
    assert.equal(launchOptions.proxy.password, 'proxy-secret');
    assert.deepEqual(routeActions.map((action) => action[0]), ['continue', 'continue', 'abort', 'abort']);
    assert.deepEqual(checkedResources.map((item) => new URL(item.url).pathname), ['/anime/1', '/app.js']);
    assert.equal(acquiredResources.length, 2);
    assert.ok(acquiredResources.every((item) => item.options.intervalMs === 1500));
    assert.equal(releasedRequests, 2);
    assert.equal(browserClosed, true);
    assert.equal(contextClosed, true);
    assert.deepEqual(manager.snapshot(), { enabled: true, state: 'idle', renderer: 'playwright-core', challengeFallback: false });
});

test('BrowserAutomation: disabled or disallowed hosts fail before loading Playwright', async () => {
    let loads = 0;
    const disabled = new BrowserAutomation({ enabled: false, loadPlaywright: async () => { loads++; return {}; } });
    await assert.rejects(disabled.render({ source: 'samehadaku', url: 'https://example.test/', allowedHosts: ['example.test'], timeoutMs: 1000, maxBytes: 1000 }), (error) => error.kind === 'disabled');
    const enabled = new BrowserAutomation({ enabled: true, loadPlaywright: async () => { loads++; return {}; } });
    await assert.rejects(enabled.render({ source: 'samehadaku', url: 'https://evil.test/', allowedHosts: ['example.test'], timeoutMs: 1000, maxBytes: 1000 }), (error) => error.kind === 'policy');
    assert.equal(loads, 0);
});

test('BrowserAutomation: launch error maps to disabled without exposing executable path/error text', async () => {
    const manager = new BrowserAutomation({
        enabled: true,
        executablePath: '/private/browser/path',
        loadPlaywright: async () => ({ chromium: { launch: async () => { throw new Error('secret launch detail'); } } }),
    });
    await assert.rejects(manager.render({
        source: 'samehadaku', url: 'https://samehadaku.example.test/', allowedHosts: ['samehadaku.example.test'],
        timeoutMs: 1000, maxBytes: 1000,
    }), (error) => error.kind === 'disabled'
        && !error.message.includes('/private/browser/path')
        && !error.message.includes('secret launch detail'));
    assert.deepEqual(manager.snapshot(), { enabled: true, state: 'idle', renderer: 'playwright-core', challengeFallback: false });
});
