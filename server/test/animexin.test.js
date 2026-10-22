import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createAnimexin, deriveSeriesSlug, describeServer, parseEpisodePage, parseLatestHome, parseSchedulePage, parseSeriesCards, parseSeriesPage,
    scheduleSlugFromUrl, seriesSlugFromUrl,
} from '../sources/animexin.js';
import { fakeClientFactory, fixture, fixture$ } from './helpers.js';

const BASE = 'https://animexin.dev';

test('animexin: blok Latest Release (Popular Today diabaikan)', () => {
    const items = parseLatestHome(fixture$('animexin-home.html'), BASE);
    assert.equal(items.length, 6);
    assert.deepEqual(items[0], {
        seriesId: '29074',
        title: 'Tales of Demons and Gods Season 10',
        latestEpisode: 34,
        format: 'ONA',
        image: 'https://animexin.dev/wp-content/uploads/2026/07/TODG-S10-New.jpg',
        episodeUrl: 'https://animexin.dev/tales-of-demons-and-gods-season-10-episode-34-466-indonesia-english-sub/',
    });
    assert.ok(items.some((x) => x.title === 'Yi Nian Yong Heng [A Will Eternal]' && x.latestEpisode === 181));
});

test('animexin: kartu seri daftar & pencarian (slug asli dari URL)', () => {
    const list = parseSeriesCards(fixture$('animexin-list.html'), BASE);
    const shrouding = list.find((c) => c.seriesId === '12518');
    assert.equal(shrouding.slug, 'shrounding-the-heavens', 'slug situs memang typo → harus diambil dari URL, bukan dari judul');
    assert.equal(shrouding.statusText, 'Ongoing');
    const search = parseSeriesCards(fixture$('animexin-search.html'), BASE);
    assert.equal(search.length, 5);
    const sl2 = search.find((c) => c.slug === 'soul-land-2-the-peerless-tang-clan');
    assert.equal(sl2.title, 'Soul Land 2: The Peerless Tang Sect');
    assert.equal(sl2.format, 'ONA');
    assert.equal(search.find((c) => c.slug === 'soul-land-movie-battle-of-the-gods-remake').statusText, 'Completed');
});

test('animexin: helper slug seri', () => {
    assert.equal(seriesSlugFromUrl('https://animexin.dev/gu-an/', BASE), 'gu-an');
    assert.equal(seriesSlugFromUrl('https://animexin.dev/anime/?order=update', BASE), 'anime');
    assert.equal(seriesSlugFromUrl('https://evil.example/gu-an/', BASE), null);
    assert.equal(seriesSlugFromUrl('https://animexin.dev/a/b/', BASE), null);
    assert.equal(deriveSeriesSlug('https://animexin.dev/the-guardian-of-daxia-episode-9-indonesia-english-sub/', BASE), 'the-guardian-of-daxia');
    assert.equal(deriveSeriesSlug('https://animexin.dev/gu-an/', BASE), null);
});

test('animexin: halaman seri → anime seragam + daftar episode', () => {
    const r = parseSeriesPage(fixture$('animexin-series.html'), BASE, 'tales-of-demons-and-gods-season-10');
    assert.equal(r.anime.title, 'Tales of Demons and Gods Season 10');
    assert.equal(r.anime.titleAlt, '妖神记 10');
    assert.equal(r.anime.status, 'ONGOING', 'situs menulis "Upcoming" padahal sudah 34 episode');
    assert.equal(r.anime.latestEpisode, 34);
    assert.equal(r.anime.episodes, null, 'ongoing tanpa total resmi');
    assert.equal(r.anime.format, 'ONA');
    assert.equal(r.anime.country, 'CN');
    assert.equal(r.anime.year, 2026);
    assert.equal(r.anime.duration, 8);
    assert.deepEqual(r.anime.studios, ['Ruo Hong Culture']);
    assert.deepEqual(r.anime.genres, ['Action', 'Adventure', 'Fantasy', 'Supernatural']);
    assert.equal(r.anime.description, '', 'kalimat SEO "Subtitle Indonesia, English, ..." bukan sinopsis');
    assert.equal(r.anime.slug, 'animexin~tales-of-demons-and-gods-season-10');
    assert.equal(r.anime.source, 'animexin');
    assert.deepEqual(r.episodeList.map((e) => e.number), [1, 2, 32, 33, 34]);
    assert.equal(r.episodeList[4].url, 'https://animexin.dev/tales-of-demons-and-gods-season-10-episode-34-466-indonesia-english-sub/');
    assert.equal(r.episodeList[4].released, 'October 21, 2026');
});

test('animexin: halaman episode BUKAN halaman seri', () => {
    assert.equal(parseSeriesPage(fixture$('animexin-episode.html'), BASE, 'x'), null);
});

test('animexin: halaman episode → 16 server (base64 → iframe), download tanpa grup VIP/donasi', () => {
    const r = parseEpisodePage(fixture$('animexin-episode.html'), BASE);
    assert.equal(r.title, 'Tales of Demons and Gods Season 10 Episode 34 [466] Indonesia, English Sub');
    assert.equal(r.seriesUrl, 'https://animexin.dev/tales-of-demons-and-gods-season-10/');
    assert.equal(r.servers.length, 16);
    assert.ok(r.servers.every((s) => s.url.startsWith('https://')), 'protocol-relative //ok.ru → https');
    assert.ok(r.servers.some((s) => s.url === 'https://ok.ru/videoembed/16132622453300?nochat=1' && s.name === 'OK.ru (Sub Indo)' && s.lang === 'id' && s.subtitleType === 'hard'));
    assert.equal(r.servers.filter((s) => s.lang === 'id').length, 6);
    assert.equal(r.servers.filter((s) => s.subtitleType === 'hard').length, 10, 'label hardsub per server dipertahankan');
    assert.ok(!r.servers.some((s) => /follow-up/.test(s.name)), 'select komentar diabaikan');
    assert.equal(r.downloads.length, 2);
    assert.deepEqual(r.downloads.map((d) => [d.quality, d.subtitle, d.format, d.links.length]), [['1080p', 'Sub Indo', 'MP4', 3], ['1080p', 'Sub English', 'MP4', 3]]);
    assert.ok(!JSON.stringify(r.downloads).includes('ko-fi'), 'grup Membership VIP (ko-fi) dibuang');
});

test('animexin: parser upstream mirror menerima direct URL, data-em, iframe/source, dan meta embedUrl', () => {
    const episode = parseEpisodePage(fixture$('animexin-mirror-variants.html'), BASE);
    assert.deepEqual(episode.servers.map((server) => [server.name, server.lang, server.subtitleType, server.url]), [
        ['Direct (Sub Indo)', 'id', 'hard', 'https://direct.example.test/embed/one'],
        ['Mirror (Sub English)', 'en', 'soft', 'https://meta.example.test/embed/mirror'],
        ['Iframe Mirror', null, undefined, 'https://iframe.example.test/embed/mirror'],
        ['Source Mirror', null, undefined, 'https://source.example.test/video.mp4'],
    ]);
});

test('animexin: nama server rapi dan jenis sub hanya dicatat jika eksplisit', () => {
    assert.deepEqual(describeServer('Hardsub Indonesia Dailymotion AX', 'https://geo.dailymotion.com/player/x.html?video=1'), { name: 'Dailymotion (Sub Indo)', lang: 'id', subtitleType: 'hard' });
    assert.deepEqual(describeServer('Soft-sub Indonesia Dailymotion AX', 'https://geo.dailymotion.com/player/x.html?video=1'), { name: 'Dailymotion (Sub Indo)', lang: 'id', subtitleType: 'soft' });
    assert.deepEqual(describeServer('Dtube Indo AX', 'https://play.d.tube?v=1'), { name: 'DTube (Sub Indo)', lang: 'id' });
    assert.deepEqual(describeServer('All Sub Streamwish AX', 'https://animexinfansub.seekplayer.vip/#1'), { name: 'Streamwish (Multi Sub)', lang: 'multi' });
    assert.deepEqual(describeServer('Hardsub English Ok.ru AX', 'https://ok.ru/videoembed/1'), { name: 'OK.ru (Sub English)', lang: 'en', subtitleType: 'hard' });
    assert.deepEqual(describeServer('', 'https://rumble.com/embed/v1/'), { name: 'Rumble', lang: null });
});

function adapter(routes) {
    const { createClient, calls } = fakeClientFactory(routes);
    return { a: createAnimexin({ network: {}, createClient, baseUrl: BASE }), calls };
}

test('animexin adapter: latest = beranda + daftar (join rel), slug typo benar, slug tebakan untuk yang tidak ada di daftar', async () => {
    const { a, calls } = adapter({
        [`${BASE}/`]: fixture('animexin-home.html'),
        [`${BASE}/anime/?status=&type=&order=update`]: fixture('animexin-list.html'),
    });
    const items = await a.latest();
    assert.equal(calls.length, 2);
    assert.equal(items.length, 6);
    const bySlug = Object.fromEntries(items.map((x) => [x.slug, x]));
    assert.ok(bySlug['animexin~shrounding-the-heavens'], 'slug dari halaman daftar (typo situs)');
    assert.ok(bySlug['animexin~againts-the-sky-supreme']);
    assert.ok(bySlug['animexin~the-guardian-of-daxia'], 'tidak ada di daftar → ditebak dari URL episode');
    const todg = bySlug['animexin~tales-of-demons-and-gods-season-10'];
    assert.equal(todg.latestEpisode, 34);
    assert.equal(todg.status, 'ONGOING');
    assert.equal(todg.country, 'CN');
    assert.equal(todg.source, 'animexin');
    assert.equal(todg.url, 'https://animexin.dev/tales-of-demons-and-gods-season-10/');
});

test('animexin adapter: latest tetap jalan bila halaman daftar gagal; gagal bila beranda gagal', async () => {
    const ok = adapter({ [`${BASE}/`]: fixture('animexin-home.html') });
    const items = await ok.a.latest();
    assert.ok(items.some((x) => x.slug === 'animexin~shrouding-the-heavens'), 'tanpa daftar: slug tebakan');
    const bad = adapter({});
    await assert.rejects(bad.a.latest(), (e) => e.kind === 'not_found');
    const changed = adapter({ [`${BASE}/`]: '<html><body>desain baru</body></html>' });
    await assert.rejects(changed.a.latest(), (e) => e.kind === 'parse');
});

test('animexin adapter: search, getAnime, getEpisode', async () => {
    const epUrl = 'https://animexin.dev/tales-of-demons-and-gods-season-10-episode-34-466-indonesia-english-sub/';
    const { a, calls } = adapter({
        [`${BASE}/?s=soul+land`]: fixture('animexin-search.html'),
        [`${BASE}/tales-of-demons-and-gods-season-10/`]: fixture('animexin-series.html'),
        [epUrl]: fixture('animexin-episode.html'),
    });
    const found = await a.search('soul land');
    assert.equal(found.length, 5);
    assert.equal(found[2].slug, 'animexin~soul-land-2-the-peerless-tang-clan');

    const ref = a.parseRef(['tales-of-demons-and-gods-season-10']);
    const anime = await a.getAnime(ref);
    assert.equal(anime.episodeList.length, 5);
    const ep = await a.getEpisode(ref, 34, { anime });
    assert.equal(ep.episode, 34);
    assert.equal(ep.servers[0].lang, 'id', 'Sub Indo didahulukan');
    assert.equal(ep.servers[0].subtitleType, 'hard', 'label Hardsub bertahan hingga payload endpoint');
    assert.equal(ep.servers.length, 16);
    assert.equal(ep.downloads[0].subtitle, 'Sub Indo');
    assert.equal(ep.url, epUrl);
    await assert.rejects(a.getEpisode(ref, 20, { anime }), (e) => e.kind === 'not_found' && /Episode 20/.test(e.message));
    assert.equal(calls.filter((u) => u === epUrl).length, 1);
});

test('animexin adapter: slug halaman episode → ikut "All Episodes" ke halaman seri', async () => {
    const epSlug = 'tales-of-demons-and-gods-season-10-episode-34-466-indonesia-english-sub';
    const { a } = adapter({
        [`${BASE}/${epSlug}/`]: fixture('animexin-episode.html'),
        [`${BASE}/tales-of-demons-and-gods-season-10/`]: fixture('animexin-series.html'),
    });
    const anime = await a.getAnime(a.parseRef([epSlug]));
    assert.equal(anime.title, 'Tales of Demons and Gods Season 10');
    assert.equal(anime.slug, 'animexin~tales-of-demons-and-gods-season-10');
});

test('animexin adapter: parseRef & titleHint', () => {
    const { a } = adapter({});
    assert.deepEqual(a.parseRef(['Gu-An']), { slug: 'gu-an' });
    assert.equal(a.parseRef(['a', 'b']), null);
    assert.equal(a.parseRef(['../x']), null);
    assert.equal(a.titleHint({ slug: 'swallowed-star-season-5' }), 'swallowed star season 5');
    assert.equal(a.policy.tos.verdict, 'allowed');
    assert.equal(a.policy.imagePolicy, 'blocked');
});

test('animexin: halaman Schedule asli → donghua per hari (tanpa jam), slug dari "/<slug>/" maupun "/anime/<slug>/"', () => {
    const days = parseSchedulePage(fixture$('animexin-schedule.html'), BASE);
    assert.deepEqual(Object.keys(days).sort(), ['0', '1', '2', '3', '4', '5', '6']);
    assert.deepEqual(days[1].slice(0, 3), [
        { title: 'Renegade Immortal', slug: 'renegade-immortal', url: 'https://animexin.dev/renegade-immortal/' },
        { title: 'Supreme God Emperor', slug: 'supreme-god-emperor', url: 'https://animexin.dev/anime/supreme-god-emperor/' },
        { title: 'Against Sky Supreme', slug: 'againts-the-sky-supreme', url: 'https://animexin.dev/anime/againts-the-sky-supreme/' },
    ]);
    assert.ok(Object.values(days).reduce((n, d) => n + d.length, 0) >= 30);
    assert.equal(scheduleSlugFromUrl('https://animexin.dev/anime/gu-an/', BASE), 'gu-an');
    assert.equal(scheduleSlugFromUrl('https://animexin.dev/a/b/c/', BASE), null);
    assert.equal(scheduleSlugFromUrl('https://evil.example/gu-an/', BASE), null);
});

test('animexin: adapter.schedule() → item seragam (time null, country CN, slug animexin~)', async () => {
    const { createClient } = fakeClientFactory({ [`${BASE}/schedule/`]: fixture('animexin-schedule.html') });
    const a = createAnimexin({ network: {}, createClient, baseUrl: BASE });
    const days = await a.schedule();
    const first = days[1][0];
    assert.deepEqual(first, { title: 'Renegade Immortal', time: null, slug: 'animexin~renegade-immortal', url: 'https://animexin.dev/renegade-immortal/', image: null, country: 'CN', source: 'animexin' });
});
