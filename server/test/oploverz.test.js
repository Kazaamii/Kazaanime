import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import {
    createOploverz, episodeSlugFromUrl, isEpisodeSlug, parseAnimePage,
    parseCards, parseEpisodePage, seriesSlugFromUrl,
} from '../sources/oploverz.js';
import { fixture, fixture$, fakeClientFactory } from './helpers.js';

const BASE = 'https://oploverz.ch';

test('oploverz: URL episode & seri dikenali, path lain ditolak', () => {
    assert.equal(episodeSlugFromUrl(`${BASE}/toaru-anbu-no-item-episode-3-subtitle-indonesia/`, BASE),
        'toaru-anbu-no-item-episode-3-subtitle-indonesia');
    assert.equal(seriesSlugFromUrl(`${BASE}/series/toaru-anbu-no-item/`, BASE), 'toaru-anbu-no-item');
    assert.equal(episodeSlugFromUrl(`${BASE}/series/toaru-anbu-no-item/`, BASE), null);
    assert.equal(seriesSlugFromUrl(`${BASE}/toaru-anbu-no-item-episode-3-subtitle-indonesia/`, BASE), null);
    assert.equal(isEpisodeSlug('toaru-anbu-no-item-episode-3-subtitle-indonesia'), true);
    assert.equal(isEpisodeSlug('toaru-anbu-no-item'), false);
});

test('oploverz: kartu beranda — judul seri, judul episode, nomor, gambar', () => {
    const cards = parseCards(fixture$('oploverz-home.html'), BASE);
    assert.equal(cards.length, 8);
    assert.deepEqual(
        {
            slug: cards[0].slug,
            kind: cards[0].kind,
            title: cards[0].title,
            episodeTitle: cards[0].episodeTitle,
            episode: cards[0].latestEpisode,
            image: cards[0].image,
        },
        {
            slug: 'toaru-anbu-no-item-episode-3-subtitle-indonesia',
            kind: 'episode',
            title: 'Toaru Anbu no Item',
            episodeTitle: 'Toaru Anbu no Item Episode 3 Subtitle Indonesia',
            episode: 3,
            image: 'https://oploverz.ch/wp-content/uploads/2026/10/1791565635-7289-159988.jpg',
        },
    );
    assert.ok(cards.every((card) => card.latestEpisode >= 1));
});

test('oploverz: halaman seri — info, genre, studio, daftar episode', () => {
    const parsed = parseAnimePage(fixture$('oploverz-series.html'), BASE, { slug: 'toaru-anbu-no-item' });
    assert.ok(parsed);
    const { anime, episodeList } = parsed;
    assert.equal(anime.title, 'Toaru Anbu no Item');
    assert.match(anime.titleAlt, /A Certain Dark Item/);
    assert.ok(!anime.titleAlt.includes('&#'), 'entitas HTML ganda harus didekode');
    assert.equal(anime.latestEpisode, 3);
    assert.equal(anime.episodes, 3);
    assert.equal(anime.status, 'ONGOING');
    assert.equal(anime.year, 2026);
    assert.equal(anime.country, 'JP');
    assert.deepEqual(anime.studios, ['J.C.Staff']);
    assert.ok(anime.genres.includes('Action'));
    assert.equal(anime.slug, 'oploverz~toaru-anbu-no-item');
    assert.match(anime.url, /\/series\/toaru-anbu-no-item\/$/);
    assert.deepEqual(episodeList.map((e) => e.number), [1, 2, 3]);
    assert.equal(episodeList[2].released, 'October 21, 2026');
    assert.equal(episodeList[2].url, `${BASE}/toaru-anbu-no-item-episode-3-subtitle-indonesia/`);
});

test('oploverz: halaman episode — server publik + bukti Sub Indo dari judul episode', () => {
    const parsed = parseEpisodePage(fixture$('oploverz-episode.html'), BASE);
    assert.equal(parsed.title, 'Toaru Anbu no Item Episode 3 Subtitle Indonesia');
    assert.equal(parsed.episode, 3);
    assert.ok(parsed.servers.length >= 1);
    assert.ok(parsed.servers.every((server) => server.lang === 'id'));
    assert.ok(parsed.servers.every((server) => server.subtitleEvidence === 'episode-title'));
    assert.equal(parsed.subtitleEvidence, 'episode-title');
    assert.match(parsed.subtitleEvidenceDetail, /Subtitle Indonesia/);
    assert.equal(parsed.seriesUrl, `${BASE}/series/toaru-anbu-no-item/`);
    assert.deepEqual(parsed.downloads, [], 'halaman contoh tidak punya tautan unduhan');
    assert.deepEqual(parsed.episodeList.map((e) => e.number), [1, 2, 3]);
});

test('oploverz: slug episode tetap menghasilkan detail seri (judul + seluruh episode)', () => {
    const parsed = parseAnimePage(fixture$('oploverz-episode.html'), BASE, {
        slug: 'toaru-anbu-no-item-episode-3-subtitle-indonesia',
    });
    assert.ok(parsed);
    assert.equal(parsed.anime.title, 'Toaru Anbu no Item');
    assert.equal(parsed.anime.latestEpisode, 3);
    assert.deepEqual(parsed.episodeList.map((e) => e.number), [1, 2, 3]);
    assert.equal(parsed.anime.slug, 'oploverz~toaru-anbu-no-item-episode-3-subtitle-indonesia');
});

test('oploverz: tanpa penanda bahasa di halaman episode, server tidak diklaim Sub Indo', () => {
    const html = fixture('oploverz-episode.html').replace(/Subtitle Indonesia/g, 'Subbed');
    const stripped = parseEpisodePage(load(html), BASE);
    assert.ok(stripped.servers.length >= 1);
    assert.ok(stripped.servers.every((server) => !server.lang && !server.subtitleEvidence));
    assert.equal(stripped.subtitleEvidence, '');
});

test('oploverz: factory memakai halaman seri untuk detail dan halaman episode untuk server', async () => {
    const calls = [];
    const { createClient } = fakeClientFactory({
        [`${BASE}/`]: fixture('oploverz-home.html'),
        [`${BASE}/series/toaru-anbu-no-item/`]: fixture('oploverz-series.html'),
        [`${BASE}/toaru-anbu-no-item-episode-3-subtitle-indonesia/`]: fixture('oploverz-episode.html'),
    });
    const adapter = createOploverz({ network: null, createClient, baseUrl: BASE });
    const latest = await adapter.latest();
    assert.ok(latest.length >= 3);
    assert.equal(latest[0].title, 'Toaru Anbu no Item');
    assert.equal(latest[0].latestEpisode, 3);
    assert.match(latest[0].slug, /^oploverz~toaru-anbu-no-item-episode-3-subtitle-indonesia$/);

    const anime = await adapter.getAnime({ slug: 'toaru-anbu-no-item' });
    assert.equal(anime.title, 'Toaru Anbu no Item');
    assert.deepEqual(anime.episodeList.map((e) => e.number), [1, 2, 3]);

    const ep = await adapter.getEpisode({ slug: 'toaru-anbu-no-item' }, 3, { anime });
    assert.equal(ep.episode, 3);
    assert.equal(ep.servers[0].lang, 'id');
    assert.equal(ep.servers[0].subtitleEvidence, 'episode-title');
    calls.push(...latest.map((item) => item.slug));
    assert.equal(calls.length, latest.length);
});

test('oploverz: ref tidak valid ditolak, episode tak dikenal → not_found', async () => {
    const { createClient } = fakeClientFactory({});
    const adapter = createOploverz({ network: null, createClient, baseUrl: BASE });
    assert.equal(adapter.parseRef(['Bad Slug!']), null);
    assert.deepEqual(adapter.parseRef(['toaru-anbu-no-item']), { slug: 'toaru-anbu-no-item' });
    await assert.rejects(
        () => adapter.getEpisode({ slug: 'toaru-anbu-no-item' }, 9, { anime: { episodeList: [] } }),
        (err) => err.kind === 'not_found',
    );
});
