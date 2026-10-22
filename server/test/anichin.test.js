import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { createAnichin, parseSchedulePage } from '../sources/anichin.js';
import { parseEpisodePage, parseSeriesCards, parseSeriesPage } from '../sources/animexin.js';
import { fakeClientFactory, fixture, fixture$ } from './helpers.js';

const BASE = 'https://anichin.moe';

test('anichin: tema AnimeStream — parser AnimeXin membaca kartu daftar & pencarian asli', () => {
    const list = parseSeriesCards(fixture$('anichin-list.html'), BASE);
    assert.equal(list.length, 6);
    assert.equal(list[0].slug, 'my-senior-brother-is-too-steady');
    assert.equal(list[0].statusText, 'Ongoing');
    assert.match(list[0].image, /^https:\/\/anichin\.moe\/wp-content\/uploads\//);
    const search = parseSeriesCards(fixture$('anichin-search.html'), BASE);
    assert.deepEqual(search.map((c) => c.slug), ['renegade-immortal-movie-slaying-the-blood-progenitor', 'renegade-immortal-movie-battle-of-the-gods', 'renegade-immortal']);
});

test('anichin: halaman seri & episode asli (server Sub Indo, link download)', () => {
    const s = parseSeriesPage(fixture$('anichin-series.html'), BASE, 'renegade-immortal');
    assert.equal(s.anime.title, 'Renegade Immortal');
    assert.equal(s.anime.titleAlt, '仙逆');
    assert.equal(s.anime.country, 'CN');
    assert.equal(s.anime.latestEpisode, 163);
    assert.equal(s.episodeList.at(-1).url, 'https://anichin.moe/renegade-immortal-episode-163-subtitle-indonesia/');
    const ep = parseEpisodePage(fixture$('anichin-episode.html'), BASE);
    assert.equal(ep.servers.length, 11);
    assert.ok(ep.servers.some((x) => x.url.startsWith('https://ok.ru/videoembed/')));
    assert.ok(ep.downloads.length >= 1 && ep.downloads.every((d) => d.subtitle === 'Sub Indo'));
});

test('anichin: jadwal asli → per hari + jam WIB dikalibrasi dari item "Jam HH:MM"', () => {
    const days = parseSchedulePage(fixture$('anichin-schedule.html'), BASE);
    assert.deepEqual(Object.keys(days).sort(), ['4', '5'], 'Kamis & Jumat');
    const kamis = days[4];
    assert.equal(kamis[0].title, 'Make Money To Be King');
    assert.equal(kamis[0].time, '10:04', 'teks "Jam 10:04" dipakai apa adanya');
    assert.equal(kamis[0].episode, 70);
    assert.equal(kamis[0].slug, 'make-money-to-be-king');
    // Jumat: hanya hitung mundur relatif waktu render → jam dihitung dari kalibrasi (render ±12:59 WIB)
    const greatRuler = days[5].find((x) => x.slug === 'the-great-ruler-3d');
    assert.match(greatRuler.time, /^0[01]:\d\d$/, `jam perkiraan masuk akal (${greatRuler.time})`);
    assert.ok(Object.values(days).flat().every((x) => x.time === null || /^\d\d:\d\d$/.test(x.time)));
});

test('anichin: jadwal tanpa item ber-"Jam" → jam null (tidak ditebak)', () => {
    const html = fixture('anichin-schedule.html').replace(/Jam \d{1,2}:\d{2}/g, 'sudah rilis');
    const days = parseSchedulePage(load(html), BASE);
    const all = Object.values(days).flat();
    assert.ok(all.length > 0);
    assert.ok(all.every((x) => x.time === null));
});

test('anichin adapter: latest (beranda gagal → daftar saja), search, getAnime (fallback /anime/<slug>/), getEpisode lang id', async () => {
    const { createClient, calls } = fakeClientFactory({
        [`${BASE}/`]: Object.assign(new Error('challenge'), { kind: 'blocked' }),
        [`${BASE}/anime/?status=&type=&order=update`]: fixture('anichin-list.html'),
        [`${BASE}/?s=renegade`]: fixture('anichin-search.html'),
        [`${BASE}/anime/renegade-immortal/`]: fixture('anichin-series.html'),
        [`${BASE}/renegade-immortal-episode-163-subtitle-indonesia/`]: fixture('anichin-episode.html'),
    });
    const a = createAnichin({ network: {}, createClient, baseUrl: BASE });
    assert.equal(a.id, 'anichin');
    const latest = await a.latest();
    assert.equal(latest.length, 6);
    assert.ok(latest.every((x) => x.source === 'anichin' && x.country === 'CN' && x.slug.startsWith('anichin~')));

    const found = await a.search('renegade');
    assert.ok(found.some((x) => x.slug === 'anichin~renegade-immortal'));

    const anime = await a.getAnime({ slug: 'renegade-immortal' });
    assert.ok(calls.includes(`${BASE}/renegade-immortal/`) && calls.includes(`${BASE}/anime/renegade-immortal/`), '404 di /<slug>/ → coba /anime/<slug>/');
    assert.equal(anime.slug, 'anichin~renegade-immortal');
    assert.equal(anime.source, 'anichin');
    assert.equal(anime.url, `${BASE}/renegade-immortal/`);

    const ep = await a.getEpisode({ slug: 'renegade-immortal' }, 163, { anime });
    assert.equal(ep.servers.length, 11);
    assert.ok(ep.servers.every((s) => s.lang === 'id'), 'Anichin = Sub Indo');
    await assert.rejects(a.getEpisode({ slug: 'renegade-immortal' }, 999, { anime }), (e) => e.kind === 'not_found');
});

test('anichin adapter: parseRef (slug & anime~slug), schedule() seragam', async () => {
    const { createClient } = fakeClientFactory({ [`${BASE}/schedule/`]: fixture('anichin-schedule.html') });
    const a = createAnichin({ network: {}, createClient, baseUrl: BASE });
    assert.deepEqual(a.parseRef(['renegade-immortal']), { slug: 'renegade-immortal' });
    assert.deepEqual(a.parseRef(['anime', 'martial-master']), { slug: 'martial-master', prefixed: true });
    assert.equal(a.parseRef(['a', 'b']), null);
    assert.equal(a.parseRef(['../etc']), null);
    const days = await a.schedule();
    const item = days[4][0];
    assert.deepEqual(Object.keys(item).sort(), ['country', 'image', 'slug', 'source', 'time', 'title', 'url']);
    assert.equal(item.slug, 'anichin~make-money-to-be-king');
    assert.equal(item.country, 'CN');
});

test('anichin adapter: konfigurasi host dibatasi dan challenge tidak diberi retry', () => {
    const { createClient } = fakeClientFactory({});
    let opts = null;
    createAnichin({ network: {}, createClient: (n, o) => { opts = o; return createClient(n, o); }, baseUrl: BASE });
    assert.equal(opts.challengeRetries, undefined, 'challenge tidak diulang');
    assert.equal(opts.blockedMs, 5 * 60 * 1000);
    assert.deepEqual(opts.allowedHosts, ['anichin.moe', 'www.anichin.moe']);
});
