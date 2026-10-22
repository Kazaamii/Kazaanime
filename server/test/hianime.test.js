import test from 'node:test';
import assert from 'node:assert/strict';
import {
    STATIC_EMBED_HOSTS, animeSlugFromUrl, createHianime, parseAnimePage, parseCards, parseEpisodeListHtml, parseServersHtml, parseWatchUrl,
} from '../sources/hianime.js';
import { fakeClientFactory, fixture, fixture$ } from './helpers.js';

const BASE = 'https://hianime.ro';
const REST = `${BASE}/wp-json/v1/otakuthemes`;

test('hianime.ro: kartu Recently Updated & pencarian asli (slug, ID post anime, judul alternatif)', () => {
    const latest = parseCards(fixture$('hianime-latest.html'), BASE);
    assert.equal(latest.length, 4);
    assert.equal(latest[0].slug, 'a-returners-magic-should-be-special-season-2');
    assert.equal(latest[0].animeId, 215603);
    assert.equal(latest[0].latestEpisode, 3);
    assert.equal(latest[0].titleAlt, 'Kikansha no Mahou wa Tokubetsu desu 2nd Season');
    const search = parseCards(fixture$('hianime-search.html'), BASE);
    assert.equal(search.length, 4);
    assert.equal(search[0].url, 'https://hianime.ro/anime/one-piece-umi-no-heso-no-daibouken-hen/');
    assert.equal(search[0].format, 'SPECIAL');
    assert.equal(search[0].duration, 49);
});

test('hianime.ro: helper URL', () => {
    assert.deepEqual(parseWatchUrl('https://hianime.ro/watch/cyberpunk-edgerunners-2-episode-1-english-sub-215886/'), { seriesSlug: 'cyberpunk-edgerunners-2', episode: 1, postId: 215886 });
    assert.equal(parseWatchUrl('https://hianime.ro/anime/x/'), null);
    assert.equal(animeSlugFromUrl('https://hianime.ro/anime/cyberpunk-edgerunners-2/', BASE), 'cyberpunk-edgerunners-2');
    assert.equal(animeSlugFromUrl('https://evil.example/anime/x/', BASE), null);
});

test('hianime.ro: halaman anime asli → detail + ID post dari shortlink; REST daftar episode', () => {
    const a = parseAnimePage(fixture$('hianime-anime.html'), BASE, 'cyberpunk-edgerunners-2');
    assert.equal(a.animeId, 215883);
    assert.equal(a.anime.title, 'Cyberpunk: Edgerunners 2');
    assert.equal(a.anime.status, 'COMPLETED');
    assert.equal(a.anime.score, 8.2);
    assert.deepEqual(a.anime.genres, ['Action', 'Drama', 'Sci-Fi']);
    const eps = parseEpisodeListHtml(JSON.parse(fixture('hianime-eplist.json')).html, BASE);
    assert.equal(eps.length, 10);
    assert.equal(eps[0].url, 'https://hianime.ro/watch/cyberpunk-edgerunners-2-episode-1-english-sub-215886/');
});

test('hianime.ro: REST server asli → hanya "sub", tanpa host yang sudah jadi cadangan statis', () => {
    const servers = parseServersHtml(JSON.parse(fixture('hianime-servers.json')).html);
    assert.deepEqual(servers.map((s) => s.name), ['Fast', 'mega']);
    assert.ok(servers.every((s) => s.lang === 'en'));
    assert.ok(servers.every((s) => !STATIC_EMBED_HOSTS.some((h) => s.url.includes(h))), 'MegaPlay-MAL tidak masuk lewat jalur belakang');
});

test('hianime.ro adapter: search → getAnime (REST episode) → getEpisode (REST server)', async () => {
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/?s=cyberpunk`]: fixture('hianime-search.html'),
        [`${BASE}/recently-updated/`]: fixture('hianime-latest.html'),
        [`${BASE}/anime/cyberpunk-edgerunners-2/`]: fixture('hianime-anime.html'),
        [`${REST}/episode/list/215883`]: fixture('hianime-eplist.json'),
        [`${REST}/episode/servers?episodeId=215886`]: fixture('hianime-servers.json'),
    });
    const h = createHianime({ network: {}, createClient, baseUrl: BASE });
    const latest = await h.latest();
    assert.equal(latest[0].slug, 'hianime~a-returners-magic-should-be-special-season-2~215603');
    assert.ok((await h.search('cyberpunk')).length > 0);
    const ref = h.parseRef(['cyberpunk-edgerunners-2']);
    const anime = await h.getAnime(ref);
    assert.equal(anime.slug, 'hianime~cyberpunk-edgerunners-2~215883');
    assert.equal(anime.latestEpisode, 10);
    assert.equal(anime.episodes, 10, 'status Completed → total = episode terakhir');
    const ep = await h.getEpisode(ref, 1, { anime });
    assert.deepEqual(ep.servers.map((s) => s.name), ['Fast', 'mega']);
    assert.ok(calls.includes(`${REST}/episode/servers?episodeId=215886`));
    await assert.rejects(h.getEpisode(ref, 99, { anime }), (e) => e.kind === 'not_found');
});

test('hianime.ro adapter: parseRef menerima "slug" & "slug~id", menolak sisanya', () => {
    const { createClient } = fakeClientFactory({});
    const h = createHianime({ network: {}, createClient, baseUrl: BASE });
    assert.deepEqual(h.parseRef(['one-piece']), { slug: 'one-piece', animeId: null });
    assert.deepEqual(h.parseRef(['one-piece', '123']), { slug: 'one-piece', animeId: 123 });
    assert.equal(h.parseRef(['one-piece', '12x']), null);
    assert.equal(h.parseRef(['a', '1', '2']), null);
});
