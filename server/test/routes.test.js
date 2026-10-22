import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { makeAnime, makeEpisode } from '../lib/anime.js';
import { AppError, SourceError, badRequest, notFound } from '../lib/errors.js';
import { createSigner, decodeTarget } from '../lib/stream-proxy.js';

/** Registry tiruan: perilaku per slug/kueri. */
function fakeRegistry() {
    const seen = [];
    return {
        seen,
        async latest() {
            seen.push('latest');
            return { source: 'animexin', data: [makeAnime({ title: 'Renegade Immortal', slug: 'animexin~renegade-immortal', source: 'animexin', latestEpisode: 163, country: 'CN' })], fallback: false, stale: false, errors: [{ source: 'kuramanime', kind: 'blocked', message: 'diblokir' }] };
        },
        async search(q) {
            seen.push(`search:${q}`);
            if (q === 'gagal total') throw new AppError('Pencarian gagal: semua sumber sedang bermasalah.', { status: 503, code: 'SOURCES_UNAVAILABLE', retryAfter: 120 });
            return { source: 'metadata', provider: 'kitsu', data: [], fallback: true, stale: false, errors: [] };
        },
        async detail(slug) {
            seen.push(`detail:${slug}`);
            if (slug === 'animexin~tidak-ada') throw notFound('Halaman tidak ditemukan di situs sumber.', 'animexin');
            if (slug === 'animexin~meledak') throw new Error('bug tak terduga https://log-user:log-secret@private.example/path?token=log-token');
            if (!slug.includes('~')) throw badRequest('Slug tidak valid.');
            return { source: 'animexin', data: { ...makeAnime({ title: 'Judul', slug, source: 'animexin' }), episodeList: [] }, fallback: false, stale: false, errors: [] };
        },
        async episode(slug, ep) {
            seen.push(`episode:${slug}:${ep}`);
            if (slug === 'animexin~timeout') throw new SourceError('animexin terlalu lama merespons (6 dtk).', { kind: 'timeout', source: 'animexin' });
            return { source: 'animexin', data: makeEpisode({ episode: ep, servers: [{ name: 'Dailymotion (Sub Indo)', url: 'https://geo.dailymotion.com/player/x.html?video=1', lang: 'id' }] }), fallback: false, stale: false, errors: [] };
        },
        async schedule() {
            seen.push('schedule');
            return { source: 'samehadaku,animexin', data: { timezone: 'Asia/Jakarta', days: { 0: [{ title: 'Kusuriya no Hitorigoto Season 3', time: '01:00', slug: 'samehadaku~kusuriya-no-hitorigoto-season-3', source: 'samehadaku' }] } }, fallback: false, stale: false, errors: [] };
        },
        health: () => ({ sources: [{ id: 'animexin', circuit: 'closed' }], metadata: { enabled: true }, cache: { entries: 0 } }),
    };
}

async function withApp(opts, fn) {
    const registry = opts.registry || fakeRegistry();
    const app = createApp({ registry, log: false, rateLimitPerMinute: 0, budgetMs: 5000, ...opts });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await fn(base, registry);
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
}

const get = async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* bukan JSON */ }
    return { res, json, text };
};

test('GET /api/anime/latest: kontrak {ok, source, data} + header cache CDN', async () => {
    await withApp({}, async (base) => {
        const { res, json } = await get(`${base}/api/anime/latest`);
        assert.equal(res.status, 200);
        assert.equal(json.ok, true);
        assert.equal(json.source, 'animexin');
        assert.equal(json.fallback, false);
        assert.equal(json.data[0].slug, 'animexin~renegade-immortal');
        assert.equal(json.errors[0].kind, 'blocked');
        assert.ok(json.generatedAt);
        assert.match(res.headers.get('cache-control'), /s-maxage=600/);
        assert.match(res.headers.get('content-type'), /application\/json/);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-powered-by'), null);
    });
});

test('GET /api/anime/search: validasi q; fallback → cache CDN lebih singkat', async () => {
    await withApp({}, async (base, reg) => {
        const ok = await get(`${base}/api/anime/search?q=${encodeURIComponent('  soul   land ')}`);
        assert.equal(ok.res.status, 200);
        assert.equal(ok.json.fallback, true);
        assert.equal(ok.json.provider, 'kitsu');
        assert.match(ok.res.headers.get('cache-control'), /max-age=0, s-maxage=120/);
        assert.ok(reg.seen.includes('search:soul land'), 'spasi dirapikan');
        for (const bad of ['', '?q=', '?q=a', `?q=${'x'.repeat(101)}`]) {
            const r = await get(`${base}/api/anime/search${bad}`);
            assert.equal(r.res.status, 400, bad);
            assert.deepEqual([r.json.ok, r.json.code], [false, 'BAD_REQUEST']);
        }
        const multi = await get(`${base}/api/anime/search?q=naruto&q=bleach`);
        assert.equal(multi.res.status, 200);
        assert.ok(reg.seen.includes('search:naruto'));
    });
});

test('GET /api/anime/:slug & /episode/:ep: sukses, 400, 404, 500 (pesan aman), 503 + Retry-After', async () => {
    await withApp({}, async (base) => {
        const d = await get(`${base}/api/anime/animexin~judul`);
        assert.equal(d.res.status, 200);
        assert.equal(d.json.data.slug, 'animexin~judul');

        const nf = await get(`${base}/api/anime/animexin~tidak-ada`);
        assert.equal(nf.res.status, 404);
        assert.deepEqual([nf.json.ok, nf.json.code], [false, 'NOT_FOUND']);
        assert.match(nf.res.headers.get('cache-control'), /s-maxage=300/);

        const loggedErrors = [];
        const originalConsoleError = console.error;
        let boom;
        try {
            console.error = (...args) => loggedErrors.push(args.join(' '));
            boom = await get(`${base}/api/anime/animexin~meledak`);
        } finally {
            console.error = originalConsoleError;
        }
        assert.equal(boom.res.status, 500);
        assert.equal(boom.json.error, 'Terjadi kesalahan di server.', 'detail error internal tidak bocor');
        assert.equal(boom.res.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(loggedErrors.join(' '), /log-user|log-secret|log-token|private\.example|tak terduga/);

        const ep = await get(`${base}/api/anime/animexin~judul/episode/12`);
        assert.equal(ep.res.status, 200);
        assert.equal(ep.json.data.episode, 12);
        assert.equal(ep.json.data.servers[0].lang, 'id');

        for (const bad of ['abc', '0', '5001', '1.5', '-1', '99999']) {
            const r = await get(`${base}/api/anime/animexin~judul/episode/${bad}`);
            assert.equal(r.res.status, 400, bad);
        }
        const to = await get(`${base}/api/anime/animexin~timeout/episode/1`);
        assert.equal(to.res.status, 504);
        assert.equal(to.json.code, 'UPSTREAM_TIMEOUT');

        const busy = await get(`${base}/api/anime/search?q=gagal%20total`);
        assert.equal(busy.res.status, 503);
        assert.equal(busy.res.headers.get('retry-after'), '120');
    });
});

test('/api/health, /api/bot, /api/<tidak-ada>', async () => {
    await withApp({}, async (base) => {
        const h = await get(`${base}/api/health`);
        assert.equal(h.res.status, 200);
        assert.equal(h.json.ok, true);
        assert.equal(h.json.data.status, 'ok');
        assert.match(h.json.data.userAgent, /^KazanimeBot\/1\.0 \(/);
        assert.equal(h.res.headers.get('cache-control'), 'no-store');
        const bot = await get(`${base}/api/bot`);
        assert.match(bot.text, /User-agent: KazanimeBot\n\s+Disallow: \//);
        assert.match(bot.res.headers.get('content-type'), /text\/plain/);
        const none = await get(`${base}/api/tidak-ada`);
        assert.equal(none.res.status, 404);
        assert.equal(none.json.code, 'NOT_FOUND');
    });
});

test('AnimeOnsen episode: media/subtitle memakai proxy bertanda tangan, header resmi, dan cache no-store', async () => {
    const streamUrl = 'https://media.example.test/episode/master.m3u8';
    const subtitleUrl = 'https://media.example.test/subtitles/id-ID.srt';
    const signer = createSigner('route-test-secret-long-enough-123');
    const registry = fakeRegistry();
    registry.episode = async (_slug, ep) => ({
        source: 'animeonsen',
        data: makeEpisode({
            episode: ep,
            servers: [{
                name: 'AnimeOnsen', url: streamUrl, kind: 'hls', lang: 'multi', subtitleType: 'soft',
                subtitles: [{ label: 'Indonesia', lang: 'id-id', format: 'srt', url: subtitleUrl, default: true }],
            }],
        }),
        fallback: false, stale: false, errors: [],
    });
    const mediaCalls = [];
    const mediaClient = {
        async stream(url, options = {}) {
            mediaCalls.push({ url, headers: options.headers || {} });
            if (url === streamUrl) {
                return {
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }),
                    body: new Response('#EXTM3U\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n').body,
                    url,
                };
            }
            if (url === subtitleUrl) {
                return {
                    status: 200,
                    headers: new Headers({ 'content-type': 'text/plain' }),
                    body: new Response('1\n00:00:01,000 --> 00:00:02,000\nHalo').body,
                    url,
                };
            }
            return { status: 404, headers: new Headers(), body: new Response('missing').body, url };
        },
    };
    await withApp({ registry, signer, animeOnsenMediaClient: mediaClient, animeOnsenMediaHosts: ['media.example.test'] }, async (base) => {
        const response = await get(`${base}/api/anime/animeonsen~fixture-anime-01/episode/2`);
        assert.equal(response.res.status, 200);
        assert.equal(response.res.headers.get('cache-control'), 'private, no-store');
        const server = response.json.data.servers[0];
        assert.equal(server.kind, 'hls');
        assert.equal(server.direct, undefined, 'raw media URL tidak dikirim sebagai URL direct');
        const hls = new URL(server.url, base);
        const hlsTarget = decodeTarget(hls.searchParams.get('u'));
        assert.equal(hls.pathname, '/api/stream/hls');
        assert.equal(hls.searchParams.get('p'), 'animeonsen');
        assert.equal(hlsTarget, streamUrl);
        assert.ok(signer.verify(`${hlsTarget}|animeonsen`, hls.searchParams.get('s')));
        assert.ok(!response.text.includes(streamUrl));
        assert.ok(!response.text.includes(subtitleUrl));

        const playlistResponse = await fetch(`${base}${server.url}`);
        assert.equal(playlistResponse.status, 200);
        assert.equal(playlistResponse.headers.get('cache-control'), 'private, no-store');
        const playlist = await playlistResponse.text();
        assert.match(playlist, /\/api\/stream\/hls\?u=/);
        assert.match(playlist, /&p=animeonsen&s=/);
        assert.equal(mediaCalls[0].headers.Origin, 'https://www.animeonsen.xyz');
        assert.equal(mediaCalls[0].headers.Referer, 'https://www.animeonsen.xyz/');

        const subtitleProxy = new URL(server.subtitles[0].url, base);
        const subtitleTarget = decodeTarget(subtitleProxy.searchParams.get('u'));
        assert.equal(subtitleProxy.pathname, '/api/stream/sub');
        assert.equal(subtitleProxy.searchParams.get('f'), 'srt');
        assert.equal(subtitleProxy.searchParams.get('p'), 'animeonsen');
        assert.ok(signer.verify(`${subtitleTarget}|srt|animeonsen`, subtitleProxy.searchParams.get('s')));
        const subtitleResponse = await fetch(`${base}${server.subtitles[0].url}`);
        assert.equal(subtitleResponse.status, 200);
        assert.equal(subtitleResponse.headers.get('cache-control'), 'private, no-store');
        assert.match(await subtitleResponse.text(), /^WEBVTT\n/);
        assert.deepEqual(mediaCalls.map((call) => call.url), [streamUrl, subtitleUrl]);

        const unlistedTarget = 'https://sub.media.example.test/episode/other.m3u8';
        const params = new URLSearchParams({
            u: Buffer.from(unlistedTarget).toString('base64url'),
            p: 'animeonsen',
            s: signer.sign(`${unlistedTarget}|animeonsen`),
        });
        const denied = await get(`${base}/api/stream/hls?${params}`);
        assert.equal(denied.res.status, 403, 'proxy scope mengizinkan exact CDN host, bukan subdomain turunan');
        assert.equal(mediaCalls.length, 2, 'target di luar allowlist tidak pernah dikirim');
    });
});

test('rate limit masuk per IP → 429 JSON dengan Retry-After', async () => {
    await withApp({ rateLimitPerMinute: 3 }, async (base) => {
        const statuses = [];
        for (let i = 0; i < 4; i++) statuses.push((await get(`${base}/api/anime/latest`)).res.status);
        assert.deepEqual(statuses, [200, 200, 200, 429]);
        const r = await get(`${base}/api/anime/latest`);
        assert.equal(r.json.code, 'RATE_LIMITED');
        assert.ok(Number(r.res.headers.get('retry-after')) > 0);
        assert.equal((await get(`${base}/api/health`)).res.status, 200, '/api/health tidak kena limit');
    });
});

test('server lokal: hanya file frontend yang dilayani (server/, package.json tidak bocor)', async () => {
    await withApp({ serveStatic: true }, async (base) => {
        const home = await get(`${base}/`);
        assert.equal(home.res.status, 200);
        assert.match(home.text, /<html/i);
        assert.equal(home.res.headers.get('x-frame-options'), null, 'lokal boleh dipratinjau dalam iframe');
        for (const p of ['/watch.html', '/search.html', '/index.html', '/css/base.css', '/js/config.js']) {
            assert.equal((await get(`${base}${p}`)).res.status, 200, p);
        }
        assert.match((await fetch(`${base}/js/config.js`)).headers.get('content-type'), /javascript/);
        for (const p of ['/server/app.js', '/package.json', '/api/index.js', '/.env.example', '/node_modules/express/package.json', '/js/../server/config.js', '/js/%2e%2e/server/config.js']) {
            assert.equal((await get(`${base}${p}`)).res.status, 404, p);
        }
    });
});

test('GET /api/anime/schedule: dirutekan ke registry.schedule (BUKAN dianggap slug anime)', async () => {
    await withApp({}, async (base, registry) => {
        const { res, json } = await get(`${base}/api/anime/schedule`);
        assert.equal(res.status, 200);
        assert.equal(json.ok, true);
        assert.equal(json.source, 'samehadaku,animexin');
        assert.equal(json.data.timezone, 'Asia/Jakarta');
        assert.equal(json.data.days[0][0].time, '01:00');
        assert.match(res.headers.get('cache-control'), /s-maxage=/);
        assert.ok(registry.seen.includes('schedule'));
        assert.ok(!registry.seen.some((x) => x.startsWith('detail:')));
    });
});
