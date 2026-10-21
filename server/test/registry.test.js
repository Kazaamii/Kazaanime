import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAnime, makeEpisode } from '../lib/anime.js';
import { TtlCache } from '../lib/cache.js';
import { SourceError } from '../lib/errors.js';
import { createRegistry, mergeLists } from '../sources/index.js';

const TTL = {
    latestTtlMs: 600000, searchTtlMs: 900000, detailTtlMs: 900000, episodeTtlMs: 900000, scheduleTtlMs: 3600000,
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
        ...(impl.schedule ? { schedule: track('schedule', impl.schedule) } : {}),
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

test('schedule: gabung per hari — berjam (urut jam) dulu, lalu tanpa jam; judul ganda dibuang; di-cache', async () => {
    const S = stub('samehadaku', { schedule: async () => ({
        0: [{ title: 'Kusuriya no Hitorigoto Season 3', time: '01:00', slug: 'samehadaku~kusuriya-no-hitorigoto-season-3', source: 'samehadaku', country: 'JP' },
            { title: 'Ao no Hako Season 2', time: '00:30', slug: 'samehadaku~ao-no-hako-season-2', source: 'samehadaku', country: 'JP' }],
        1: [{ title: 'One Piece', time: '00:00', slug: 'samehadaku~one-piece', source: 'samehadaku', country: 'JP' }],
    }) });
    const A = stub('animexin', { schedule: async () => ({
        0: [{ title: 'Soul Land 2', time: null, slug: 'animexin~soul-land-2', source: 'animexin', country: 'CN' },
            { title: 'ONE PIECE', time: null, slug: 'animexin~one-piece', source: 'animexin', country: 'CN' }],
        1: [{ title: 'Renegade Immortal', time: null, slug: 'animexin~renegade-immortal', source: 'animexin', country: 'CN' }],
    }) });
    const N = stub('lain'); // tanpa schedule() → dilewati
    const r = reg([S, A, N]);
    const res = await r.schedule();
    assert.equal(res.source, 'samehadaku,animexin');
    assert.equal(res.data.timezone, 'Asia/Jakarta');
    assert.deepEqual(res.data.days[0].map((x) => x.title), ['Ao no Hako Season 2', 'Kusuriya no Hitorigoto Season 3', 'Soul Land 2', 'ONE PIECE']);
    assert.deepEqual(res.data.days[1].map((x) => x.title), ['One Piece', 'Renegade Immortal'], '"ONE PIECE" di hari lain bukan duplikat');
    assert.deepEqual(res.data.days[5], []);
    await r.schedule();
    assert.equal(S.calls.filter((c) => c === 'schedule').length, 1, 'jadwal di-cache');
});

test('schedule: satu sumber gagal → hasil sebagian + errors; semua gagal → error 5xx', async () => {
    const S = stub('samehadaku', { schedule: async () => { throw fail('network', 'samehadaku'); } });
    const A = stub('animexin', { schedule: async () => ({ 2: [{ title: 'Martial Master', time: null, slug: 'animexin~martial-master', source: 'animexin' }] }) });
    const res = await reg([S, A]).schedule();
    assert.equal(res.source, 'animexin');
    assert.deepEqual(res.errors.map((e) => [e.source, e.kind]), [['samehadaku', 'network']]);
    const bad = stub('samehadaku', { schedule: async () => { throw fail('blocked', 'samehadaku'); } });
    await assert.rejects(() => reg([bad]).schedule(), (err) => err.status >= 500);
    await assert.rejects(() => reg([stub('lain')]).schedule(), (err) => err.code === 'NO_SOURCES');
});

test('withSafeImages: Kitsu tidak ketemu → judul Mandarin diambil dari detail situs sumber (di-cache) untuk poster Bangumi', async () => {
    const asked = [];
    const A = stub('animexin', {
        latest: async () => [anime('animexin', 'the-guardian-of-daxia', 'The Guardian of Daxia'), anime('animexin', 'renegade-immortal', 'Renegade Immortal')],
        getAnime: async (ref) => anime('animexin', ref.slug, ref.slug, { titleAlt: ref.slug === 'the-guardian-of-daxia' ? '大夏守墓人' : 'Xian Ni' }),
    }, { imagePolicy: 'blocked' });
    const meta = metaStub({
        lookupImage: async (title, _ctx, { resolveNative } = {}) => {
            if (title === 'Renegade Immortal') return { image: 'https://media.kitsu.app/ri.jpg', provider: 'kitsu' };
            const native = await resolveNative();
            asked.push(native);
            return native === '大夏守墓人' ? { image: 'https://lain.bgm.tv/pic/cover/l/13/57/466756_xd3AT.jpg', provider: 'bangumi' } : null;
        },
    });
    const r = reg([A], meta, { enrichBudgetMs: 2000 });
    const res = await r.latest();
    assert.deepEqual(res.data.map((x) => x.image), ['https://lain.bgm.tv/pic/cover/l/13/57/466756_xd3AT.jpg', 'https://media.kitsu.app/ri.jpg']);
    assert.deepEqual(asked, ['大夏守墓人']);
    // detail berikutnya memakai cache yang sama (tidak mengambil ulang halaman seri)
    await r.detail('animexin~the-guardian-of-daxia');
    assert.equal(A.calls.filter((c) => c === 'getAnime').length, 1);
});

test('latest: pencarian poster melewati batas waktu → hasil ditandai partial (cache CDN pendek)', async () => {
    const A = stub('animexin', { latest: async () => [anime('animexin', 'a', 'A'), anime('animexin', 'b', 'B')] }, { imagePolicy: 'blocked' });
    const slow = metaStub({ lookupImage: (title) => new Promise((r) => setTimeout(() => r(title === 'A' ? { image: 'https://x.test/a.jpg' } : null), title === 'A' ? 5 : 400)) });
    const res = await reg([A], slow, { enrichBudgetMs: 100 }).latest();
    assert.equal(res.partial, true);
    assert.deepEqual(res.data.map((x) => x.image), ['https://x.test/a.jpg', null]);
    const fast = await reg([A], metaStub({ lookupImage: async () => ({ image: 'https://x.test/z.jpg' }) }), { enrichBudgetMs: 500 }).latest();
    assert.equal(fast.partial, false);
});
