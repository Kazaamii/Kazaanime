import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import {
    createAnimeku, DONGHUA_SEEDS, episodeSlugFromUrl, parseCards, parseEpisodePage, parsePagination,
    parseSeriesPage, seriesSlugFromUrl,
} from '../sources/animeku.js';
import { fakeClientFactory, fixture, fixture$ } from './helpers.js';
import { stripSeason, titleKey } from '../lib/text.js';

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

test('animeku: halaman daftar — 12 kartu + paginasi /page/N/', () => {
    const page = fixture$('animeku-baru.html');
    const { series } = parseCards(page, BASE);
    assert.equal(series.length, 12);
    assert.equal(series[0].slug, 'kusuriya-no-hitorigoto-3rd-season-y6ecsbw');
    assert.equal(series[0].latestEpisode, 4);
    assert.equal(series[0].url, `${BASE}/kusuriya-no-hitorigoto-3rd-season-y6ecsbw/`);

    const pagination = parsePagination(page, BASE, '/baru-utnwb9y/');
    assert.equal(pagination.nextPath, `${BASE}/baru-utnwb9y/page/2/`);
    assert.equal(pagination.lastPage, 133);
});

test('animeku: katalog memakai menu untuk menemukan path berurutan, bukan path hard-code', async () => {
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/`]: fixture('animeku-home.html'),
        [`${BASE}/baru-utnwb9y/`]: fixture('animeku-baru.html'),
    });
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    const page = await adapter.browse({ filter: 'baru', page: 1 });
    assert.equal(page.items.length, 12);
    assert.equal(page.items[0].title, 'Kusuriya No Hitorigoto 3Rd Season');
    assert.equal(page.items[0].slug, 'animeku~kusuriya-no-hitorigoto-3rd-season-y6ecsbw');
    assert.equal(page.items[0].latestEpisode, 4);
    assert.equal(page.hasNext, true);
    assert.deepEqual(page.filters.map((f) => f.id),
        ['baru', 'populer', 'favorit', 'selesai', 'ongoing', 'film', 'donghua'],
        'urutan bagian: Terbaru → New Anime Populer → Top Favorit → Complete (+ Ongoing/Movie/Donghua)');
    // 24 Okt 2026: 23 genre slug terverifikasi (yang 404 / arsipnya kosong tidak dimasukkan).
    assert.equal(page.genres.length, 23);
    assert.ok(page.genres.some((genre) => genre.id === 'aksi' && genre.label === 'Aksi'));
    assert.equal(page.genres.some((genre) => genre.id === 'sci-fi'), false, 'slug 404 tidak ditawarkan');
    assert.deepEqual(page.seasons, [], 'AnimeKu tidak punya filter musim');
    assert.deepEqual(calls, [`${BASE}/`, `${BASE}/baru-utnwb9y/`]);
});

test('animeku: genre dibuka lewat slug arsip `/genre/<slug>/` (24 Okt 2026)', async () => {
    const genreUrl = `${BASE}/genre/fantasi/`;
    const genreUrlPage2 = `${BASE}/genre/fantasi/page/2/`;
    const { createClient, calls } = fakeClientFactory({
        [genreUrl]: fixture('animeku-baru.html'),
        [genreUrlPage2]: fixture('animeku-baru.html'),
    });
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    const page = await adapter.browse({ genre: 'fantasi', page: 1 });

    assert.deepEqual(calls, [genreUrl], 'slug langsung dipakai (situs mengalihkan ke arsip bertoken)');
    assert.equal(page.genre, 'fantasi');
    assert.equal(page.genres.length, 23);
    assert.ok(page.items.length > 0, 'kartu arsip genre dipetakan seperti daftar biasa');
    assert.equal(page.seasons.length, 0);

    const page2 = await adapter.browse({ genre: 'fantasi', page: 2 });
    assert.deepEqual(calls, [genreUrl, genreUrlPage2], 'halaman berikutnya memakai /page/N/');

    // Genre yang tidak ada di katalog ditolak, bukan ditebak URL-nya.
    await assert.rejects(() => adapter.browse({ genre: 'genre-karangan' }), /tidak tersedia/i);
    await assert.rejects(() => adapter.browse({ genre: 'sci-fi' }), /tidak tersedia/i);
});

test('animeku: New Anime Populer = daftar Baru diurutkan skor tertinggi', async () => {
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/`]: fixture('animeku-home.html'),
        [`${BASE}/baru-utnwb9y/`]: fixture('animeku-baru.html'),
    });
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    const page = await adapter.browse({ filter: 'populer', page: 1 });
    const scores = page.items.map((item) => item.score ?? -1);
    assert.ok(scores.length > 1);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'kartu urut skor menurun');
    assert.equal(page.filter, 'populer');
    assert.equal(page.items.every((item) => item.status === 'ONGOING'), true);
    assert.deepEqual(calls, [`${BASE}/`, `${BASE}/baru-utnwb9y/`],
        'token populer memakai halaman Baru, bukan Favorit');
});

/**
 * Donghua: situs tidak punya kategori donghua (halaman /negara/china/ kosong), jadi adapter
 * mencari judul donghua tayang di halaman pencarian dan hanya memakai kartu yang cocok.
 */
test('animeku: donghua dicari per judul, kartu lain dibuang, negara CN', async () => {
    const searchHtml = `
        <article class="aku-sel"><a class="aku-bing" href="https://ww2.animeku.lol/douluo-dalu-cq4dfat/"><img src="https://static.anipop.xyz/poster/anime/douluo.jpg" alt="Douluo Dalu"><span class="aku-eps">Eps 267.5</span><span class="aku-nilai">7.5</span></a><h3><a href="https://ww2.animeku.lol/douluo-dalu-cq4dfat/">Douluo Dalu</a></h3></article>
        <article class="aku-sel"><a class="aku-bing" href="https://ww2.animeku.lol/douluo-dalu-hanhai-qian-kun-9evm7ny/"><img src="https://static.anipop.xyz/poster/anime/douluo2.jpg" alt="Douluo Dalu: Hanhai Qian Kun"><span class="aku-eps">Eps 9</span></a><h3><a href="https://ww2.animeku.lol/douluo-dalu-hanhai-qian-kun-9evm7ny/">Douluo Dalu: Hanhai Qian Kun</a></h3></article>
        <article class="aku-sel"><a class="aku-bing" href="https://ww2.animeku.lol/one-piece-x7k4n6u/"><img src="https://static.anipop.xyz/poster/anime/onepiece.jpg" alt="One Piece"><span class="aku-eps">Eps 1100</span></a><h3><a href="https://ww2.animeku.lol/one-piece-x7k4n6u/">One Piece</a></h3></article>`;
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/?s=Douluo+Dalu`]: searchHtml,
        [`${BASE}/?s=Douluo+Dalu%3A+Hanhai+Qian+Kun`]: searchHtml,
    });
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    const items = await adapter.browseDonghua(['Douluo Dalu', 'Douluo Dalu: Hanhai Qian Kun'], {});
    assert.deepEqual(items.map((item) => item.title), ['Douluo Dalu', 'Douluo Dalu: Hanhai Qian Kun'],
        'kartu non-donghua (One Piece) tidak ikut, duplikat dibuang');
    assert.equal(items.every((item) => item.country === 'CN'), true, 'ditandai CN karena berasal dari daftar donghua metadata');
    assert.equal(items[0].slug, 'animeku~douluo-dalu-cq4dfat');
    assert.equal(calls.length, 2, 'satu request pencarian per judul');
});

test('animeku: menyediakan seed donghua untuk registry (24 Okt 2026)', () => {
    const { createClient } = fakeClientFactory({});
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    assert.deepEqual([...adapter.donghuaSeeds], [...DONGHUA_SEEDS]);
    assert.ok(adapter.donghuaSeeds.includes('Douluo Dalu'), 'seed berisi franchise yang terbukti ada di AnimeKu');
    assert.ok(adapter.donghuaSeeds.length >= 3);
});

test('animeku: seed cocok dengan judul asli hasil pencarian situs (24 Okt 2026)', () => {
    // Judul diambil dari respons produksi `browse?source=animeku&q=Douluo` (24 Okt 2026).
    const real = [
        'Douluo Dalu: Hanhai Qian Kun', 'Douluo Dalu: Xiaowu Juebie', 'Douluo Dalu: Hao Tian Yang Wei',
        'Douluo Dalu: Qian Hua Xi Jin', 'Douluo Dalu: Xingdou Xian Ji Pian', 'Douluo Dalu', 'Douluo Dalu: Jingying Sai',
    ];
    const key = titleKey(stripSeason('Douluo Dalu'));
    assert.ok(key.length >= 5);
    real.forEach((title) => {
        assert.ok(titleKey(title).includes(key), `${title} harus cocok dengan seed "Douluo Dalu"`);
    });
});

test('animeku: donghua tanpa judul → daftar kosong tanpa request', async () => {
    const { createClient, calls } = fakeClientFactory({});
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    assert.deepEqual(await adapter.browseDonghua([], {}), []);
    assert.deepEqual(await adapter.browseDonghua(['  '], {}), []);
    assert.deepEqual(calls, []);
});

test('animeku: tidak mengarang halaman genre/coming soon', async () => {
    const { createClient } = fakeClientFactory({});
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    const ids = adapter.browseOptions().filters.map((f) => f.id);
    assert.equal(ids.includes('donghua'), true, 'donghua memang ditawarkan (deteksi lewat metadata)');
    for (const missing of ['coming', 'genre', 'jadwal', 'upcoming']) {
        assert.equal(ids.includes(missing), false, `${missing} tidak boleh ada di daftar filter`);
    }
    await assert.rejects(() => adapter.browse({ filter: 'baru', genre: 'action' }),
        (err) => err.kind === 'bad_request');
});

test('animeku: filter Complete memakai halaman /selesai/ dari menu + status COMPLETED', async () => {
    const { createClient } = fakeClientFactory({
        [`${BASE}/`]: fixture('animeku-home.html'),
        [`${BASE}/selesai-bjyzaqn/page/2/`]: fixture('animeku-baru.html'),
    });
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    // Panggilan pertama membaca menu beranda (cache 6 jam), lalu halaman /selesai/page/2/.
    const page = await adapter.browse({ filter: 'selesai', page: 2 });
    assert.equal(page.filter, 'selesai');
    assert.equal(page.items.length, 12);
    assert.equal(page.items[0].status, 'COMPLETED');
});

test('animeku: genre diminta → bad_request (situs tidak punya arsip genre)', async () => {
    const { createClient } = fakeClientFactory({});
    const adapter = createAnimeku({ network: null, createClient, baseUrl: BASE });
    await assert.rejects(
        () => adapter.browse({ filter: 'baru', genre: 'action' }),
        (err) => err.kind === 'bad_request',
    );
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
