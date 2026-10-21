import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, parseRobots, rulesFor, RobotsGate } from '../lib/robots.js';
import { fixture } from './helpers.js';

const TXT = `
# komentar
User-agent: *
Disallow: /private/
Allow: /private/public-page
Disallow: /*.php$
Disallow: /search?*sort=
Crawl-delay: 2

User-agent: KazanimeBot
User-agent: OtherBot
Disallow: /anime/
Allow: /anime/$
Allow: /anime/*/info

Sitemap: https://contoh.test/sitemap.xml
`;

test('robots: grup KazanimeBot dipilih (bukan *), multi user-agent dalam satu grup', () => {
    const r = rulesFor(parseRobots(TXT), 'KazanimeBot/1.0');
    assert.equal(r.group, 'specific');
    assert.equal(r.crawlDelay, null);
    assert.equal(isAllowed(r.rules, '/anime/naruto'), false);
    assert.equal(isAllowed(r.rules, '/anime/'), true, '$ = hanya /anime/ persis');
    assert.equal(isAllowed(r.rules, '/anime/naruto/info'), true, 'Allow lebih panjang menang');
    assert.equal(isAllowed(r.rules, '/private/x'), true, 'aturan grup * tidak berlaku untuk grup spesifik');
});

test('robots: grup * + longest match + wildcard + $ + query', () => {
    const r = rulesFor(parseRobots(TXT), 'BotLain');
    assert.equal(r.group, '*');
    assert.equal(r.crawlDelay, 2);
    assert.equal(isAllowed(r.rules, '/private/secret'), false);
    assert.equal(isAllowed(r.rules, '/private/public-page'), true);
    assert.equal(isAllowed(r.rules, '/index.php'), false);
    assert.equal(isAllowed(r.rules, '/index.php?x=1'), true, '$ tidak cocok bila ada query');
    assert.equal(isAllowed(r.rules, '/search?q=a&sort=new'), false);
    assert.equal(isAllowed(r.rules, '/search?q=a'), true);
    assert.equal(isAllowed(r.rules, '/robots.txt'), true);
});

test('robots: Disallow kosong = semua boleh (robots.txt asli animexin)', () => {
    const r = rulesFor(parseRobots(fixture('animexin-robots.txt')), 'KazanimeBot');
    assert.equal(r.group, '*');
    assert.equal(isAllowed(r.rules, '/'), true);
    assert.equal(isAllowed(r.rules, '/?s=soul+land'), true);
    assert.equal(isAllowed(r.rules, '/anime/?order=update'), true);
});

test('robots: seri panjang → Allow menang; Disallow: / memblokir semua', () => {
    assert.equal(isAllowed([{ allow: false, pattern: '/a' }, { allow: true, pattern: '/a' }], '/a/b'), true);
    const all = rulesFor(parseRobots('User-agent: KazanimeBot\nDisallow: /'), 'KazanimeBot');
    assert.equal(isAllowed(all.rules, '/'), false);
    assert.equal(isAllowed(all.rules, '/anything'), false);
    assert.equal(isAllowed(all.rules, '/robots.txt'), true);
});

test('robots: aturan sebelum user-agent diabaikan, BOM & CRLF ditangani', () => {
    const r = rulesFor(parseRobots('\uFEFFDisallow: /x\r\nUser-agent: *\r\nDisallow: /y\r\n'), 'KazanimeBot');
    assert.equal(isAllowed(r.rules, '/x'), true);
    assert.equal(isAllowed(r.rules, '/y'), false);
});

function gate(responses) {
    let n = 0;
    const g = new RobotsGate({
        token: 'KazanimeBot',
        fetchRobots: async () => {
            n++;
            const r = typeof responses === 'function' ? responses(n) : responses;
            if (r instanceof Error) throw r;
            return r;
        },
    });
    return { g, count: () => n };
}

test('RobotsGate: 2xx diurai & di-cache (1 request untuk banyak cek)', async () => {
    const { g, count } = gate({ status: 200, text: 'User-agent: *\nDisallow: /no/' });
    assert.deepEqual(await g.check('https://s.test/yes'), { allowed: true, reason: 'allowed', crawlDelayMs: 0 });
    assert.equal((await g.check('https://s.test/no/1')).allowed, false);
    assert.equal(count(), 1);
});

test('RobotsGate: 4xx = boleh (RFC 9309), kecuali requireExplicit (ToS belum ditinjau)', async () => {
    const { g } = gate({ status: 404, text: '' });
    assert.equal((await g.check('https://s.test/a')).allowed, true);
    const r = await g.check('https://s.test/a', { requireExplicit: true });
    assert.deepEqual([r.allowed, r.reason], [false, 'unverified']);
});

test('RobotsGate: 5xx / jaringan = tidak boleh (unreachable)', async () => {
    assert.equal((await gate({ status: 503, text: '' }).g.check('https://s.test/a')).reason, 'unreachable');
    assert.equal((await gate(new Error('ECONNRESET')).g.check('https://s.test/a')).reason, 'unreachable');
});

test('RobotsGate: halaman blokir Cloudflare = blocked', async () => {
    const r = await gate({ status: 403, text: fixture('cloudflare-block.html'), blocked: true }).g.check('https://s.test/a');
    assert.deepEqual([r.allowed, r.reason], [false, 'blocked']);
});

test('RobotsGate: Crawl-delay diteruskan dalam ms', async () => {
    const r = await gate({ status: 200, text: 'User-agent: *\nCrawl-delay: 3\nDisallow:' }).g.check('https://s.test/');
    assert.equal(r.crawlDelayMs, 3000);
});
