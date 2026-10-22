import test from 'node:test';
import assert from 'node:assert/strict';
import {
    absoluteUrl, bracketParts, decodeBase64, fixStatus, isDonationUrl, normalizeQuality, parseCountry, parseDurationMinutes,
    parseEpisodeNumber, parseFormat, parseScore10, parseStatus, parseTotalEpisodes, parseYear, slugify, stripSeason, titleKey,
} from '../lib/text.js';
import { decodeSlug, encodeSlug } from '../lib/slug.js';
import { makeAnime, makeEpisode } from '../lib/anime.js';

test('parseEpisodeNumber: label animexin/kuramanime, pecahan ditolak', () => {
    assert.equal(parseEpisodeNumber('Episode 34 [466]'), 34);
    assert.equal(parseEpisodeNumber('34 [466]'), 34);
    assert.equal(parseEpisodeNumber('Ep 5 / 12'), 5);
    assert.equal(parseEpisodeNumber('Eps. 7'), 7);
    assert.equal(parseEpisodeNumber('10.5'), null);
    assert.equal(parseEpisodeNumber('Episode 10.5'), null);
    assert.equal(parseEpisodeNumber('Special'), null);
    assert.equal(parseEpisodeNumber('0'), null);
    assert.equal(parseTotalEpisodes('Ep 5 / 12'), 12);
    assert.equal(parseTotalEpisodes('Ep 5 / ?'), null);
});

test('parseStatus & fixStatus', () => {
    assert.equal(parseStatus('Ongoing'), 'ONGOING');
    assert.equal(parseStatus('Sedang Tayang'), 'ONGOING');
    assert.equal(parseStatus('Completed'), 'COMPLETED');
    assert.equal(parseStatus('Selesai Tayang'), 'COMPLETED');
    assert.equal(parseStatus('Upcoming'), 'UPCOMING');
    assert.equal(parseStatus('Belum Tayang'), 'UPCOMING');
    assert.equal(parseStatus(''), 'UNKNOWN');
    assert.equal(parseStatus('Football'), 'UNKNOWN');
    assert.equal(fixStatus('UPCOMING', 34), 'ONGOING');
    assert.equal(fixStatus('UPCOMING', null), 'UPCOMING');
});

test('format, negara, tahun, durasi, skor, kualitas', () => {
    assert.equal(parseFormat('ONA'), 'ONA');
    assert.equal(parseFormat('Movie'), 'MOVIE');
    assert.equal(parseFormat('TV Series'), 'TV');
    assert.equal(parseFormat('Special'), 'SPECIAL');
    assert.equal(parseFormat('???'), '');
    assert.equal(parseCountry('China'), 'CN');
    assert.equal(parseCountry('Jepang'), 'JP');
    assert.equal(parseCountry('Korea Selatan'), 'KR');
    assert.equal(parseCountry('Mars'), null);
    assert.equal(parseYear('Jul 18, 2026'), 2026);
    assert.equal(parseYear('29 Sep 2023 s/d 22 Mar 2024'), 2023);
    assert.equal(parseDurationMinutes('8 Minute'), 8);
    assert.equal(parseDurationMinutes('24 min. per ep'), 24);
    assert.equal(parseDurationMinutes('1 hr. 30 min.'), 90);
    assert.equal(parseDurationMinutes('23 menit'), 23);
    assert.equal(parseScore10('Rating 8.50'), 8.5);
    assert.equal(parseScore10('85'), 8.5);
    assert.equal(parseScore10('Rating 0.0'), null);
    assert.equal(normalizeQuality('1080'), '1080p');
    assert.equal(normalizeQuality('MKV 480p Softsub'), '480p');
    assert.equal(normalizeQuality('4K'), '4K');
});

test('URL: absolut, protocol-relative, skema berbahaya ditolak', () => {
    assert.equal(absoluteUrl('//ok.ru/videoembed/1'), 'https://ok.ru/videoembed/1');
    assert.equal(absoluteUrl('/anime/1/x', 'https://v20.kuramanime.ing'), 'https://v20.kuramanime.ing/anime/1/x');
    assert.equal(absoluteUrl('javascript:alert(1)'), '');
    assert.equal(absoluteUrl('data:text/html,hi'), '');
    assert.equal(absoluteUrl('ftp://x.y/z'), '');
    assert.equal(absoluteUrl(''), '');
    assert.equal(isDonationUrl('https://ko-fi.com/haibodong'), true);
    assert.equal(isDonationUrl('https://www.mediafire.com/file/x'), false);
});

test('judul: slugify, titleKey, kurung & season', () => {
    assert.equal(slugify('Raised by Demons: Panda Li'), 'raised-by-demons-panda-li');
    assert.equal(titleKey('Frieren: Beyond Journey’s End'), 'frierenbeyondjourneysend');
    assert.deepEqual(bracketParts('Yi Nian Yong Heng [A Will Eternal]'), { main: 'Yi Nian Yong Heng', alt: 'A Will Eternal' });
    assert.deepEqual(bracketParts('Renegade Immortal'), { main: 'Renegade Immortal', alt: '' });
    assert.equal(stripSeason('Swallowed Star Season 5'), 'Swallowed Star');
    assert.equal(stripSeason('Tales of Demons and Gods Season 10'), 'Tales of Demons and Gods');
    assert.equal(stripSeason('Yao Shen Ji 2nd Season'), 'Yao Shen Ji');
    assert.equal(stripSeason('Bones 3'), 'Bones');
    assert.equal(stripSeason('Renegade Immortal'), 'Renegade Immortal');
});

test('decodeBase64: iframe mirror animexin', () => {
    const v = Buffer.from('<iframe src="//ok.ru/videoembed/123"></iframe>').toString('base64');
    assert.match(decodeBase64(v), /ok\.ru\/videoembed\/123/);
    assert.equal(decodeBase64('bukan base64!!'), '');
    assert.equal(decodeBase64(''), '');
});

test('slug: encode/decode, karakter aman untuk routes.js frontend', () => {
    assert.equal(encodeSlug('animexin', 'soul-land-2'), 'animexin~soul-land-2');
    assert.equal(encodeSlug('kuramanime', '2468', 'sousou-no-frieren'), 'kuramanime~2468~sousou-no-frieren');
    assert.equal(encodeSlug('animexin', 'ada spasi'), null);
    assert.equal(encodeSlug('animexin', '../etc'), null);
    assert.equal(encodeSlug('animexin', 'x'.repeat(200)), null);
    assert.deepEqual(decodeSlug('kuramanime~2468~sousou-no-frieren'), { source: 'kuramanime', parts: ['2468', 'sousou-no-frieren'] });
    assert.equal(decodeSlug('animexin'), null);
    assert.equal(decodeSlug('animexin~'), null);
    assert.equal(decodeSlug('animexin~a/b'), null);
    assert.equal(decodeSlug('anime xin~a'), null);
    assert.equal(decodeSlug(42), null);
    assert.match(encodeSlug('animexin', 'tales-of-demons-and-gods-season-10'), /^[a-zA-Z0-9._~-]{1,160}$/);
});

test('makeAnime: bentuk seragam + sanitasi', () => {
    const a = makeAnime({ title: '  Judul  ', titleAlt: 'Judul', image: 'javascript:x', score: 12, status: 'aneh', genres: ['A', 'A', ''], ids: { anilist: '5', mal: -1 } });
    assert.equal(a.title, 'Judul');
    assert.equal(a.titleAlt, '');
    assert.equal(a.image, null);
    assert.equal(a.score, null);
    assert.equal(a.status, 'UNKNOWN');
    assert.deepEqual(a.genres, ['A']);
    assert.deepEqual(a.ids, { anilist: 5, mal: null, kitsu: null });
    assert.ok(!('id' in a), 'id dihitung frontend, tidak dikirim backend');
    for (const k of ['title', 'titleAlt', 'image', 'banner', 'description', 'episodes', 'latestEpisode', 'genres', 'score', 'status', 'format', 'year', 'popularity', 'country', 'ids', 'slug', 'source', 'studios', 'duration', 'season', 'nextAiring']) {
        assert.ok(k in a, `field ${k} ada`);
    }
});

test('makeEpisode: Sub Indo didahulukan, hardsub/softsub diurutkan, URL ganda & berbahaya dibuang', () => {
    const e = makeEpisode({
        episode: 3,
        servers: [
            { name: 'A (Sub English)', url: 'https://a.example/1', lang: 'en' },
            { name: 'B (Sub Indo)', url: 'https://b.example/1', lang: 'id' },
            { name: 'C', url: 'javascript:alert(1)' },
            { name: 'B lagi', url: 'https://b.example/1', lang: 'id' },
            { name: 'D (Multi Sub)', url: 'https://d.example/1', lang: 'multi' },
            { name: 'E (Softsub Indo)', url: 'https://e.example/1', lang: 'id', subtitleType: 'soft' },
            { name: 'F (Hardsub Indo)', url: 'https://f.example/1', lang: 'id', subtitleType: 'hard' },
            { name: 'G (Hardsub Multi)', url: 'https://g.example/1', lang: 'multi', subtitleType: 'hard' },
        ],
        downloads: [{ quality: '1080p', links: [{ provider: 'X', url: 'https://x.example/f' }, { provider: 'Y', url: 'ftp://y' }] }, { quality: '720p', links: [] }],
    });
    assert.deepEqual(e.servers.map((s) => s.name), ['F (Hardsub Indo)', 'E (Softsub Indo)', 'B (Sub Indo)', 'G (Hardsub Multi)', 'D (Multi Sub)', 'A (Sub English)']);
    assert.equal(e.servers[0].subtitleType, 'hard');
    assert.equal(e.servers[1].subtitleType, 'soft');
    assert.ok(!('subtitleType' in e.servers[2]), 'metadata yang tidak tertulis tidak ditebak');
    assert.equal(e.downloads.length, 1);
    assert.deepEqual(e.downloads[0].links, [{ provider: 'X', url: 'https://x.example/f' }]);
    assert.equal(e.episode, 3);
});
