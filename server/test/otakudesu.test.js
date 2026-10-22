import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cleanTitle, createOtakudesu, parseAnimePage, parseEpisodePage, parseOngoing, parseSchedulePage, parseSearch, slugFromUrl,
} from '../sources/otakudesu.js';
import { fakeClientFactory, fixture, fixture$ } from './helpers.js';

const BASE = 'https://otakudesu.blog';

test('otakudesu: hasil pencarian ASLI (satu-satunya halaman yang lolos dari IP pusat data)', () => {
    const r = parseSearch(fixture$('otakudesu-search.html'), BASE);
    assert.equal(r.length, 3);
    assert.deepEqual(r[0], {
        slug: 'kusuriya-hitorigoto-s3-sub-indo',
        url: 'https://otakudesu.blog/anime/kusuriya-hitorigoto-s3-sub-indo/',
        title: 'Kusuriya no Hitorigoto Season 3',
        image: 'https://otakudesu.blog/wp-content/uploads/2026/10/160277-1.jpg',
        genres: ['Drama', 'Historical', 'Medical', 'Mystery'],
        status: 'ONGOING',
        score: 8.1,
    });
    assert.equal(r[2].status, 'COMPLETED');
});

test('otakudesu: helper slug & judul', () => {
    assert.equal(slugFromUrl('https://otakudesu.blog/anime/abc-sub-indo/', BASE), 'abc-sub-indo');
    assert.equal(slugFromUrl('https://otakudesu.blog/episode/abc-episode-1-sub-indo/', BASE, 'episode'), 'abc-episode-1-sub-indo');
    assert.equal(slugFromUrl('https://otakudesu.blog/genres/drama/', BASE), null);
    assert.equal(slugFromUrl('https://evil.example/anime/abc/', BASE), null);
    assert.equal(cleanTitle('Kusuriya no Hitorigoto Season 3 Subtitle Indonesia'), 'Kusuriya no Hitorigoto Season 3');
    assert.equal(cleanTitle('Contoh Sub Indo'), 'Contoh');
});

test('otakudesu: halaman anime (rekonstruksi struktur) → info + HANYA blok "Episode List"', () => {
    const r = parseAnimePage(fixture$('otakudesu-anime.html'), BASE, 'kusuriya-hitorigoto-s3-sub-indo');
    assert.equal(r.anime.title, 'Kusuriya no Hitorigoto Season 3');
    assert.equal(r.anime.titleAlt, '薬屋のひとりごと 第3期');
    assert.equal(r.anime.status, 'ONGOING');
    assert.equal(r.anime.episodes, 24);
    assert.equal(r.anime.latestEpisode, 3);
    assert.equal(r.anime.score, 8.1);
    assert.equal(r.anime.format, 'TV');
    assert.equal(r.anime.year, 2026);
    assert.equal(r.anime.duration, 24);
    assert.deepEqual(r.anime.genres, ['Drama', 'Mystery']);
    assert.deepEqual(r.anime.studios, ['OLM', 'TOHO animation STUDIO']);
    assert.equal(r.anime.slug, 'otakudesu~kusuriya-hitorigoto-s3-sub-indo');
    assert.deepEqual(r.episodeList.map((e) => e.number), [1, 2, 3], 'blok Batch & Lengkap dilewati');
    assert.equal(r.episodeList[2].released, '17 Oktober,2026');
});

test('otakudesu: halaman episode (rekonstruksi) → server bawaan Sub Indo + download tanpa link donasi', () => {
    const r = parseEpisodePage(fixture$('otakudesu-episode.html'), BASE);
    assert.equal(r.title, 'Kusuriya no Hitorigoto Season 3 Episode 3');
    assert.deepEqual(r.servers, [{ name: 'desustream', url: 'https://desustream.info/dstream/ondesu3/v5/index.php?id=Q09OVE9I', lang: 'id' }]);
    assert.equal(r.downloads.length, 3);
    assert.deepEqual(r.downloads.map((d) => `${d.format} ${d.quality} ${d.size}`), ['MP4 360p 45.1 MB', 'MP4 720p 97.4 MB', 'MKV 1080p 210 MB']);
    assert.ok(r.downloads[1].links.every((l) => !l.url.includes('trakteer')), 'link donasi dibuang');
});

test('otakudesu: ongoing & jadwal (rekonstruksi)', () => {
    const on = parseOngoing(fixture$('otakudesu-ongoing.html'), BASE);
    assert.deepEqual(on.map((x) => `${x.slug}:${x.latestEpisode}`), ['kusuriya-hitorigoto-s3-sub-indo:3', 'contoh-anime-sub-indo:11']);
    const days = parseSchedulePage(fixture$('otakudesu-schedule.html'), BASE);
    assert.deepEqual(Object.keys(days).sort(), ['5', '6'], 'Jumat & Sabtu; "Random" dilewati');
    assert.equal(days[6].length, 1, 'judul ganda dibuang');
});

test('otakudesu adapter: alur lengkap + error jelas saat Cloudflare memblokir', async () => {
    const { createClient } = fakeClientFactory({
        [`${BASE}/ongoing-anime/`]: fixture('otakudesu-ongoing.html'),
        [`${BASE}/?s=kusuriya&post_type=anime`]: fixture('otakudesu-search.html'),
        [`${BASE}/anime/kusuriya-hitorigoto-s3-sub-indo/`]: fixture('otakudesu-anime.html'),
        [`${BASE}/episode/kshs3-episode-3-sub-indo/`]: fixture('otakudesu-episode.html'),
        [`${BASE}/jadwal-rilis/`]: Object.assign(new Error('otakudesu memblokir akses bot (Cloudflare) — tidak dipaksa.'), { kind: 'blocked' }),
    });
    const o = createOtakudesu({ network: {}, createClient, baseUrl: BASE });
    assert.equal((await o.latest()).length, 2);
    const found = await o.search('kusuriya');
    assert.equal(found[0].slug, 'otakudesu~kusuriya-hitorigoto-s3-sub-indo');
    const anime = await o.getAnime({ slug: 'kusuriya-hitorigoto-s3-sub-indo' });
    const ep = await o.getEpisode({ slug: anime.slug }, 3, { anime });
    assert.equal(ep.servers[0].lang, 'id');
    assert.equal(ep.downloads.length, 3);
    await assert.rejects(o.schedule(), (e) => e.kind === 'blocked');
    assert.deepEqual(o.parseRef(['kusuriya-hitorigoto-s3-sub-indo']), { slug: 'kusuriya-hitorigoto-s3-sub-indo' });
    assert.equal(o.parseRef(['a', 'b']), null);
    assert.equal(o.titleHint({ slug: 'kusuriya-hitorigoto-s3-sub-indo' }), 'kusuriya hitorigoto s3');
});
