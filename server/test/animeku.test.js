import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import {
    createAnimeku, episodeSlugFromUrl, parseCards, parseEpisodePage, parseSeriesPage, seriesSlugFromUrl,
} from '../sources/animeku.js';
import { fakeClientFactory, fixture, fixture$ } from './helpers.js';

const BASE = 'https://ww2.animeku.lol';
const SERIES = `${BASE}/steel-ball-run-jojo-no-kimyou-na-bouken-ecxqye3/`;
const EPISODE = `${BASE}/play/steel-ball-run-jojo-no-kimyou-na-bouken-episode-6-6mzizy9/`;

test('animeku: URL /play/ dan halaman seri dikenali, halaman statis ditolak', () => {
    assert.equal(episodeSlugFromUrl(EPISODE, BASE), 'steel-ball-run-jojo-no-kimyou-na-bouken-episode-6-6mzizy9');
    assert.equal(seriesSlugFromUrl(SERIES, BASE), 'steel-ball-run-jojo-no-kimyou-na-bouken-ecxqye3');
    assert.equal(seriesSlugFromUrl(`${BASE}/genre/aksi-siacdd4/`, BASE), null);
    assert.equal(seriesSlugFromUrl(`${BASE}/dmca/`, BASE), null);
    assert.equal(episodeSlugFromUrl(SERIES, BASE), null);
});

test('animeku: beranda — kartu rilis terbaru dan kartu seri', () => {
    const { series, episodes } = parseCards(fixture$('animeku-home.html'), BASE);
    assert.ok(series.length >= 5);
    assert.ok(episodes.length >= 10);
    assert.deepEqual(
        { slug: episodes[0].slug, title: episodes[0].title, episode: episodes[0].latestEpisode },
        {
            slug: 'steel-ball-run-jojo-no-kimyou-na-bouken-episode-6-6mzizy9',
            title: 'Steel Ball Run Jojo No Kimyou Na Bouken',
            episode: 6,
        },
    );
    assert.equal(episodes[0].image, 'https://static.anipop.xyz/poster/anime/steel-ball-run-jojo-no-kimyou-na-bouken.jpg');
    const steel = series.find((card) => card.slug === 'steel-ball-run-jojo-no-kimyou-na-bouken-ecxqye3');
    assert.ok(steel, 'kartu seri dipakai untuk memetakan judul → slug seri');
    assert.equal(steel.latestEpisode, 6);
    assert.equal(steel.score, 9.1);
});

test('animeku: halaman seri — judul, status, studio, daftar episode', () => {
    const parsed = parseSeriesPage(fixture$('animeku-series.html'), BASE, {
        slug: 'steel-ball-run-jojo-no-kimyou-na-bouken-ecxqye3',
    });
    assert.ok(parsed);
    const { anime, episodeList } = parsed;
    assert.equal(anime.title, 'Steel Ball Run Jojo No Kimyou Na Bouken');
    assert.equal(anime.latestEpisode, 6);
    assert.equal(anime.episodes, 6);
    assert.equal(anime.status, 'ONGOING');
    assert.equal(anime.country, 'JP');
    assert.equal(anime.score, 9.1);
    assert.deepEqual(anime.studios, ['David Production']);
    assert.equal(anime.slug, 'animeku~steel-ball-run-jojo-no-kimyou-na-bouken-ecxqye3');
    assert.equal(anime.url, SERIES);
    assert.deepEqual(episodeList.map((e) => e.number), [1, 2, 3, 4, 5, 6]);
    assert.equal(episodeList[5].url, EPISODE);
});

test('animeku: halaman episode — iframe publik + bukti Sub Indo dari judul episode', () => {
    const parsed = parseEpisodePage(fixture$('animeku-episode.html'), BASE);
    assert.equal(parsed.title, 'Steel Ball Run Jojo No Kimyou Na Bouken Episode 6');
    assert.equal(parsed.episode, 6);
    assert.deepEqual(parsed.servers.map((s) => s.url), ['https://puterin.biz/e/G9cVc9Vutw']);
    assert.ok(parsed.servers.every((s) => s.lang === 'id' && s.subtitleEvidence === 'episode-title'));
    assert.equal(parsed.subtitleEvidence, 'episode-title');
    assert.match(parsed.subtitleEvidenceDetail, /Sub Indo/);
    assert.equal(parsed.seriesUrl, SERIES);
    assert.deepEqual(parsed.downloads, []);
});

test('animeku: judul episode tanpa "Sub Indo" → server tidak diklaim berbahasa Indonesia', () => {
    const html = fixture('animeku-episode.html').replace(/Sub Indo/g, 'Subbed');
    const parsed = parseEpisodePage(load(html), BASE);
    assert.equal(parsed.servers.length, 1);
    assert.ok(parsed.servers.every((server) => !server.lang && !server.subtitleEvidence));
    assert.equal(parsed.subtitleEvidence, '');
});

test('animeku: latest memetakan kartu episode ke slug seri bila judulnya cocok', async () => {
    const { createClient } = fakeClientFactory({ [`${BASE}/`]: fixture('animeku-home.html') });
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    const items = await adapter.latest();
    assert.ok(items.length >= 5);
    const steel = items.find((item) => item.title === 'Steel Ball Run Jojo No Kimyou Na Bouken');
    assert.ok(steel);
    assert.equal(steel.slug, 'animeku~steel-ball-run-jojo-no-kimyou-na-bouken-ecxqye3');
    assert.equal(steel.latestEpisode, 6);
    assert.ok(items.every((item) => item.slug && item.slug.startsWith('animeku~')));
});

test('animeku: slug episode → halaman seri lengkap (tautan "Semua episode")', async () => {
    const { createClient, calls } = fakeClientFactory({
        [EPISODE]: fixture('animeku-episode.html'),
        [SERIES]: fixture('animeku-series.html'),
    });
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    const anime = await adapter.getAnime({ slug: 'steel-ball-run-jojo-no-kimyou-na-bouken-episode-6-6mzizy9' });
    assert.equal(anime.title, 'Steel Ball Run Jojo No Kimyou Na Bouken');
    assert.equal(anime.slug, 'animeku~steel-ball-run-jojo-no-kimyou-na-bouken-ecxqye3');
    assert.equal(anime.url, SERIES);
    assert.equal(anime.episodeList.length, 6);
    assert.equal(anime.latestEpisode, 6);
    assert.deepEqual(calls, [EPISODE, SERIES]);
});

test('animeku: factory mengambil seri lalu episode (server + bukti)', async () => {
    const { createClient } = fakeClientFactory({
        [SERIES]: fixture('animeku-series.html'),
        [EPISODE]: fixture('animeku-episode.html'),
    });
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    const anime = await adapter.getAnime({ slug: 'steel-ball-run-jojo-no-kimyou-na-bouken-ecxqye3' });
    assert.equal(anime.title, 'Steel Ball Run Jojo No Kimyou Na Bouken');
    assert.equal(anime.episodeList.length, 6);

    const ep = await adapter.getEpisode({ slug: 'steel-ball-run-jojo-no-kimyou-na-bouken-ecxqye3' }, 6, { anime });
    assert.equal(ep.episode, 6);
    assert.equal(ep.servers[0].url, 'https://puterin.biz/e/G9cVc9Vutw');
    assert.equal(ep.servers[0].lang, 'id');
    assert.equal(ep.servers[0].subtitleEvidence, 'episode-title');
});

test('animeku: ref tidak valid ditolak; episode di luar daftar → not_found', async () => {
    const { createClient } = fakeClientFactory({});
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    assert.equal(adapter.parseRef(['Bukan Slug!']), null);
    assert.deepEqual(adapter.parseRef(['sousou-no-frieren']), { slug: 'sousou-no-frieren' });
    await assert.rejects(
        () => adapter.getEpisode({ slug: 'sousou-no-frieren' }, 99, { anime: { episodeList: [] } }),
        (err) => err.kind === 'not_found',
    );
});
