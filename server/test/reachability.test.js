import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSite, USER_AGENT } from '../scripts/check-source-reachability.js';

const robotsAllowsRoot = 'User-agent: KazanimeBot\nAllow: /\n';

function scriptedFetch(responses) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        if (!next) throw new Error('Unexpected extra request');
        return new Response(next.body || '', { status: next.status, headers: next.headers || {} });
    };
    return { fetchImpl, calls };
}

test('reachability: one honest-UA robots check then homepage only when explicitly allowed', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        { status: 200, body: robotsAllowsRoot, headers: { 'content-type': 'text/plain' } },
        { status: 200, body: '<html>public homepage</html>', headers: { server: 'example' } },
    ]);

    const result = await checkSite({
        id: 'test-source',
        baseUrl: 'https://example.test',
        fetchImpl,
        minimumIntervalMs: 0,
    });

    assert.equal(result.robots.outcome, 'reachable');
    assert.equal(result.homepage.outcome, 'reachable');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/robots.txt', '/']);
    for (const { init } of calls) {
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'manual');
        assert.equal(init.headers['User-Agent'], USER_AGENT);
        assert.equal(init.headers.Cookie, undefined);
        assert.equal(init.headers['Sec-CH-UA'], undefined);
        assert.equal(init.headers.Referer, undefined);
    }
});

test('reachability: Cloudflare challenge on robots.txt is reported and not retried', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        {
            status: 403,
            body: '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script>',
            headers: { server: 'cloudflare', 'cf-ray': 'abc123' },
        },
    ]);

    const result = await checkSite({ id: 'blocked', baseUrl: 'https://example.test', fetchImpl, minimumIntervalMs: 0 });

    assert.equal(result.robots.outcome, 'cloudflare_challenge');
    assert.equal(result.robots.cfRay, 'abc123');
    assert.equal(result.homepage.skipped, true);
    assert.equal(calls.length, 1);
});

test('reachability: an unreadable robots.txt fails closed without requesting homepage', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 404, body: 'not found' }]);
    const result = await checkSite({ id: 'unverified', baseUrl: 'https://example.test', fetchImpl, minimumIntervalMs: 0 });

    assert.equal(result.robots.outcome, 'http_404');
    assert.equal(result.homepage.reason, 'robots_not_verified');
    assert.equal(calls.length, 1);
});

test('reachability: a robots disallow rule prevents the homepage request', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        { status: 200, body: 'User-agent: *\nDisallow: /\n' },
    ]);
    const result = await checkSite({ id: 'disallowed', baseUrl: 'https://example.test', fetchImpl, minimumIntervalMs: 0 });

    assert.equal(result.homepage.reason, 'robots_disallows_homepage');
    assert.equal(calls.length, 1);
});

test('reachability: challenge on homepage is reported once, without retries', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        { status: 200, body: robotsAllowsRoot },
        {
            status: 403,
            body: '<title>Attention Required! | Cloudflare</title>',
            headers: { server: 'cloudflare', 'cf-ray': 'home-ray' },
        },
    ]);
    const result = await checkSite({ id: 'homepage-blocked', baseUrl: 'https://example.test', fetchImpl, minimumIntervalMs: 0 });

    assert.equal(result.homepage.outcome, 'cloudflare_challenge');
    assert.equal(calls.length, 2, 'robots + one homepage request only');
});

test('reachability: respects robots Crawl-delay and does not follow redirects', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        { status: 200, body: 'User-agent: KazanimeBot\nAllow: /\nCrawl-delay: 3\n' },
        { status: 302, body: '', headers: { location: 'https://elsewhere.test/' } },
    ]);
    let slept = 0;
    const result = await checkSite({
        id: 'delayed',
        baseUrl: 'https://example.test',
        fetchImpl,
        minimumIntervalMs: 0,
        sleepImpl: async (ms) => { slept = ms; },
    });

    assert.equal(slept, 3000);
    assert.equal(result.homepage.outcome, 'redirect_not_followed');
    assert.equal(result.homepage.location, 'https://elsewhere.test/');
    assert.equal(calls.length, 2);
});

test('reachability: only HTTPS targets are accepted', async () => {
    await assert.rejects(
        checkSite({ id: 'insecure', baseUrl: 'http://example.test', fetchImpl: async () => { throw new Error('must not fetch'); } }),
        /HTTPS/,
    );
});
