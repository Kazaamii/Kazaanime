import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../lib/cache.js';
import { SourceError } from '../lib/errors.js';
import * as metadataModule from '../sources/metadata.js';
import { cjkKey, createMetadata, hasCjk, kitsuCountry, normalizeAniList, normalizeKitsu } from '../sources/metadata.js';
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

test('normalizeAniList (bentuk respons sesuai dokumentasi API) — Jikan sudah dihapus', () => {
    assert.equal(metadataModule.normalizeJikan, undefined, 'normalizer Jikan tidak diekspor lagi');
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

test('metadata.search: Kitsu gagal → AniList dipakai (urutan fallback, tanpa Jikan)', async () => {
    const { m, calls } = metaWith({
        anilist: async () => ({ data: { Page: { media: [{ id: 20, idMal: 20, title: { romaji: 'Naruto' }, status: 'FINISHED', format: 'TV' }] } } }),
    });
    const r = await m.search('naruto');
    assert.equal(r.provider, 'anilist');
    assert.equal(r.items[0].ids.anilist, 20);
    assert.deepEqual(calls.map((c) => c.source), ['kitsu', 'anilist']);
    assert.ok(calls.every((c) => !c.url.includes('jikan')), 'Jikan tidak pernah dipanggil');
});

test('metadata.search: semua mati → error gabungan', async () => {
    const { m } = metaWith({});
    await assert.rejects(m.search('naruto'), (e) => e.status >= 500 && e.details.length === 2);
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
    assert.ok(calls.every((c) => !c.url.includes('jikan')), 'Jikan tidak dipakai');
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
        // Sumber poster berikutnya menjawab "tidak ada" (bukan gagal) → hasil null boleh di-cache
        bangumi: async () => ({ code: 404, error: 'Not Found' }),
        mangabaka: async () => ({ status: 200, data: [] }),
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

test('metadata.getById: kitsu / mal (lewat AniList idMal, tanpa Jikan) / anilist (GraphQL POST)', async () => {
    const { m, calls } = metaWith({
        kitsu: async () => ({ data: kitsuItem(46474, { en: 'Frieren', en_jp: 'Sousou no Frieren' }) }),
        anilist: async (url, o) => {
            const body = JSON.parse(o.body);
            assert.match(body.query, /Media\(id: \$id/);
            const v = body.variables;
            return { data: { Media: { id: v.id || 154587, idMal: v.idMal || 52991, title: { romaji: 'Sousou no Frieren' }, status: 'FINISHED', format: 'TV' } } };
        },
    });
    assert.equal((await m.getById('kitsu', 46474)).ids.kitsu, 46474);
    assert.equal((await m.getById('mal', 52991)).ids.mal, 52991);
    assert.equal((await m.getById('anilist', 154587)).ids.anilist, 154587);
    assert.equal(calls.find((c) => c.source === 'anilist').url, 'https://graphql.anilist.co');
    assert.ok(calls.every((c) => c.source !== 'jikan'), 'Jikan tidak pernah dipanggil');
});

test('metadata.lookupImage: Kitsu tidak punya → Bangumi lewat judul Mandarin (cocok persis) → MangaBaka (judul persis)', async () => {
    const asked = [];
    const { m, calls } = metaWith({
        kitsu: async () => ({ data: [kitsuItem(1, { en: 'Judul Lain Sama Sekali' })] }),
        bangumi: async (url) => {
            const q = decodeURIComponent(new URL(url).pathname.split('/').pop());
            if (q === '大夏守墓人') {
                return { results: 3, list: [
                    { id: 1, name: '大夏守墓人 前传', images: { large: 'http://lain.bgm.tv/pic/cover/l/xx/1_a.jpg' } },
                    { id: 466756, name: '大夏守墓人', name_cn: '大夏守墓人', images: { large: 'http://lain.bgm.tv/pic/cover/l/13/57/466756_xd3AT.jpg' } },
                ] };
            }
            // "顾安" → hasil tidak ada yang namanya persis sama → tidak dipakai
            return { results: 2, list: [{ id: 9, name: '安菟！安菟！', images: { large: 'http://lain.bgm.tv/pic/cover/l/03/cb/259938_Ft888.jpg' } }] };
        },
        mangabaka: async (url) => {
            const q = new URL(url).searchParams.get('q');
            if (q === 'Coiling Dragon') {
                return { status: 200, data: [
                    { title: 'Coiling Dragon', native_title: '盘龙', content_rating: 'safe', cover: { raw: { url: 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx1-x.jpg' } } },
                ] };
            }
            return { status: 200, data: [{ title: 'Guan Zhong and Bao Shu', content_rating: 'safe', cover: { raw: { url: 'https://s4.anilist.co/x.png' } } }] };
        },
    });
    const daxia = await m.lookupImage('The Guardian of Daxia', {}, { resolveNative: async () => { asked.push('daxia'); return '大夏守墓人'; } });
    assert.deepEqual(daxia, { image: 'https://lain.bgm.tv/pic/cover/l/13/57/466756_xd3AT.jpg', banner: null, provider: 'bangumi' }, 'nama persis, http → https');
    const guan = await m.lookupImage('Gu An [One Slash to the Heavens]', {}, { resolveNative: async () => '顾安' });
    assert.equal(guan, null, 'Bangumi & MangaBaka tanpa judul yang persis sama → tidak ada gambar (bukan gambar acak)');
    const dragon = await m.lookupImage('Coiling Dragon', {}, { resolveNative: async () => null });
    assert.equal(dragon.provider, 'mangabaka');
    assert.equal(dragon.image, 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx1-x.jpg');
    assert.deepEqual(asked, ['daxia']);
    assert.ok(calls.some((c) => c.source === 'bangumi' && c.url.includes('responseGroup=small')));
});

test('metadata.lookupImage: Kitsu cocok → Bangumi/MangaBaka & resolveNative tidak dipanggil', async () => {
    let resolved = 0;
    const { m, calls } = metaWith({
        kitsu: async () => ({ data: [kitsuItem(48036, { en: 'Renegade Immortal', en_cn: 'Xian Ni' })] }),
    });
    const hit = await m.lookupImage('Renegade Immortal', {}, { resolveNative: async () => { resolved++; return '仙逆'; } });
    assert.equal(hit.provider, 'kitsu');
    assert.equal(resolved, 0);
    assert.ok(!calls.some((c) => c.source === 'bangumi' || c.source === 'mangabaka'));
});

test('metadata.lookupImage: sumber poster GAGAL → error (tidak di-cache sebagai "tidak ada poster"), percobaan berikutnya jalan lagi', async () => {
    let kitsuUp = false;
    const { m } = metaWith({
        kitsu: async () => (kitsuUp ? { data: [kitsuItem(7, { en: 'Martial Master' })] } : new SourceError('kitsu timeout', { kind: 'timeout', source: 'kitsu' })),
        bangumi: async () => ({ code: 404 }),
        mangabaka: async () => ({ status: 200, data: [] }),
    });
    await assert.rejects(() => m.lookupImage('Martial Master'), /kitsu timeout/);
    kitsuUp = true;
    assert.equal((await m.lookupImage('Martial Master')).provider, 'kitsu');
});

test('metadata.hasCjk / cjkKey', () => {
    assert.equal(hasCjk('一念永恒'), true);
    assert.equal(hasCjk('Yi Nian Yong Heng'), false);
    assert.equal(cjkKey(' 大夏 守墓人！'), cjkKey('大夏守墓人'));
    assert.notEqual(cjkKey('炼气十万年特别篇'), cjkKey('炼气十万年'));
});
