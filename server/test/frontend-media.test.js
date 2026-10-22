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

const { getBackendEpisode } = await import('../../js/api/sources.js');
const { clearApiCache } = await import('../../js/api/http.js');

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
