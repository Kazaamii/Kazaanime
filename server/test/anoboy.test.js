import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { createAnoboy, parseAnimePage, parseCards, parseEpisodePage, POLICY } from '../sources/anoboy.js';
import { fakeClientFactory, fixture, fixture$ } from './helpers.js';

const BASE = 'https://anoboy.be';
const SERIES = 'fx-senshi-kurumi-chan';
const EP4 = `${BASE}/${SERIES}-episode-4-subtitle-indonesia/`;
// Minimal search response for URL/parser tests; the saved attachment is an episode snapshot.
const SEARCH_HTML = `<div class="listupd"><article class="bs"><div class="bsx">
  <a href="${BASE}/anime/${SERIES}/" title="FX Senshi Kurumi-chan">
    <div class="limit"><div class="typez TV">TV</div><span class="epx">Episode 4</span><img src="${BASE}/wp-content/uploads/fx-senshi-kurumi-chan.jpg"></div>
    <div class="tt"><h2>FX Senshi Kurumi-chan</h2></div>
  </a>
</div></article></div>`;

test('anoboy: kartu anime tema AnimeStream dibaca dari kartu dengan URL seri internal', () => {
    const cards = parseCards(load(SEARCH_HTML), BASE);
    assert.equal(cards.length, 1);
    assert.deepEqual(
        { slug: cards[0].slug, title: cards[0].title, latestEpisode: cards[0].latestEpisode, format: cards[0].format },
        { slug: SERIES, title: 'FX Senshi Kurumi-chan', latestEpisode: 4, format: 'TV' },
    );
    assert.equal(parseCards(load('<article class="bs"><a href="https://evil.example/anime/abc/"><h2>Bad</h2></a></article>'), BASE).length, 0);
});

test('anoboy: halaman episode memberikan dua URL server eksplisit + Sub Indo, tanpa membaca iframe lokal', () => {
    const parsed = parseEpisodePage(fixture$('anoboy-episode.html'), BASE);
    assert.equal(parsed.title, 'FX Senshi Kurumi-chan Episode 4 Subtitle Indonesia');
    assert.equal(parsed.episode, 4);
    assert.equal(parsed.seriesUrl, `${BASE}/anime/${SERIES}/`);
    assert.deepEqual(parsed.servers.map((s) => [s.name, s.lang, new URL(s.url).hostname]), [
        ['HD-1', 'id', 'www.blogger.com'],
        ['HD-2', 'id', 'play.xtwap.top'],
    ]);
    assert.ok(parsed.servers.every((s) => !s.url.includes('iframe')));
    assert.equal(parsed.episodeList.length, 4);
});

test('anoboy: detail/list episode dari markup episode yang dibagikan', () => {
    const parsed = parseAnimePage(fixture$('anoboy-episode.html'), BASE, SERIES);
    assert.equal(parsed.anime.title, 'FX Senshi Kurumi-chan');
    assert.equal(parsed.anime.country, 'JP');
    assert.deepEqual(parsed.episodeList.map((e) => e.number), [1, 2, 3, 4]);
});

test('anoboy adapter: search → detail → episode dan fail-closed robots policy', async () => {
    const searchUrl = `${BASE}/?s=FX+Senshi+Kurumi-chan`;
    const { createClient, calls } = fakeClientFactory({
        [searchUrl]: SEARCH_HTML,
        [`${BASE}/anime/${SERIES}/`]: fixture('anoboy-episode.html'),
        [EP4]: fixture('anoboy-episode.html'),
    });
    let options;
    const source = createAnoboy({
        network: {},
        createClient: (network, opts) => { options = opts; return createClient(network, opts); },
        baseUrl: BASE,
    });
    assert.equal(source.policy, POLICY);
    assert.equal(POLICY.tos.verdict, 'unknown');
    assert.equal(POLICY.robots, true);
    assert.equal(options.requireExplicitRobots, true);
    assert.equal(options.cookies, false);
    assert.deepEqual(options.allowedHosts, ['anoboy.be']);
    assert.equal((await source.latest()).length, 0, 'tidak menebak URL halaman terbaru');
    const found = await source.search('FX Senshi Kurumi-chan');
    assert.equal(found[0].title, 'FX Senshi Kurumi-chan');
    assert.equal(found[0].country, 'JP');
    const anime = await source.getAnime({ slug: SERIES });
    const episode = await source.getEpisode({ slug: SERIES }, 4, { anime });
    assert.equal(episode.episode, 4);
    assert.equal(episode.servers.length, 2);
    assert.ok(episode.servers.every((s) => s.lang === 'id'));
    await assert.rejects(source.getEpisode({ slug: SERIES }, 9, { anime }), (err) => err.kind === 'not_found');
    assert.deepEqual(calls, [searchUrl, `${BASE}/anime/${SERIES}/`, EP4]);
});
