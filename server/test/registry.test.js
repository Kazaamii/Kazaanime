import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAnime, makeEpisode } from '../lib/anime.js';
import { TtlCache } from '../lib/cache.js';
import { SourceError } from '../lib/errors.js';
import { createRegistry, mergeLists } from '../sources/index.js';

const TTL = {
    latestTtlMs: 600000, searchTtlMs: 900000, detailTtlMs: 900000, episodeTtlMs: 900000,
    notFoundTtlMs: 300000, staleMs: 3600000, cdnMaxAge: 600, cdnStale: 1800,
};

const anime = (source, slug, title, extra = {}) => makeAnime({ title, slug: `${source}~${slug}`, source, country: 'CN', image: `https://${source}.test/${slug}.jpg`, ...extra });
const fail = (kind, source = 'x') => new SourceError(`${source} ${kind}`, { kind, source });

/** Adapter tiruan yang mencatat pemanggilan. */
function stub(id, impl = {}, policy = {}) {
    const calls = [];
    const track = (name, fn) => async (...args) => {
        calls.push(name);
        return fn(...args);
    };
    return {
        id,
        name: id.toUpperCase(),
        baseUrl: `https://${id}.test`,
        policy: { tos: { verdict: 'allowed' }, imagePolicy: 'ok', ...policy },
        parseRef: (parts) => (parts.length === 1 ? { slug: parts[0] } : null),
        titleHint: (ref) => ref.slug.replace(/-/g, ' '),
        latest: track('latest', impl.latest || (async () => [])),
        search: track('search', impl.search || (async () => [])),
        getAnime: track('getAnime', impl.getAnime || (async () => { throw fail('not_found', id); })),
        getEpisode: track('getEpisode', impl.getEpisode || (async () => { throw fail('not_found', id); })),
        calls,
    };
}

function metaStub(impl = {}) {
    return {
        order: ['kitsu'],
        latestDonghua: impl.latestDonghua || (async () => ({ provider: 'kitsu', items: [makeAnime({ title: 'Meta Donghua', source: 'kitsu', country: 'CN', ids: { kitsu: 1 } })] })),
        search: impl.search || (async (q) => ({ provider: 'kitsu', items: [makeAnime({ title: `Meta ${q}`, source: 'kitsu', ids: { kitsu: 2 } })] })),
        findByTitle: impl.findByTitle || (async () => null),
        getById: impl.getById || (async (kind, id) => makeAnime({ title: `By ${kind} ${id}`, source: kind, ids: { [kind === 'mal' ? 'mal' : kind]: id } })),
        lookupImage: impl.lookupImage || (async () => null),
    };
}

const reg = (adapters, metadata = null, opts = {}) => createRegistry({ adapters, metadata, cache: new TtlCache(), ttl: TTL, enrichImages: true, enrichBudgetMs: 200, ...opts });

test('mergeLists: selang-seling antar sumber + judul ganda dibuang', () => {
    const a = [anime('a', '1', 'Satu'), anime('a', '2', 'Dua')];
    const b = [anime('b', '1', 'SATU!'), anime('b', '3', 'Tiga')];
    assert.deepEqual(mergeLists([a, b]).map((x) => x.slug), ['a~1', 'a~2', 'b~3']);
});

test('latest: semua sumber paralel; satu gagal → hasil sebagian + daftar errors', async () => {
    const A = stub('animexin', { latest: async () => [anime('animexin', 'x', 'X'), anime('animexin', 'y', 'Y')] });
    const K = stub('kuramanime', { latest: async () => { throw fail('blocked', 'kuramanime'); } });
    const r = await reg([A, K], metaStub()).latest();
    assert.equal(r.source, 'animexin');
    assert.equal(r.fallback, false);
    assert.equal(r.data.length, 2);
    assert.deepEqual(r.errors.map((e) => [e.source, e.kind]), [['kuramanime', 'blocked']]);
});

test('latest: semua scraper gagal → fallback API metadata (fallback: true)', async () => {
    const A = stub('animexin', { latest: async () => { throw fail('timeout', 'animexin'); } });
    const r = await reg([A], metaStub()).latest();
    assert.equal(r.source, 'metadata');
    assert.equal(r.fallback, true);
    assert.equal(r.provider, 'kitsu');
    assert.equal(r.data[0].title, 'Meta Donghua');
});

test('latest: semua gagal termasuk metadata → error 504 bila ada timeout', async () => {
    const A = stub('animexin', { latest: async () => { throw fail('timeout', 'animexin'); } });
    const meta = metaStub({ latestDonghua: async () => { throw fail('network', 'kitsu'); } });
    await assert.rejects(reg([A], meta).latest(), (e) => e.status === 504 && e.details.length === 2);
});

test('latest: di-cache (sumber hanya dipanggil sekali) + stale-if-error', async () => {
    let n = 0;
    const A = stub('animexin', { latest: async () => { n++; if (n > 1) throw fail('network', 'animexin'); return [anime('animexin', 'x', 'X')]; } });
    const cache = new TtlCache();
    const r1 = createRegistry({ adapters: [A], cache, ttl: TTL, enrichImages: false });
    await r1.latest();
    await r1.latest();
    assert.equal(n, 1);
    // paksa kedaluwarsa → sumber gagal → data lama dipakai (stale)
    for (const e of cache.map.values()) e.expires = 0;
    const r = await r1.latest();
    assert.equal(r.stale, true);
    assert.equal(r.data[0].title, 'X');
    assert.equal(r.errors[0].kind, 'network');
});

test('gambar dilindungi hotlink → diganti poster metadata, yang tidak ketemu → null (frontend pakai placeholder)', async () => {
    const A = stub('animexin', { latest: async () => [anime('animexin', 'a', 'Ada Poster'), anime('animexin', 'b', 'Tanpa Poster')] }, { imagePolicy: 'blocked' });
    const meta = metaStub({ lookupImage: async (t) => (t === 'Ada Poster' ? { image: 'https://media.kitsu.app/p.jpg', banner: null } : null) });
    const r = await reg([A], meta).latest();
    assert.deepEqual(r.data.map((x) => x.image), ['https://media.kitsu.app/p.jpg', null]);
});

test('gambar: pencarian poster yang lambat dipotong batas waktu (respons tidak menunggu)', async () => {
    const A = stub('animexin', { latest: async () => [anime('animexin', 'a', 'Lambat')] }, { imagePolicy: 'blocked' });
    const meta = metaStub({ lookupImage: () => new Promise((r) => setTimeout(() => r({ image: 'https://x/late.jpg' }), 1000)) });
    const t0 = Date.now();
    const r = await reg([A], meta, { enrichBudgetMs: 100 }).latest();
    assert.ok(Date.now() - t0 < 600);
    assert.equal(r.data[0].image, null);
});

test('search: gabungan sumber; semua gagal → metadata; hasil kosong (tanpa error) tetap kosong', async () => {
    const A = stub('animexin', { search: async (q) => [anime('animexin', 'sl', `Soul Land ${q}`)] });
    const r = await reg([A], metaStub()).search('soul land');
    assert.equal(r.source, 'animexin');
    assert.equal(r.data.length, 1);

    const dead = stub('animexin', { search: async () => { throw fail('blocked', 'animexin'); } });
    const r2 = await reg([dead], metaStub()).search('naruto');
    assert.equal(r2.fallback, true);
    assert.equal(r2.data[0].title, 'Meta naruto');

    const empty = stub('animexin', { search: async () => [] });
    const r3 = await reg([empty], metaStub()).search('zzz');
    assert.equal(r3.fallback, false);
    assert.deepEqual(r3.data, []);
});

test('detail: dirutekan lewat prefix slug; slug salah → 400; sumber tak dikenal → 404', async () => {
    const A = stub('animexin', { getAnime: async (ref) => ({ ...anime('animexin', ref.slug, 'Judul'), episodeList: [] }) });
    const r = reg([A], metaStub());
    const d = await r.detail('animexin~judul');
    assert.equal(d.source, 'animexin');
    assert.equal(d.data.slug, 'animexin~judul');
    await assert.rejects(r.detail('bukan slug'), (e) => e.status === 400);
    await assert.rejects(r.detail('animexin~a~b'), (e) => e.status === 400);
    await assert.rejects(r.detail('lain~x'), (e) => e.status === 404);
});

test('detail: sumber gagal → metadata dari judul slug (slug asli dipertahankan); tidak ketemu → error asli', async () => {
    const A = stub('animexin', { getAnime: async () => { throw fail('blocked', 'animexin'); } });
    const meta = metaStub({ findByTitle: async (t) => (t === 'renegade immortal' ? makeAnime({ title: 'Renegade Immortal', source: 'kitsu', ids: { kitsu: 48036 } }) : null) });
    const d = await reg([A], meta).detail('animexin~renegade-immortal');
    assert.equal(d.fallback, true);
    assert.equal(d.source, 'metadata');
    assert.equal(d.data.slug, 'animexin~renegade-immortal');
    assert.equal(d.data.ids.kitsu, 48036);
    await assert.rejects(reg([A], meta).detail('animexin~tidak-ada'), (e) => e.kind === 'blocked');
});

test('detail: slug metadata (kitsu~123) → getById', async () => {
    const d = await reg([], metaStub()).detail('kitsu~46474');
    assert.equal(d.data.title, 'By kitsu 46474');
    await assert.rejects(reg([], metaStub()).detail('mal~abc'), (e) => e.status === 400);
});

test('detail: "tidak ditemukan" di-cache singkat (slug salah tidak terus menembak sumber)', async () => {
    const A = stub('animexin');
    const r = reg([A], null);
    await assert.rejects(r.detail('animexin~tidak-ada'), (e) => e.status === 404);
    await assert.rejects(r.detail('animexin~tidak-ada'), (e) => e.status === 404);
    assert.equal(A.calls.filter((c) => c === 'getAnime').length, 1);
});

test('episode: detail (cache) → episode; nomor tidak valid → 400; slug metadata → 404', async () => {
    const A = stub('animexin', {
        getAnime: async () => ({ ...anime('animexin', 'x', 'X', { latestEpisode: 2 }), episodeList: [{ number: 1 }, { number: 2 }] }),
        getEpisode: async (ref, ep, ctx) => {
            if (!ctx.anime.episodeList.some((e) => e.number === ep)) throw fail('not_found', 'animexin');
            return makeEpisode({ episode: ep, servers: [{ name: 'S', url: 'https://s.test/e' }] });
        },
    });
    const r = reg([A], metaStub());
    const e = await r.episode('animexin~x', 2);
    assert.equal(e.data.episode, 2);
    assert.equal(e.data.servers.length, 1);
    await r.episode('animexin~x', 1);
    assert.equal(A.calls.filter((c) => c === 'getAnime').length, 1, 'detail dipakai bersama antar episode');
    await assert.rejects(r.episode('animexin~x', 0), (err) => err.status === 400);
    await assert.rejects(r.episode('kitsu~1', 1), (err) => err.status === 404);
    await assert.rejects(r.episode('animexin~x', 9), (err) => err.status === 404);
});

test('episode: episode baru rilis setelah daftar di-cache → detail dimuat ulang sekali', async () => {
    let latest = 2;
    const A = stub('animexin', {
        getAnime: async () => ({ ...anime('animexin', 'x', 'X', { latestEpisode: latest }), episodeList: Array.from({ length: latest }, (_, i) => ({ number: i + 1 })) }),
        getEpisode: async (ref, ep, ctx) => {
            if (!ctx.anime.episodeList.some((e) => e.number === ep)) throw fail('not_found', 'animexin');
            return makeEpisode({ episode: ep });
        },
    });
    const cache = new TtlCache();
    const r = createRegistry({ adapters: [A], cache, ttl: TTL, enrichImages: false });
    await r.episode('animexin~x', 1);
    latest = 3; // situs merilis episode 3
    for (const e of cache.map.values()) e.storedAt -= 120000; // detail sudah berumur > 60 dtk
    const e3 = await r.episode('animexin~x', 3);
    assert.equal(e3.data.episode, 3);
    assert.equal(A.calls.filter((c) => c === 'getAnime').length, 2);
});

test('ToS "forbidden" → adapter tidak pernah dipanggil', async () => {
    const F = stub('dilarang', { latest: async () => [anime('dilarang', 'x', 'X')] }, { tos: { verdict: 'forbidden' } });
    const r = await reg([F], metaStub()).latest();
    assert.equal(r.source, 'metadata');
    assert.equal(F.calls.length, 0);
});

test('health(): ringkasan sumber, metadata & cache', () => {
    const h = reg([stub('animexin')], metaStub()).health();
    assert.equal(h.sources[0].id, 'animexin');
    assert.equal(h.sources[0].circuit, 'closed');
    assert.equal(h.metadata.enabled, true);
    assert.equal(typeof h.cache.entries, 'number');
});
