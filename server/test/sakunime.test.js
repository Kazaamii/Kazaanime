import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { createSakunime, parseAnimeLinks, parseAnimePage, parseEpisodePage, POLICY } from '../sources/sakunime.js';
import { fakeClientFactory, fixture, fixture$ } from './helpers.js';

const BASE = 'https://sakunime.com';
const SERIES = 'saijo-osewa-sub-indo';
const EP1 = `${BASE}/watch/sjnoswa-episode-1-sub-indo`;
// Minimal search/list link for adapter URL tests; no search-result page was provided.
const SEARCH_HTML = `<a href="${BASE}/anime/${SERIES}" title="Saijo no Osewa">Saijo no Osewa</a>`;
const LATEST_HTML = `
  <main>
    <article class="episode-card">
      <a href="${BASE}/anime/saijo-osewa-sub-indo" title="Saijo no Osewa">Saijo no Osewa</a>
      <a class="watch-eprow" href="${BASE}/watch/sjnoswa-episode-12-sub-indo" title="Saijo no Osewa Episode 12 Subtitle Indonesia">Eps 12</a>
    </article>
    <article class="episode-card">
      <a href="${BASE}/anime/shinja-zero-sub-indo" title="Shinja Zero">Shinja Zero</a>
      <a class="watch-eprow" href="${BASE}/watch/shinja-zero-episode-3-sub-indo" title="Shinja Zero Episode 3 Subtitle Indonesia">Eps 3</a>
    </article>
  </main>`;

test('sakunime: episode snapshot → one explicit default URL, opaque serverId ignored', () => {
    const parsed = parseEpisodePage(fixture$('sakunime-episode.html'), BASE);
    assert.equal(parsed.title, 'Saijo no Osewa Episode 1 Subtitle Indonesia');
    assert.equal(parsed.episode, 1);
    assert.equal(parsed.seriesSlug, SERIES);
    assert.equal(parsed.episodeId, 'sjnoswa-episode-1-sub-indo');
    assert.equal(parsed.servers.length, 1, 'serverId lain tidak di-resolve dari token opaque');
    assert.deepEqual(parsed.servers[0], {
        name: 'Sakunime',
        url: 'https://desustream.com/dstream/otakuwatch7/new/index.php?id=REDACTED',
        lang: 'id',
        subtitleEvidence: 'episode-title',
    });
    assert.equal(parsed.episodeList.length, 12);
});

test('sakunime: series metadata dan daftar episode dari tautan watch internal', () => {
    const parsed = parseAnimePage(fixture$('sakunime-episode.html'), BASE, SERIES);
    assert.equal(parsed.anime.title, 'Saijo no Osewa');
    assert.deepEqual(parsed.episodeList.map((e) => e.number), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.equal(parsed.episodeList[0].url, `${BASE}/watch/sjnoswa-episode-1-sub-indo`);
});

test('sakunime: public latest feed keeps the episode number from its related watch link', () => {
    const parsed = parseAnimeLinks(load(LATEST_HTML), BASE);
    assert.deepEqual(parsed.map((item) => [item.title, item.latestEpisode]), [
        ['Saijo no Osewa', 12],
        ['Shinja Zero', 3],
    ]);
});

test('sakunime: hasil pencarian hanya menerima URL seri internal, bukan kategori atau domain luar', () => {
    const $ = load(`
      <a href="/anime/saijo-osewa-sub-indo" title="Saijo no Osewa">Saijo no Osewa</a>
      <a href="/anime/ongoing/">Ongoing</a>
      <a href="https://evil.example/anime/fake/">Fake</a>
    `);
    assert.deepEqual(parseAnimeLinks($, BASE).map((item) => [item.slug, item.title]), [['saijo-osewa-sub-indo', 'Saijo no Osewa']]);
    const { createClient } = fakeClientFactory({});
    const source = createSakunime({ network: {}, createClient, baseUrl: BASE });
    assert.deepEqual(source.parseRef([SERIES]), { slug: SERIES });
    assert.equal(source.parseRef(['ongoing']), null);
    assert.equal(source.parseRef(['a', 'b']), null);
});

test('sakunime adapter: search → detail → episode; robots must be explicitly readable', async () => {
    const searchUrl = `${BASE}/search/Saijo%20no%20Osewa/`;
    const seriesUrl = `${BASE}/anime/${SERIES}`;
    const { createClient, calls } = fakeClientFactory({
        [searchUrl]: SEARCH_HTML,
        [`${BASE}/anime/`]: LATEST_HTML,
        [seriesUrl]: fixture('sakunime-episode.html'),
        [EP1]: fixture('sakunime-episode.html'),
    });
    let options;
    const source = createSakunime({
        network: {},
        createClient: (network, opts) => { options = opts; return createClient(network, opts); },
        baseUrl: BASE,
    });
    assert.equal(POLICY.tos.verdict, 'unknown');
    assert.equal(POLICY.robots, true);
    assert.equal(options.requireExplicitRobots, true);
    assert.equal(options.cookies, false);
    assert.deepEqual(options.allowedHosts, ['sakunime.com']);
    const found = await source.search('Saijo no Osewa');
    assert.equal(found.length, 1);
    assert.equal(found[0].title, 'Saijo no Osewa');
    const latest = await source.latest();
    assert.equal(latest.length, 2);
    assert.deepEqual(latest.map((item) => item.latestEpisode), [12, 3]);
    const anime = await source.getAnime({ slug: SERIES });
    const episode = await source.getEpisode({ slug: SERIES }, 1, { anime });
    assert.equal(episode.episode, 1);
    assert.equal(episode.servers.length, 1);
    assert.equal(episode.servers[0].lang, 'id');
    await assert.rejects(source.getEpisode({ slug: SERIES }, 99, { anime }), (err) => err.kind === 'not_found');
    assert.deepEqual(calls, [searchUrl, `${BASE}/anime/`, seriesUrl, EP1]);
});
