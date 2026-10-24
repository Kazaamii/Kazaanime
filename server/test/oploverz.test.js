import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import {
    createOploverz, DONGHUA_SEEDS, episodeSlugFromUrl, isEpisodeSlug, nextPageHref, parseAnimePage,
    parseCards, parseEpisodePage, parseGenreOptions, parseSeasonOptions, seriesSlugFromUrl,
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

test('oploverz: daftar /series/ — 80 genre, tautan halaman berikutnya', () => {
    const page = fixture$('oploverz-series-list.html');
    const genres = parseGenreOptions(page);
    assert.equal(genres.length, 80);
    assert.deepEqual(genres[0], { id: 'action', label: 'Action' });
    assert.ok(genres.some((g) => g.id === 'slice-of-life' && g.label === 'Slice of Life'));
    assert.equal(nextPageHref(page, BASE), `${BASE}/series/page/2/`);
});

test('oploverz: katalog — filter urutan, genre, dan paginasi membentuk URL situs', async () => {
    const list = fixture('oploverz-series-list.html');
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/series/?order=popular`]: list,
        [`${BASE}/series/?order=update&genre%5B%5D=action`]: list,
        [`${BASE}/series/page/2/?status=completed`]: list,
    });
    const adapter = createOploverz({ network: null, createClient, baseUrl: BASE });

    const popular = await adapter.browse({ filter: 'popular', page: 1 });
    assert.equal(popular.items.length, 6);
    assert.equal(popular.items[0].title, 'Toaru Anbu no Item');
    assert.equal(popular.items[0].slug, 'oploverz~toaru-anbu-no-item');
    assert.equal(popular.items[0].status, 'ONGOING');
    assert.equal(popular.items[0].latestEpisode, null, 'kartu seri tidak punya nomor episode');
    assert.equal(popular.hasNext, true);
    assert.equal(popular.genres.length, 80);
    assert.deepEqual(popular.filters.map((f) => f.id), ['update', 'popular', 'rating', 'ongoing', 'completed', 'movie']);

    const byGenre = await adapter.browse({ filter: 'update', genre: 'action' });
    assert.equal(byGenre.genre, 'action');
    assert.deepEqual(calls, [`${BASE}/series/?order=popular`, `${BASE}/series/?order=update&genre%5B%5D=action`]);

    const page2 = await adapter.browse({ filter: 'completed', page: 2 });
    assert.equal(page2.filter, 'completed');
    assert.equal(page2.page, 2);
    assert.equal(calls[2], `${BASE}/series/page/2/?status=completed`);
});

test('oploverz: musim dibaca dari form filter (season[] = fall-2026, 24 Okt 2026)', () => {
    const $ = load(`<form>
        <input type="checkbox" id="s-fall-2026" name="season[]" value="fall-2026">
        <label for="s-fall-2026">Fall 2026</label>
        <input type="checkbox" id="s-summer-2026" name="season[]" value="summer-2026">
        <label for="s-summer-2026">Summer 2026</label>
        <input type="checkbox" id="s-fall-2025" name="season[]" value="fall-2025">
        <label for="s-fall-2025">Fall 2025</label>
        <input type="checkbox" id="s-rusak" name="season[]" value="bukan-musim">
    </form>`);
    const seasons = parseSeasonOptions($);
    assert.deepEqual(seasons.map((season) => season.id), ['fall-2026', 'summer-2026', 'fall-2025'],
        'urut tahun terbaru lalu Winter→Fall, nilai aneh diabaikan');
    assert.deepEqual(seasons[0], { id: 'fall-2026', label: 'Fall 2026', season: 'fall', year: 2026 });
});

test('oploverz: filter tahun & musim diteruskan sebagai season[] ke situs', async () => {
    const list = fixture('oploverz-series-list.html');
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/series/?order=update&season%5B%5D=fall-2026`]: list,
        [`${BASE}/series/?order=popular&season%5B%5D=winter-2020&season%5B%5D=spring-2020&season%5B%5D=summer-2020&season%5B%5D=fall-2020`]: list,
    });
    const adapter = createOploverz({ network: null, createClient, baseUrl: BASE });

    const bySeason = await adapter.browse({ filter: 'update', season: 'fall', year: 2026 });
    assert.equal(bySeason.season, 'fall');
    assert.equal(bySeason.year, '2026');
    assert.equal(calls[0], `${BASE}/series/?order=update&season%5B%5D=fall-2026`);

    const byYear = await adapter.browse({ filter: 'popular', year: 2020 });
    assert.equal(calls[1],
        `${BASE}/series/?order=popular&season%5B%5D=winter-2020&season%5B%5D=spring-2020&season%5B%5D=summer-2020&season%5B%5D=fall-2020`,
        'tanpa musim: empat musim pada tahun itu diminta sekaligus');
    assert.equal(byYear.items.length > 0, true);
});

test('oploverz: donghua dicari lewat ?s= dan hanya judul yang cocok dipakai (24 Okt 2026)', async () => {
    const card = (slug, title) => `<article class="bs"><div class="bsx">
        <a href="${BASE}/series/${slug}/" title="${title}">
            <div class="limit"><span class="epx">Ongoing</span><img src="${BASE}/img/${slug}.jpg"/></div>
            <div class="tt">${title}<h2>${title}</h2></div>
        </a></div></article>`;
    const results = `<html><body>${card('perfect-world', 'Perfect World')}${card('tenmaku-no-jaadugar', 'Tenmaku no Jaadugar')}</body></html>`;
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/?s=Perfect+World`]: results,
    });
    const adapter = createOploverz({ network: null, createClient, baseUrl: BASE });
    const items = await adapter.browseDonghua(['Perfect World', 'Perfect World']);

    assert.equal(calls.length, 1, 'judul ganda cukup satu permintaan');
    assert.deepEqual(items.map((item) => item.slug), ['oploverz~perfect-world']);
    assert.equal(items[0].country, 'CN', 'donghua ditandai CN hanya karena cocok dengan judul metadata');
});

test('oploverz: donghua punya benih situs sendiri (putaran 20, tanpa metadata AniList)', async () => {
    const card = (slug, title) => `<article class="bs"><div class="bsx">
        <a href="${BASE}/series/${slug}/" title="${title}">
            <div class="limit"><span class="epx">Ongoing</span><img src="${BASE}/img/${slug}.jpg"/></div>
            <div class="tt">${title}<h2>${title}</h2></div>
        </a></div></article>`;
    const results = `<html><body>${card('perfect-world', 'Perfect World')}</body></html>`;
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/?s=Perfect+World`]: results,
    });
    const adapter = createOploverz({ network: null, createClient, baseUrl: BASE });

    assert.deepEqual([...adapter.donghuaSeeds], [...DONGHUA_SEEDS], 'adapter wajib meneruskan benih');
    assert.ok(adapter.donghuaSeeds.includes('Perfect World'));
    assert.ok(adapter.donghuaSeeds.length >= 3, 'benih harus cukup untuk mengisi panel saat metadata mati');

    // Dipanggil tanpa judul metadata sama sekali: benih tetap dipakai oleh registry.
    const items = await adapter.browseDonghua([...adapter.donghuaSeeds]);
    assert.equal(calls.length, 4, 'empat kueri = jumlah benih (DONGHUA_QUERIES)');
    assert.ok(calls.every((url) => String(url).includes('/?s=')), 'semua kueri lewat pencarian situs');
    // Kueri seed tanpa hasil / error tidak boleh menggagalkan panel selama ada hasil lain.
    assert.deepEqual(items.map((item) => item.slug), ['oploverz~perfect-world']);
});

test('oploverz: filter tak dikenal memakai urutan Terbaru (bukan error)', async () => {
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/series/?order=update`]: fixture('oploverz-series-list.html'),
    });
    const adapter = createOploverz({ network: null, createClient, baseUrl: BASE });
    const page = await adapter.browse({ filter: 'entah', page: 1 });
    assert.equal(page.filter, 'update');
    assert.equal(calls.length, 1);
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
