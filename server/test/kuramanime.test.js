import test from 'node:test';
import assert from 'node:assert/strict';
import { animeRefFromUrl, createKuramanime, parseCards, parseDetail, parseDownloads, parseEpisodePage } from '../sources/kuramanime.js';
import { fakeClientFactory, fixture, fixture$ } from './helpers.js';

// Fixture kuramanime SINTETIS — situs asli memblokir bot ini (lihat komentar di fixture).
const BASE = 'https://v20.kuramanime.ing';

test('kuramanime: kartu daftar (data-setbg & background-image), link non-anime dilewati', () => {
    const cards = parseCards(fixture$('kuramanime-list.html'), BASE);
    assert.equal(cards.length, 2);
    assert.deepEqual(
        { id: cards[0].id, slug: cards[0].slug, title: cards[0].title, image: cards[0].image, latest: cards[0].latestEpisode, total: cards[0].episodes, status: cards[0].status, format: cards[0].format },
        { id: '2468', slug: 'sousou-no-frieren', title: 'Sousou no Frieren', image: 'https://r2.kuramanime.ing/poster/frieren.jpg', latest: 28, total: 28, status: 'COMPLETED', format: 'TV' },
    );
    assert.equal(cards[1].image, 'https://r2.kuramanime.ing/poster/kusuriya3.jpg');
    assert.equal(cards[1].url, 'https://v20.kuramanime.ing/anime/4012/kusuriya-no-hitorigoto-season-3');
    assert.equal(cards[1].status, 'ONGOING');
    assert.equal(cards[1].episodes, null);
});

test('kuramanime: detail (dua varian baris info) + episode dari #episodeLists[data-content]', () => {
    const r = parseDetail(fixture$('kuramanime-detail.html'), BASE, { id: '2468', slug: 'sousou-no-frieren' });
    const a = r.anime;
    assert.equal(a.title, 'Sousou no Frieren');
    assert.equal(a.titleAlt, "Frieren: Beyond Journey's End");
    assert.equal(a.image, 'https://r2.kuramanime.ing/poster/frieren.jpg');
    assert.equal(a.status, 'COMPLETED');
    assert.equal(a.episodes, 28);
    assert.equal(a.latestEpisode, 28);
    assert.equal(a.format, 'TV');
    assert.equal(a.year, 2023);
    assert.equal(a.duration, 24);
    assert.equal(a.country, 'JP');
    assert.equal(a.score, 9.3);
    assert.deepEqual(a.genres, ['Adventure', 'Drama', 'Fantasy']);
    assert.deepEqual(a.studios, ['Madhouse']);
    assert.match(a.description, /Penyihir elf Frieren/);
    assert.equal(a.slug, 'kuramanime~2468~sousou-no-frieren');
    assert.deepEqual(r.episodeList.map((e) => e.number), [1, 2, 3, 27, 28]);
    assert.equal(r.episodeList[0].url, 'https://v20.kuramanime.ing/anime/2468/sousou-no-frieren/episode/1');
    assert.equal(parseDetail(fixture$('kuramanime-list.html'), BASE, { id: '1', slug: 'x' }), null);
});

test('kuramanime: download #animeDownloadLink (link non-aktif & javascript: dibuang)', () => {
    const d = parseDownloads(fixture$('kuramanime-episode.html'), BASE);
    assert.deepEqual(d.map((g) => [g.quality, g.format, g.size, g.subtitle, g.links.map((l) => l.provider)]), [
        ['480p', 'MKV', '147.85 MB', 'Softsub Indo', ['Pixeldrain', 'Acefile']],
        ['720p', 'MP4', '220.4 MB', 'Hardsub Indo', ['Pixeldrain']],
    ]);
});

test('kuramanime: player dilindungi token (data-kk) → tidak ada server, ditandai protectedPlayer', () => {
    const p = parseEpisodePage(fixture$('kuramanime-episode.html'), BASE);
    assert.equal(p.servers.length, 0);
    assert.equal(p.protectedPlayer, true);
    assert.equal(p.title, 'Sousou no Frieren (Episode 28)');
});

test('kuramanime: player publik (iframe + mp4; m3u8 dilewati)', () => {
    const p = parseEpisodePage(fixture$('kuramanime-episode-public.html'), BASE);
    assert.deepEqual(p.servers.map((s) => [s.name, s.url]), [
        ['Kuramanime', 'https://filemoon.sx/e/abc123def'],
        ['Kuramadrive 720p', 'https://kuramadrive.com/kdrive/kusuriya3-03-720.mp4'],
    ]);
    assert.equal(p.protectedPlayer, false);
});

test('kuramanime: animeRefFromUrl', () => {
    assert.deepEqual(animeRefFromUrl('/anime/12/abc-def', BASE), { id: '12', slug: 'abc-def' });
    assert.equal(animeRefFromUrl('/anime/12/abc-def/episode/3', BASE), null);
    assert.equal(animeRefFromUrl('/properties/genre/action', BASE), null);
});

test('kuramanime adapter: rute URL, slug 2 bagian, notice player terlindungi, kebijakan robots ketat', async () => {
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/anime?order_by=updated&page=1`]: fixture('kuramanime-list.html'),
        [`${BASE}/anime?order_by=latest&search=frieren&page=1`]: fixture('kuramanime-list.html'),
        [`${BASE}/anime/2468/sousou-no-frieren`]: fixture('kuramanime-detail.html'),
        [`${BASE}/anime/2468/sousou-no-frieren/episode/28`]: fixture('kuramanime-episode.html'),
    });
    let clientOpts;
    const a = createKuramanime({ network: {}, createClient: (n, o) => { clientOpts = o; return createClient(n, o); }, baseUrl: BASE });
    assert.equal(clientOpts.requireExplicitRobots, true, 'ToS "unknown" → robots.txt wajib terbaca & mengizinkan');
    assert.deepEqual(clientOpts.allowedHosts, ['v20.kuramanime.ing']);

    const latest = await a.latest();
    assert.equal(latest[0].slug, 'kuramanime~2468~sousou-no-frieren');
    assert.equal((await a.search('frieren')).length, 2);

    const ref = a.parseRef(['2468', 'sousou-no-frieren']);
    assert.deepEqual(ref, { id: '2468', slug: 'sousou-no-frieren' });
    assert.equal(a.parseRef(['abc', 'x']), null);
    assert.equal(a.parseRef(['12']), null);

    const anime = await a.getAnime(ref);
    const ep = await a.getEpisode(ref, 28, { anime });
    assert.equal(ep.servers.length, 0);
    assert.equal(ep.downloads.length, 2);
    assert.match(ep.notice, /token anti-bot/);
    await assert.rejects(a.getEpisode(ref, 15, { anime }), (e) => e.kind === 'not_found', 'episode tidak ada di daftar → tanpa request');
    assert.ok(!calls.some((u) => u.endsWith('/episode/15')));
});
