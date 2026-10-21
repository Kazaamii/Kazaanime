import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../lib/cache.js';
import { SourceError } from '../lib/errors.js';
import { createMetadata, kitsuCountry, normalizeAniList, normalizeJikan, normalizeKitsu } from '../sources/metadata.js';
import { fixture } from './helpers.js';

test('normalizeKitsu: data asli Kitsu → anime seragam + id MAL/AniList dari mappings', () => {
    const json = JSON.parse(fixture('kitsu-search.json'));
    const included = new Map(json.included.map((r) => [`${r.type}:${r.id}`, r]));
    const a = normalizeKitsu(json.data[0], included);
    assert.equal(a.title, 'Douluo Dalu');
    assert.deepEqual(a.ids, { anilist: 101920, mal: 37150, kitsu: 41004 });
    assert.equal(a.country, 'CN');
    assert.equal(a.format, 'ONA');
    assert.equal(a.status, 'COMPLETED');
    assert.equal(a.year, 2018);
    assert.ok(a.image.startsWith('https://media.kitsu.app/'));
    assert.equal(a.source, 'kitsu');
    assert.equal(a.slug, null);
});

test('kitsuCountry: romanisasi jadi penanda (zh_cn saja tidak cukup)', () => {
    assert.equal(kitsuCountry({ en: 'Renegade Immortal', en_cn: 'Xian Ni', zh_cn: '仙逆' }), 'CN');
    assert.equal(kitsuCountry({ en: 'Frieren', en_jp: 'Sousou no Frieren', ja_jp: '葬送のフリーレン', zh_cn: '葬送的芙莉莲' }), 'JP');
    assert.equal(kitsuCountry({ en: 'X', en_kr: 'Yeosingangnim', ko_kr: '여신강림' }), 'KR');
    assert.equal(kitsuCountry({ zh_cn: '斗罗大陆' }), 'CN');
    assert.equal(kitsuCountry({ en: 'Only English' }), null);
});

test('normalizeJikan & normalizeAniList (bentuk respons sesuai dokumentasi API)', () => {
    const j = normalizeJikan({
        mal_id: 52991, url: 'https://myanimelist.net/anime/52991', title: 'Sousou no Frieren', title_english: "Frieren: Beyond Journey's End",
        images: { webp: { large_image_url: 'https://cdn.myanimelist.net/images/anime/1015/138006l.webp' } }, synopsis: 'Sinopsis.\n\n[Written by MAL Rewrite]',
        episodes: 28, genres: [{ name: 'Adventure' }], score: 9.3, status: 'Finished Airing', airing: false, type: 'TV', year: 2023,
        studios: [{ name: 'Madhouse' }], duration: '24 min per ep', season: 'fall', members: 1200000,
    });
    assert.equal(j.title, "Frieren: Beyond Journey's End");
    assert.equal(j.titleAlt, 'Sousou no Frieren');
    assert.deepEqual(j.ids, { anilist: null, mal: 52991, kitsu: null });
    assert.equal(j.status, 'COMPLETED');
    assert.equal(j.description, 'Sinopsis.');
    assert.equal(j.duration, 24);
    assert.equal(j.season, 'FALL');

    const al = normalizeAniList({
        id: 154587, idMal: 52991, siteUrl: 'https://anilist.co/anime/154587', title: { romaji: 'Sousou no Frieren', english: 'Frieren' },
        coverImage: { extraLarge: 'https://s4.anilist.co/x.jpg' }, description: 'A<br>B <i>C</i>', episodes: null, genres: ['Drama'],
        averageScore: 91, status: 'RELEASING', format: 'TV', season: 'FALL', seasonYear: 2023, countryOfOrigin: 'JP',
        duration: 24, nextAiringEpisode: { episode: 9, airingAt: 1792600000 }, studios: { nodes: [{ name: 'Madhouse' }] },
    });
    assert.equal(al.status, 'ONGOING');
    assert.equal(al.latestEpisode, 8);
    assert.equal(al.description, 'A B C');
    assert.equal(al.score, 9.1);
    assert.deepEqual(al.nextAiring, { episode: 9, airingAt: 1792600000 });
});

/** createClient palsu untuk API metadata: per sumber, fungsi(url, opts) → JSON | Error. */
function metaWith(handlers) {
    const calls = [];
    const createClient = (_net, opts) => ({
        async json(url, o = {}) {
            calls.push({ source: opts.source, url, body: o.body });
            const h = handlers[opts.source];
            if (!h) throw new SourceError(`${opts.source} mati`, { kind: 'network', source: opts.source });
            const out = await h(url, o);
            if (out instanceof Error) throw out;
            return out;
        },
    });
    const m = createMetadata({ network: {}, createClient, cache: new TtlCache() });
    return { m, calls };
}

const kitsuItem = (id, titles, extra = {}) => ({
    id: String(id),
    type: 'anime',
    attributes: { canonicalTitle: titles.en_cn || titles.en_jp || titles.en, titles, posterImage: { large: `https://media.kitsu.app/anime/${id}/poster.jpg` }, status: 'current', subtype: 'ONA', ...extra },
    relationships: { mappings: { data: [] } },
});

test('metadata.search: Kitsu gagal → Jikan dipakai (urutan fallback)', async () => {
    const { m, calls } = metaWith({
        jikan: async () => ({ data: [{ mal_id: 1, title: 'Naruto', type: 'TV', status: 'Finished Airing' }] }),
    });
    const r = await m.search('naruto');
    assert.equal(r.provider, 'jikan');
    assert.equal(r.items[0].ids.mal, 1);
    assert.deepEqual(calls.map((c) => c.source), ['kitsu', 'jikan']);
});

test('metadata.search: semua mati → error gabungan', async () => {
    const { m } = metaWith({});
    await assert.rejects(m.search('naruto'), (e) => e.status >= 500 && e.details.length === 3);
});

test('metadata.latestDonghua: Kitsu ONA+TV tayang, hanya yang berasal dari Tiongkok', async () => {
    const { m, calls } = metaWith({
        kitsu: async (url) => {
            const sub = new URL(url).searchParams.get('filter[subtype]');
            return sub === 'ONA'
                ? { data: [kitsuItem(48036, { en: 'Renegade Immortal', en_cn: 'Xian Ni', zh_cn: '仙逆' }), kitsuItem(43740, { en: 'Holo no Graffiti', en_jp: 'Holo no Graffiti', ja_jp: 'x' })] }
                : { data: [kitsuItem(47439, { en: 'Shrouding the Heavens', en_cn: 'Zhe Tian', zh_cn: '遮天' })] };
        },
    });
    const r = await m.latestDonghua();
    assert.equal(r.provider, 'kitsu');
    assert.deepEqual(r.items.map((a) => a.title), ['Renegade Immortal', 'Shrouding the Heavens']);
    assert.ok(calls.every((c) => !c.url.includes('jikan')), 'Jikan tidak dipakai (tidak bisa filter negara)');
});

test('metadata.lookupImage: judul persis (termasuk judul dalam kurung) → poster; di-cache', async () => {
    let n = 0;
    const { m } = metaWith({
        kitsu: async (url) => {
            n++;
            const q = new URL(url).searchParams.get('filter[text]');
            if (q === 'Yi Nian Yong Heng [A Will Eternal]') return { data: [kitsuItem(43278, { en: 'A Will Eternal', en_cn: 'Yi Nian Yong Heng' })] };
            return { data: [] };
        },
    });
    const hit = await m.lookupImage('Yi Nian Yong Heng [A Will Eternal]');
    assert.equal(hit.image, 'https://media.kitsu.app/anime/43278/poster.jpg');
    await m.lookupImage('Yi Nian Yong Heng [A Will Eternal]');
    assert.equal(n, 1, 'hasil di-cache');
});

test('metadata.lookupImage: judul ber-season → poster seri utama (query kedua tanpa season); tidak cocok → null', async () => {
    const queries = [];
    const { m } = metaWith({
        kitsu: async (url) => {
            const q = new URL(url).searchParams.get('filter[text]');
            queries.push(q);
            if (q === 'Swallowed Star') return { data: [kitsuItem(43803, { en: 'Swallowed Star', en_cn: 'Tunshi Xingkong' })] };
            if (q === 'Swallowed Star Season 5') return { data: [kitsuItem(48061, { en_cn: 'Tunshi Xingkong 4' })] };
            return { data: [kitsuItem(1, { en: 'Judul Lain Sama Sekali' })] };
        },
    });
    assert.equal((await m.lookupImage('Swallowed Star Season 5')).image, 'https://media.kitsu.app/anime/43803/poster.jpg');
    assert.deepEqual(queries, ['Swallowed Star Season 5', 'Swallowed Star']);
    assert.equal(await m.lookupImage('The Guardian of Daxia'), null, 'hasil teratas yang judulnya beda TIDAK dipakai');
});

test('metadata.findByTitle: persis → dengan id; cocok tanpa season → tanpa id; selain itu null', async () => {
    const { m } = metaWith({
        kitsu: async (url) => {
            const q = new URL(url).searchParams.get('filter[text]');
            if (q === 'renegade immortal') return { data: [kitsuItem(48036, { en: 'Renegade Immortal', en_cn: 'Xian Ni' })], included: [] };
            if (q === 'tales of demons and gods season 10') return { data: [kitsuItem(13688, { en: 'Tales of Demons and Gods', en_cn: 'Yao Shen Ji' })] };
            return { data: [kitsuItem(2, { en: 'Bukan Ini' })] };
        },
    });
    const exact = await m.findByTitle('renegade immortal');
    assert.equal(exact.ids.kitsu, 48036);
    const loose = await m.findByTitle('tales of demons and gods season 10');
    assert.equal(loose.title, 'Tales of Demons and Gods');
    assert.deepEqual(loose.ids, { anilist: null, mal: null, kitsu: null });
    assert.equal(await m.findByTitle('sesuatu yang tidak ada'), null);
});

test('metadata.getById: kitsu / mal (Jikan) / anilist (GraphQL POST)', async () => {
    const { m, calls } = metaWith({
        kitsu: async () => ({ data: kitsuItem(46474, { en: 'Frieren', en_jp: 'Sousou no Frieren' }) }),
        jikan: async () => ({ data: { mal_id: 52991, title: 'Sousou no Frieren', type: 'TV', status: 'Finished Airing' } }),
        anilist: async (url, o) => {
            const body = JSON.parse(o.body);
            assert.match(body.query, /Media\(id: \$id/);
            return { data: { Media: { id: body.variables.id, title: { romaji: 'Sousou no Frieren' }, status: 'FINISHED', format: 'TV' } } };
        },
    });
    assert.equal((await m.getById('kitsu', 46474)).ids.kitsu, 46474);
    assert.equal((await m.getById('mal', 52991)).ids.mal, 52991);
    assert.equal((await m.getById('anilist', 154587)).ids.anilist, 154587);
    assert.equal(calls.find((c) => c.source === 'anilist').url, 'https://graphql.anilist.co');
});
