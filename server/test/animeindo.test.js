import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisodeRef, parseEpisodeNumber, parseAnimePage, parsePublicEmbedSources, createAnimeIndo } from '../sources/animeindo.js';
import { fakeClientFactory } from './helpers.js';

const BASE = 'https://animeindo.cloud';
const SERIES = 'hyouken-suberu-s2-sub-indo';
const EP3 = 'hnmgsws-s2-episode-3-sub-indo';
const PAGE3 = BASE + '/nonton/' + SERIES + '/' + EP3;

const html = [
'<!doctype html>',
'<html lang="id"><head>',
'<title>Hyouken no Majutsushi ga Sekai wo Suberu Season 2 Episode 3 Sub Indo - AnimeIndo</title>',
'<meta name="description" content="Contoh sinopsis anime untuk pengujian.">',
'<meta property="og:image" content="/images/hyouken.jpg">',
'</head><body>',
'<h1>Hyouken no Majutsushi ga Sekai wo Suberu Season 2 Episode 3 Sub Indo</h1>',
'<ul class="anime-info">',
'<li>Genre: <a>Action</a>, <a>Fantasy</a>, <a>School</a></li>',
'<li>Studio: <a>Zero-G</a></li>',
'<li>Durasi: 24 menit</li>',
'<li>Status: Ongoing</li>',
'<li>Total Episode: 12</li>',
'</ul><div class="episodes">',
'<a href="/nonton/' + SERIES + '/hnmgsws-s2-episode-1-sub-indo">Episode 1</a>',
'<a href="/nonton/' + SERIES + '/hnmgsws-s2-episode-2-sub-indo">Episode 2</a>',
'<a href="/nonton/' + SERIES + '/' + EP3 + '">Episode 3</a>',
'</div></body></html>',
].join('');

test('AnimeIndo: episode URL parser is same-origin and recognizes series/episode slugs', () => {
    assert.deepEqual(parseEpisodeRef(PAGE3, BASE), {
        seriesSlug: SERIES,
        episodeSlug: EP3,
        url: PAGE3,
    });
    assert.equal(parseEpisodeRef('https://other.example/nonton/' + SERIES + '/' + EP3, BASE), null);
    assert.equal(parseEpisodeNumber(EP3), 3);
    assert.equal(parseEpisodeNumber('episode-0'), null);
});

test('AnimeIndo: parses metadata and episode links from public HTML', async () => {
    const { load } = await import('cheerio');
    const parsed = parseAnimePage(load(html), BASE, PAGE3);
    assert.ok(parsed);
    assert.equal(parsed.anime.title, 'Hyouken no Majutsushi ga Sekai wo Suberu Season 2');
    assert.equal(parsed.anime.duration, 24);
    assert.equal(parsed.anime.status, 'ONGOING');
    assert.equal(parsed.anime.episodes, 12);
    assert.equal(parsed.anime.latestEpisode, 3);
    assert.deepEqual(parsed.anime.genres, ['Action', 'Fantasy', 'School']);
    assert.deepEqual(parsed.anime.studios, ['Zero-G']);
    assert.equal(parsed.anime.image, BASE + '/images/hyouken.jpg');
    assert.deepEqual(parsed.episodeList.map((entry) => entry.number), [1, 2, 3]);
    assert.equal(parsed.episodeList[1].url, BASE + '/nonton/' + SERIES + '/hnmgsws-s2-episode-2-sub-indo');
});

test('AnimeIndo: accepts only explicit HTTPS embeds, not direct media or worker resolvers', () => {
    const servers = parsePublicEmbedSources({
        sources: [
            { type: 'iframe_embed', label: 'Mirror A', url: 'https://player.example.test/embed/abc' },
            { type: 'direct_mp4', label: 'Direct file', url: 'https://cdn.example.test/video.mp4' },
            { type: 'player', label: 'Resolver', url: 'https://embed-resolver.example.workers.dev/' },
            { type: 'iframe', label: 'Insecure', url: 'http://player.example.test/embed/abc' },
        ],
    }, PAGE3);
    assert.deepEqual(servers.map((server) => server.name), ['Mirror A']);
    assert.equal(servers[0].url, 'https://player.example.test/embed/abc');
});

test('AnimeIndo adapter reads public source JSON and returns canonical episode shape', async () => {
    const { createClient } = fakeClientFactory({
        [PAGE3]: html,
        [BASE + '/api/anime-indo/sources/' + EP3]: {
            sources: [{ type: 'iframe_embed', label: 'Mirror A', url: 'https://player.example.test/embed/abc' }],
        },
    });
    const adapter = createAnimeIndo({ network: {}, createClient, baseUrl: BASE });
    const anime = await adapter.getAnime({ seriesSlug: SERIES, episodeSlug: EP3, url: PAGE3 });
    const episode = await adapter.getEpisode(
        { seriesSlug: SERIES, episodeSlug: EP3, url: PAGE3 },
        3,
        { anime },
    );
    assert.equal(episode.episode, 3);
    assert.equal(episode.url, PAGE3);
    assert.equal(episode.servers.length, 1);
    assert.equal(episode.servers[0].name, 'Mirror A');
    assert.equal(episode.downloads.length, 0);
});
