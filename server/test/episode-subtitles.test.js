import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'cheerio';
import { makeAnime } from '../lib/anime.js';
import { TtlCache } from '../lib/cache.js';
import { SourceError } from '../lib/errors.js';
import { createRegistry } from '../sources/index.js';
import { parseEpisodeRows } from '../sources/oploverz.js';
import { readEpisodeRange } from '../routes/anime.js';

/**
 * Badge Sub Indo PER EPISODE (24 Okt 2026, putaran 3).
 *
 * Keluhan pengguna: "hanya terdeteksi sub indo jika di eps 13" — badge hanya muncul untuk
 * episode yang kebetulan sedang dibuka. Sekarang backend memeriksa setiap episode pada
 * rentang yang diminta (GET /api/anime/:slug/subtitles), memakai bukti dari daftar episode
 * bila ada dan halaman episode bila tidak, lalu UI menampilkan badge per tombol episode.
 */

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const TTL = {
    latestTtlMs: 600000, searchTtlMs: 900000, detailTtlMs: 900000, episodeTtlMs: 900000, scheduleTtlMs: 3600000,
    subtitleMapTtlMs: 1800000, notFoundTtlMs: 300000, staleMs: 3600000, cdnMaxAge: 600, cdnStale: 1800,
};

const fail = (kind, source = 'x') => new SourceError(`${source} ${kind}`, { kind, source });

/** Adapter tiruan: getAnime membawa episodeList, getEpisode dihitung pemanggilannya. */
function stub({ rows = [], episode = async () => { throw fail('not_found'); } } = {}) {
    const calls = { getAnime: 0, episodes: [] };
    return {
        id: 'demo',
        name: 'Demo',
        baseUrl: 'https://demo.test',
        policy: { tos: { verdict: 'allowed' }, imagePolicy: 'ok' },
        parseRef: (parts) => (parts.length === 1 ? { slug: parts[0] } : null),
        titleHint: (ref) => ref.slug,
        latest: async () => [],
        search: async () => [],
        getAnime: async () => {
            calls.getAnime += 1;
            return { ...makeAnime({ title: 'Demo', source: 'demo', slug: 'demo~seri' }), episodeList: rows };
        },
        getEpisode: async (ref, ep) => {
            calls.episodes.push(ep);
            return episode(ref, ep);
        },
        calls,
    };
}

const reg = (adapter) => createRegistry({
    adapters: [adapter],
    metadata: null,
    cache: new TtlCache(),
    ttl: TTL,
    enrichImages: false,
});

test('subtitle map: bukti dari daftar episode dipakai tanpa membuka halaman episode', async () => {
    const adapter = stub({
        rows: [
            { number: 1, title: 'Demo Episode 1 Subtitle Indonesia', url: 'https://demo.test/1', sub: 'id' },
            { number: 2, title: 'Demo Episode 2', url: 'https://demo.test/2', sub: '' },
            { number: 3, title: 'Demo Episode 3 Subtitle Indonesia', url: 'https://demo.test/3', sub: 'id' },
        ],
    });
    const out = await reg(adapter).episodeSubtitles('demo~seri', { from: 1, to: 3 });
    assert.equal(out.source, 'demo');
    assert.deepEqual(out.data.episodes.map((item) => [item.number, item.sub]), [
        [1, 'id'], [2, ''], [3, 'id'],
    ]);
    assert.equal(out.data.episodes[0].evidence, 'episode-list');
    assert.deepEqual(adapter.calls.episodes, [], 'tidak ada permintaan tambahan');
});

test('subtitle map: episode tanpa bukti di daftar diperiksa dari halaman episodenya', async () => {
    const adapter = stub({
        rows: [
            { number: 1, title: 'Demo Episode 1', url: 'https://demo.test/1' },
            { number: 2, title: 'Demo Episode 2', url: 'https://demo.test/2' },
            { number: 3, title: 'Demo Episode 3', url: 'https://demo.test/3' },
        ],
        episode: async (_ref, ep) => ({
            episode: ep,
            title: `Demo Episode ${ep} Sub Indo HD`,
            servers: [{ name: 'Server 1', url: 'https://demo.test/e', lang: 'id' }],
        }),
    });
    const out = await reg(adapter).episodeSubtitles('demo~seri', { from: 1, to: 3 });
    assert.deepEqual(out.data.episodes.map((item) => item.sub), ['id', 'id', 'id']);
    assert.equal(out.data.episodes[0].evidence, 'episode-server');
    assert.deepEqual(adapter.calls.episodes.sort(), [1, 2, 3]);
});

test('subtitle map: episode yang gagal / belum tayang tidak diklaim Sub Indo', async () => {
    const adapter = stub({
        rows: [
            { number: 1, title: 'Demo Episode 1', url: 'https://demo.test/1' },
            { number: 2, title: 'Demo Episode 2', url: 'https://demo.test/2' },
        ],
        episode: async (_ref, ep) => {
            if (ep === 2) throw fail('not_found');
            return { episode: ep, title: `Demo Episode ${ep}`, servers: [{ name: 'Server 1', url: 'https://demo.test/e', lang: '' }] };
        },
    });
    const out = await reg(adapter).episodeSubtitles('demo~seri', { from: 1, to: 5 });
    // Episode di luar daftar situs (3–5) tidak ikut diperiksa / tidak diberi badge.
    assert.deepEqual(out.data.episodes.map((item) => [item.number, item.sub]), [[1, ''], [2, null]]);
});

test('subtitle map: satu panggilan dibatasi 24 episode', async () => {
    const adapter = stub({ rows: [] });
    const registry = reg(adapter);
    const out = await registry.episodeSubtitles('demo~seri', { from: 1, to: 100 });
    assert.equal(out.data.from, 1);
    assert.equal(out.data.to, 24);
    assert.equal(out.data.episodes.length, 24);
    // Panggilan kedua untuk rentang yang sama memakai cache (tidak memeriksa ulang).
    const before = adapter.calls.episodes.length;
    await registry.episodeSubtitles('demo~seri', { from: 1, to: 24 });
    assert.equal(adapter.calls.episodes.length, before, 'hasil disimpan di cache');
});

test('subtitle map: slug metadata ditolak dengan 404', async () => {
    const registry = reg(stub());
    await assert.rejects(() => registry.episodeSubtitles('anilist~1', { from: 1, to: 1 }), (err) => err?.kind === 'not_found');
});

test('route: rentang episode divalidasi (?from/?to)', () => {
    assert.deepEqual(readEpisodeRange({}), { from: 1, to: 1 });
    assert.deepEqual(readEpisodeRange({ from: '3', to: '9' }), { from: 3, to: 9 });
    assert.deepEqual(readEpisodeRange({ from: '3' }), { from: 3, to: 3 });
    assert.deepEqual(readEpisodeRange({ from: '1', to: '500' }), { from: 1, to: 24 });
    assert.throws(() => readEpisodeRange({ from: '0' }), (err) => err?.code === 'BAD_REQUEST');
    assert.throws(() => readEpisodeRange({ from: 'abc' }), (err) => err?.code === 'BAD_REQUEST');
    assert.throws(() => readEpisodeRange({ from: '9', to: '3' }), (err) => err?.code === 'BAD_REQUEST');
    const routeJs = read('server/routes/anime.js');
    assert.match(routeJs, /router\.get\('\/:slug\/subtitles'/);
    assert.match(routeJs, /registry\.episodeSubtitles\(/);
});

test('oploverz: baris daftar episode membawa bukti Sub Indo per episode', () => {
    const html = `<div class="eplister"><ul>
        <li><a href="https://oploverz.ch/demo-episode-1-subtitle-indonesia/">
            <div class="epl-num">1</div>
            <div class="epl-title">Demo Episode 1 Subtitle Indonesia</div>
        </a></li>
        <li><a href="https://oploverz.ch/demo-episode-2-subtitle-indonesia/">
            <div class="epl-num">2</div>
            <div class="epl-title">Demo Episode 2</div>
        </a></li>
    </ul></div>`;
    const rows = parseEpisodeRows(load(html), 'https://oploverz.ch');
    assert.deepEqual(rows.map((row) => [row.number, row.sub]), [[1, 'id'], [2, '']]);
});

test('frontend: badge Sub Indo dirender per tombol episode', () => {
    const listJs = read('js/ui/episode-list.js');
    const watchJs = read('js/watch.js');
    const sourcesJs = read('js/api/sources.js');
    const css = read('css/watch.css');

    assert.match(listJs, /let subtitles = new Map\(\);/);
    assert.match(listJs, /const indo = subtitles\.get\(n\) === 'id';/);
    assert.match(listJs, /<span class="ep-sub">Sub Indo<\/span>/);
    assert.match(listJs, /setSubtitles\(map\)/);
    assert.match(listJs, /clearSubtitles\(\)/);

    assert.match(watchJs, /async function loadSubtitleMap\(/);
    assert.match(watchJs, /getEpisodeSubtitles\(ref\.slug, \{ from: 1, to, signal: ctrl\.signal \}\)/);
    assert.match(watchJs, /episodes\.setSubtitles\(map\)/);
    assert.match(watchJs, /PLAYER\.subtitleMapLimit/);

    assert.match(sourcesJs, /export async function getEpisodeSubtitles\(slug/);
    assert.match(sourcesJs, /\/subtitles\?from=\$\{from\}&to=\$\{to\}/);
    assert.match(css, /\.ep-btn \.ep-sub\{/);
});

test('config: batas pemeriksaan per episode tersedia di frontend & backend', () => {
    assert.match(read('js/config.js'), /subtitleMapLimit: 24,/);
    assert.match(read('server/sources/index.js'), /maxEpisodes: 24,/);
    assert.match(read('server/sources/index.js'), /concurrency: 3,/);
    assert.match(read('server/config.js'), /subtitleMapTtlMs:/);
});
