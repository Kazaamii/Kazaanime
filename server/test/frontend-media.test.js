import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.window = {
    sessionStorage: {
        setItem: (key, value) => storage.set(key, String(value)),
        getItem: (key) => storage.get(key) ?? null,
        removeItem: (key) => storage.delete(key),
        key: (index) => [...storage.keys()][index] ?? null,
        get length() { return storage.size; },
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
};
globalThis.CustomEvent = class extends Event {
    constructor(type, options = {}) {
        super(type);
        this.detail = options.detail;
    }
};

const { getBackendEpisode, getLatestSubIndoBySource } = await import('../../js/api/sources.js');
const { getSubIndoHomeSources } = await import('../../js/api/index.js');
const { getEpisodeExtras } = await import('../../js/api/streams.js');
const { createAnime } = await import('../../js/api/normalize.js');
const { cardHTML } = await import('../../js/ui/card.js');
const { clearApiCache } = await import('../../js/api/http.js');

test('Sub Indo source cards show the provider and keep its own watch route', () => {
    const anime = createAnime({
        title: 'Contoh Anime',
        image: 'https://images.example.test/poster.jpg',
        latestEpisode: 11,
        slug: 'otakudesu~contoh-anime',
        source: 'backend:otakudesu',
    });
    const markup = String(cardHTML(anime, { variant: 'source', episode: 11 }));
    assert.match(markup, /anime-card-badge src-backend">Otakudesu<\/span>/);
    assert.match(markup, /anime-card-quality">Sub Indo<\/span>/);
    assert.match(markup, /slug=otakudesu%7Econtoh-anime&amp;src=otakudesu/);
});

test('Sub Indo homepage API preserves separate source groups and duplicate titles', async (t) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        assert.equal(String(url), '/api/anime/latest-subindo');
        return new Response(JSON.stringify({
            ok: true,
            source: 'samehadaku,otakudesu',
            fallback: false,
            stale: false,
            data: [
                { id: 'samehadaku', name: 'Samehadaku', items: [{ title: 'Judul sama', slug: 'samehadaku~judul-sama', source: 'samehadaku' }] },
                { id: 'otakudesu', name: 'Otakudesu', items: [{ title: 'Judul sama', slug: 'otakudesu~judul-sama', source: 'otakudesu' }], error: { source: 'otakudesu', kind: 'blocked', message: 'Diblokir' } },
            ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    clearApiCache();
    t.after(() => {
        globalThis.fetch = originalFetch;
        clearApiCache();
    });

    const result = await getLatestSubIndoBySource();
    assert.deepEqual(result.sections.map((source) => source.id), ['samehadaku', 'otakudesu']);
    assert.deepEqual(result.sections.map((source) => source.items[0].source), ['backend:samehadaku', 'backend:otakudesu']);
    assert.equal(result.sections[1].error.kind, 'blocked');
    assert.equal(result.sections[0].items[0].id, 'samehadaku:samehadaku~judul-sama');
});

test('homepage facade checks the latest episode and retains identical titles from different sources', async (t) => {
    const originalFetch = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async (input) => {
        const url = String(input);
        requested.push(url);
        if (url === '/api/anime/latest-subindo') {
            return new Response(JSON.stringify({
                ok: true,
                source: 'samehadaku,otakudesu',
                fallback: false,
                data: [
                    { id: 'samehadaku', name: 'Samehadaku', items: [{ title: 'Judul sama', slug: 'samehadaku~judul-sama', source: 'samehadaku', latestEpisode: 7 }] },
                    { id: 'otakudesu', name: 'Otakudesu', items: [{ title: 'Judul sama', slug: 'otakudesu~judul-sama', source: 'otakudesu', latestEpisode: 8 }] },
                ],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        assert.match(url, /^\/api\/anime\/(?:samehadaku|otakudesu)~judul-sama\/episode\/[78]$/i);
        return new Response(JSON.stringify({
            ok: true,
            fallback: false,
            data: { servers: [{ name: 'Server Indonesia', url: 'https://embed.example.test/watch', lang: 'id', subtitleType: 'hard' }], downloads: [] },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    clearApiCache();
    t.after(() => {
        globalThis.fetch = originalFetch;
        clearApiCache();
    });

    const result = await getSubIndoHomeSources();
    assert.deepEqual(result.sections.map((source) => source.id), ['samehadaku', 'otakudesu']);
    assert.deepEqual(result.sections.map((source) => source.items.map((anime) => anime.title)), [
        ['Judul sama'],
        ['Judul sama'],
    ]);
    assert.deepEqual(result.sections.map((source) => source.items[0].latestEpisode), [7, 8]);
    assert.equal(requested.length, 3, 'catalogue plus one latest-episode check per source');
});

test('frontend accepts only same-origin signed AnimeOnsen media proxy URLs', async (t) => {
    const originalFetch = globalThis.fetch;
    const mediaUrl = '/api/stream/hls?u=Y2Ru&s=signature&p=animeonsen';
    const subtitleUrl = '/api/stream/sub?u=c3Vi&f=srt&s=signature&p=animeonsen';
    const response = {
        ok: true,
        source: 'animeonsen',
        data: {
            servers: [
                {
                    name: 'AnimeOnsen', kind: 'hls', lang: 'multi', url: mediaUrl,
                    subtitles: [{ label: 'Indonesia', lang: 'id-id', url: subtitleUrl, default: true }],
                },
                { name: 'Unproxied HLS', kind: 'hls', lang: 'multi', url: 'https://media.example.test/episode.m3u8' },
                { name: 'Unproxied video', kind: 'video', lang: '', url: 'https://media.example.test/episode.mp4' },
            ],
            downloads: [],
        },
    };
    globalThis.fetch = async (url) => {
        assert.equal(String(url), '/api/anime/animeonsen~fixture-anime-01/episode/2');
        return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    clearApiCache();
    t.after(() => {
        globalThis.fetch = originalFetch;
        clearApiCache();
    });

    const result = await getBackendEpisode('animeonsen~fixture-anime-01', 2);
    assert.equal(result.servers.length, 1, 'HLS/video mentah dari backend tidak boleh diputar langsung');
    assert.equal(result.servers[0].kind, 'hls');
    assert.equal(result.servers[0].url, mediaUrl);
    assert.deepEqual(result.servers[0].subtitles, [{
        label: 'Indonesia', lang: 'id-id', url: subtitleUrl, default: true,
    }]);
});


test('episode extras: searches alternate sources when a known source has no Indonesian server', async (t) => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const ownSlug = 'animeindo~hyouken-suberu-s2-sub-indo~hnmgsws-s2-episode-3-sub-indo';
    const otakuSlug = 'otakudesu~hyouken-no-majutsushi-ga-sekai-wo-suberu-season-2-sub-indo';

    globalThis.fetch = async (input) => {
        const url = String(input);
        calls.push(url);

        if (url === `/api/anime/${encodeURIComponent(ownSlug)}/episode/3`) {
            return new Response(JSON.stringify({
                ok: true,
                source: 'animeindo',
                fallback: false,
                data: { episode: 3, servers: [], downloads: [] },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        if (url.startsWith('/api/anime/search?')) {
            return new Response(JSON.stringify({
                ok: true,
                source: 'otakudesu',
                fallback: false,
                data: [{
                    title: 'Hyouken no Majutsushi ga Sekai wo Suberu Season 2',
                    slug: otakuSlug,
                    source: 'otakudesu',
                }],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        if (url === `/api/anime/${encodeURIComponent(otakuSlug)}/episode/3`) {
            return new Response(JSON.stringify({
                ok: true,
                source: 'otakudesu',
                fallback: false,
                data: {
                    episode: 3,
                    servers: [{
                        name: 'Public embed',
                        url: 'https://player.example.test/embed/hyouken-3',
                        lang: 'id',
                        subtitleType: 'hard',
                    }],
                    downloads: [],
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        return new Response(JSON.stringify({ ok: false, error: 'fixture route missing', code: 'NOT_FOUND' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
        });
    };

    clearApiCache();
    t.after(() => {
        globalThis.fetch = originalFetch;
        clearApiCache();
    });

    const result = await getEpisodeExtras({
        title: 'Hyouken no Majutsushi ga Sekai wo Suberu Season 2',
        titleAlt: 'The Iceblade Sorcerer Shall Rule the World II',
        slug: ownSlug,
        ids: {},
    }, 3, {
        slug: ownSlug,
        titles: ['Hyouken no Majutsushi ga Sekai wo Suberu Season 2'],
    });

    assert.ok(calls.some((url) => url.startsWith('/api/anime/search?')), 'searches alternate provider catalogs');
    assert.ok(calls.includes(`/api/anime/${encodeURIComponent(otakuSlug)}/episode/3`), 'requests the matching Otakudesu episode');
    assert.ok(result.servers.some((server) => server.lang === 'id' && server.source === 'backend:otakudesu'));
    assert.equal(result.servers[0].subtitleType, 'hard');
});
