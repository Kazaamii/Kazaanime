import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, parseRobots, rulesFor } from '../lib/robots.js';
import {
    animeSlugFromUrl, createSamehadaku, episodeFromUrl, parseAnimePage, parseEpisodePage, parseLatestList,
    parseSchedulePage, parseSearchCards, POLICY,
} from '../sources/samehadaku.js';
import { fakeClientFactory, fixture, fixture$ } from './helpers.js';

const BASE = 'https://v2.samehadaku.how';
const KIKANSHA = 'kikansha-no-mahou-wa-tokubetsu-desu-season-2';

test('samehadaku: robots.txt asli mengizinkan semua halaman yang dipakai (hanya /wp-admin/ dilarang)', () => {
    const { rules } = rulesFor(parseRobots(fixture('samehadaku-robots.txt')), 'KazanimeBot');
    for (const path of ['/anime-terbaru/', '/?s=kusuriya', `/anime/${KIKANSHA}/`, `/${KIKANSHA}-episode-3/`, '/jadwal-rilis/']) {
        assert.equal(isAllowed(rules, path), true, path);
    }
    assert.equal(isAllowed(rules, '/wp-admin/options.php'), false);
    assert.equal(POLICY.tos.verdict, 'unknown', 'tanpa halaman ToS → robots.txt wajib terbaca & mengizinkan');
});

test('samehadaku: helper URL anime & episode', () => {
    assert.equal(animeSlugFromUrl(`${BASE}/anime/${KIKANSHA}/`, BASE), KIKANSHA);
    assert.equal(animeSlugFromUrl(`${BASE}/genre/action/`, BASE), null);
    assert.deepEqual(episodeFromUrl(`${BASE}/kusuriya-no-hitorigoto-season-2-episode-24-end/`, BASE), { slug: 'kusuriya-no-hitorigoto-season-2', number: 24 });
    assert.deepEqual(episodeFromUrl(`${BASE}/psyren-episode-3/`, BASE), { slug: 'psyren', number: 3 });
    assert.equal(episodeFromUrl(`${BASE}/anime/psyren/`, BASE), null);
});

test('samehadaku: pencarian (kartu article.animepost → hanya halaman /anime/)', () => {
    const cards = parseSearchCards(fixture$('samehadaku-search.html'), BASE);
    assert.deepEqual(cards[0], {
        slug: 'kusuriya-no-hitorigoto-season-3',
        url: `${BASE}/anime/kusuriya-no-hitorigoto-season-3/`,
        title: 'Kusuriya no Hitorigoto Season 3',
        image: `${BASE}/wp-content/uploads/2026/10/160277-212x300.jpg`,
        format: 'TV',
        status: 'ONGOING',
        score: 8.38,
    });
    assert.ok(cards.every((c) => !/episode/.test(c.slug)), 'posting episode bukan kartu anime');
});

test('samehadaku: anime terbaru (judul, slug anime, episode terbaru)', () => {
    const items = parseLatestList(fixture$('samehadaku-latest.html'), BASE);
    assert.ok(items.length >= 10);
    assert.deepEqual(items[0], {
        slug: KIKANSHA,
        url: `${BASE}/anime/${KIKANSHA}/`,
        title: 'Kikansha no Mahou wa Tokubetsu desu Season 2',
        image: `${BASE}/wp-content/uploads/2026/10/Kikansha-no-Mahou-wa-Tokubetsu-desu-Season-2-Episode-3-300x167.jpg`,
        latestEpisode: 3,
        episodeUrl: `${BASE}/${KIKANSHA}-episode-3/`,
    });
    const doumo = items.find((x) => x.slug === 'doumo-suki-na-hito-ni-horegusuri-wo-irai-sareta-majo-desu');
    assert.ok(doumo, 'slug anime diambil dari tautan judul, bukan dari URL episode (yang lebih pendek)');
    assert.equal(doumo.episodeUrl, `${BASE}/doumo-suki-na-hito-ni-horegusuri-episode-3/`);
});

test('samehadaku: halaman detail → format seragam + daftar episode (URL episode asli)', () => {
    const { anime, episodeList, japanese } = parseAnimePage(fixture$('samehadaku-anime.html'), BASE, { slug: KIKANSHA });
    assert.equal(anime.title, 'Kikansha no Mahou wa Tokubetsu desu Season 2', 'akhiran "Sub Indo" dibuang');
    assert.equal(anime.titleAlt, "A Returner's Magic Should Be Special Season 2");
    assert.equal(anime.image, `${BASE}/wp-content/uploads/2026/10/Kikansha-no-Mahou-wa-Tokubetsu-desu-Season-2.jpg`);
    assert.equal(anime.description, 'Musim Ke-2 dari anime Kikansha no Mahou wa Tokubetsu desu', 'baris "Tonton Juga" & judul alternatif dibuang');
    assert.deepEqual(anime.genres, ['Action', 'Fantasy', 'School', 'Time Travel'], 'genre kartu lain di halaman tidak ikut');
    assert.equal(anime.score, 7.12);
    assert.equal(anime.status, 'ONGOING');
    assert.equal(anime.format, 'TV');
    assert.equal(anime.season, 'FALL');
    assert.equal(anime.year, 2026);
    assert.equal(anime.duration, 23);
    assert.deepEqual(anime.studios, ['Arvo Animation']);
    assert.equal(anime.country, 'JP');
    assert.equal(anime.latestEpisode, 3);
    assert.equal(anime.slug, `samehadaku~${KIKANSHA}`);
    assert.equal(japanese, '帰還者の魔法は特別です 2期');
    assert.deepEqual(episodeList.map((e) => [e.number, e.released]), [[1, '8 October 2026'], [2, '15 October 2026'], [3, '22 October 2026']]);
    assert.equal(episodeList[2].url, `${BASE}/${KIKANSHA}-episode-3/`);
});

test('samehadaku: halaman episode → server embed publik (VIP berbayar dilewati) + link download per format/kualitas', () => {
    const ep = parseEpisodePage(fixture$('samehadaku-episode.html'), BASE);
    assert.equal(ep.title, 'Kikansha no Mahou wa Tokubetsu desu Season 2 Episode 3');
    assert.equal(ep.animeUrl, `${BASE}/anime/${KIKANSHA}/`);
    assert.deepEqual(ep.servers.map((s) => s.name), ['Blogspot', 'Mega 480p', 'Mega 720p', 'Mega 1080p']);
    assert.ok(ep.servers[0].url.startsWith('https://www.blogger.com/video.g?token='));
    assert.ok(ep.servers.slice(1).every((s) => s.url.startsWith('https://mega.nz/embed/')));
    assert.ok(ep.servers.every((s) => s.lang === 'id'), 'Samehadaku = subtitle Indonesia');
    assert.ok(!ep.servers.some((s) => /vip/i.test(s.name)));
    assert.equal(ep.downloads.length, 8);
    assert.deepEqual(ep.downloads[0], {
        quality: '360p', size: '', format: 'MKV', subtitle: 'Sub Indo',
        links: [
            { provider: 'Gofile', url: 'https://gofile.io/d/F4T8ejIk' },
            { provider: 'Acefile', url: 'https://acefile.co/f/112388396/knmt-s2-03-360p-samehadaku-care-mkv' },
            { provider: 'Pixeldrain', url: 'https://pixeldrain.com/u/5BTeiVyW' },
            { provider: 'Mediafire (RAR)', url: 'https://www.mediafire.com/file/ml2ivvnwov3401l/KnMT-S2-03-360p-MKV-SAMEHADAKU.CARE.rar/file' },
        ],
    });
    assert.ok(ep.downloads.some((g) => g.format === 'MP4'));
});

test('samehadaku: jadwal rilis per hari (0 = Minggu) + jam WIB', () => {
    const days = parseSchedulePage(fixture('samehadaku-schedule.html'), BASE);
    assert.deepEqual(Object.keys(days).sort(), ['0', '1', '2', '3', '4', '5', '6']);
    const total = Object.values(days).reduce((n, d) => n + d.length, 0);
    assert.ok(total >= 35, `total ${total}`);
    const kusuriya = days[0].find((x) => x.slug === 'kusuriya-no-hitorigoto-season-3');
    assert.deepEqual(kusuriya, {
        title: 'Kusuriya no Hitorigoto Season 3',
        slug: 'kusuriya-no-hitorigoto-season-3',
        url: `${BASE}/anime/kusuriya-no-hitorigoto-season-3/`,
        image: `${BASE}/wp-content/uploads/2026/10/160277-212x300.jpg`,
        time: '01:00',
    });
    assert.ok(days[1].some((x) => x.title === 'One Piece'));
    assert.ok(Object.values(days).flat().every((x) => x.time === null || /^\d{2}:\d{2}$/.test(x.time)), '"23.59" pun dinormalkan jadi 23:59');
});

test('samehadaku: adapter — latest/search/detail/episode/schedule lewat client (URL episode dari daftar, bukan tebakan)', async () => {
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/anime-terbaru/`]: fixture('samehadaku-latest.html'),
        [`${BASE}/?s=kusuriya`]: fixture('samehadaku-search.html'),
        [`${BASE}/anime/${KIKANSHA}/`]: fixture('samehadaku-anime.html'),
        [`${BASE}/${KIKANSHA}-episode-3/`]: fixture('samehadaku-episode.html'),
    });
    let adapterClientOpts;
    const clientFactory = (net, opts) => {
        adapterClientOpts = opts;
        const c = createClient(net, opts);
        // schedule() memakai request() (HTML mentah) — tiru dari fixture
        c.request = async (url) => {
            calls.push(url);
            if (url !== `${BASE}/jadwal-rilis/`) throw new Error(`tak terduga ${url}`);
            return { status: 200, url, text: fixture('samehadaku-schedule.html'), headers: new Headers() };
        };
        return c;
    };
    const a = createSamehadaku({ network: {}, createClient: clientFactory, baseUrl: `${BASE}/` });
    assert.equal(adapterClientOpts.challengeRetries, 0, 'challenge konten tidak diulang');
    assert.equal(adapterClientOpts.blockedMs, 30 * 60 * 1000, 'Samehadaku diistirahatkan 30 menit setelah challenge');
    assert.equal(a.id, 'samehadaku');
    assert.deepEqual(a.parseRef([KIKANSHA]), { slug: KIKANSHA });
    assert.equal(a.parseRef(['../etc']), null);

    const latest = await a.latest();
    assert.equal(latest[0].slug, `samehadaku~${KIKANSHA}`);
    assert.equal(latest[0].latestEpisode, 3);
    assert.equal(latest[0].country, 'JP');

    const found = await a.search('kusuriya');
    assert.equal(found[0].slug, 'samehadaku~kusuriya-no-hitorigoto-season-3');

    const anime = await a.getAnime({ slug: KIKANSHA });
    assert.equal(anime.episodeList.length, 3);
    const ep = await a.getEpisode({ slug: KIKANSHA }, 3, { anime });
    assert.equal(ep.episode, 3);
    assert.equal(ep.servers.length, 4);
    assert.equal(ep.released, '22 October 2026');
    await assert.rejects(() => a.getEpisode({ slug: KIKANSHA }, 9, { anime }), (err) => err.kind === 'not_found');

    const schedule = await a.schedule();
    assert.equal(schedule[0].find((x) => x.title === 'Kusuriya no Hitorigoto Season 3').slug, 'samehadaku~kusuriya-no-hitorigoto-season-3');
    assert.ok(Object.values(schedule).flat().every((x) => x.source === 'samehadaku' && x.country === 'JP'));
    assert.ok(!calls.some((u) => /episode-9/.test(u)), 'episode yang tidak ada di daftar tidak ditebak/diminta');
});
