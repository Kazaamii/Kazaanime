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
        ...(impl.browse ? { browse: track('browse', impl.browse), supportsBrowse: true } : {}),
        ...(impl.browseDonghua ? { browseDonghua: track('browseDonghua', impl.browseDonghua) } : {}),
        ...(impl.genres ? { genres: track('genres', impl.genres), supportsBrowse: true } : {}),
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

test('latestSubIndo: hanya AnimeKu & Oploverz yang menjadi panel (23 Okt 2026)', async () => {
    const animeku = stub('animeku', { latest: async () => [anime('animeku', 'x', 'Anime Sama')], browse: async () => ({ items: [] }) });
    const oploverz = stub('oploverz', { latest: async () => [anime('oploverz', 'x', 'Anime Sama')] });
    const samehadaku = stub('samehadaku', { latest: async () => [anime('samehadaku', 'x', 'Tidak dipakai')] });
    const otakudesu = stub('otakudesu', { latest: async () => { throw fail('blocked', 'otakudesu'); } });
    const sakunime = stub('sakunime', { latest: async () => [anime('sakunime', 'x', 'Tidak dipakai')] });
    const kuramanime = stub('kuramanime', { latest: async () => [anime('kuramanime', 'x', 'Tidak dipakai')] });

    const result = await reg([samehadaku, otakudesu, sakunime, kuramanime, oploverz, animeku], null, { enrichImages: false }).latestSubIndo();
    assert.deepEqual(result.data.map((source) => source.id), ['animeku', 'oploverz'], 'urutan panel: AnimeKu lalu Oploverz');
    assert.deepEqual(result.data[0].items.map((item) => item.title), ['Anime Sama']);
    assert.deepEqual(result.data[1].items.map((item) => item.title), ['Anime Sama'], 'judul yang sama tetap disajikan oleh sumber kedua');
    assert.equal(result.data[0].homeUrl, 'https://animeku.test');
    assert.deepEqual(result.data.map((source) => source.browse), [true, false],
        'flag browse sesuai kemampuan adapter (tautan "Lihat semua" tidak dibuat untuk sumber tanpa halaman daftar)');
    for (const old of [samehadaku, otakudesu, sakunime, kuramanime]) {
        assert.deepEqual(old.calls, [], `${old.id} tidak boleh dipanggil untuk panel Sub Indo`);
    }
});

test('latestSubIndo: sumber pengganti yang gagal tetap tampil sebagai panel dengan diagnosis', async () => {
    const animeku = stub('animeku', { latest: async () => { throw fail('blocked', 'animeku'); } });
    const oploverz = stub('oploverz', { latest: async () => [anime('oploverz', 'x', 'Masih Jalan')] });
    const result = await reg([animeku, oploverz], null, { enrichImages: false }).latestSubIndo();
    assert.deepEqual(result.data.map((source) => source.id), ['animeku', 'oploverz']);
    assert.equal(result.data[0].error.kind, 'blocked');
    assert.equal(result.data[0].homeUrl, 'https://animeku.test', 'panel gagal tetap bisa dibuka manual');
    assert.deepEqual(result.data[1].items.map((item) => item.title), ['Masih Jalan']);
    assert.equal(result.partial, true);
});

test('browse: diteruskan ke adapter yang mendukung daftar + hasil di-cache', async () => {
    const payload = { items: [anime('oploverz', 'x', 'Satu')], page: 1, hasNext: true, filters: [], genres: [], filter: 'popular', genre: '' };
    const O = stub('oploverz', { browse: async () => payload });
    const A = stub('animexin', {});
    const registry = reg([O, A], null, { enrichImages: false });

    const first = await registry.browse({ source: 'oploverz', filter: 'popular' });
    const second = await registry.browse({ source: 'oploverz', filter: 'popular' });
    assert.equal(first.source, 'oploverz');
    assert.equal(first.data.items[0].title, 'Satu');
    assert.deepEqual(O.calls, ['browse'], 'panggilan kedua memakai cache');
    assert.equal(second.data.hasNext, true);

    await assert.rejects(() => registry.browse({ source: 'animexin' }), (err) => err.status === 400);
    await assert.rejects(() => registry.browse({ source: 'tidak-ada' }), (err) => err.kind === 'not_found');
});

test('browse filter donghua: judul donghua metadata dicari lewat adapter.browseDonghua', async () => {
    const A = stub('animeku', {
        browse: async () => ({ items: [], page: 1, hasNext: true, filters: [], genres: [], filter: 'baru', genre: '' }),
        browseDonghua: async () => [anime('animeku', 'd', 'Meta Donghua')],
    });
    const registry = reg([A], metaStub(), { enrichImages: false });

    const res = await registry.browse({ source: 'animeku', filter: 'donghua' });
    assert.equal(res.source, 'animeku');
    assert.deepEqual(res.data.items.map((item) => item.title), ['Meta Donghua']);
    assert.equal(res.data.filter, 'donghua');
    assert.equal(res.data.hasNext, false, 'deteksi donghua tidak berhalaman');
    assert.deepEqual(A.calls, ['browseDonghua'], 'halaman daftar biasa tidak dipanggil');
    assert.ok(A.calls.includes('browseDonghua'));
    assert.equal(A.calls.includes('browse'), false);
});

test('browse filter donghua: adapter tanpa donghua memakai halaman daftar biasa', async () => {
    const O = stub('oploverz', { browse: async ({ filter }) => ({ items: [anime('oploverz', 'x', 'Biasa')], page: 1, hasNext: false, filters: [], genres: [], filter, genre: '' }) });
    const registry = reg([O], metaStub(), { enrichImages: false });

    const res = await registry.browse({ source: 'oploverz', filter: 'donghua' });
    assert.deepEqual(res.data.items.map((item) => item.title), ['Biasa']);
    assert.deepEqual(O.calls, ['browse']);
});

test('browse dengan q memakai pencarian adapter (bukan halaman daftar)', async () => {
    const payload = { items: [anime('animeku', 'x', 'Douluo Dalu')], page: 1, hasNext: false, filters: [], genres: [], filter: '', genre: '' };
    const A = stub('animeku', {
        browse: async () => payload,
        search: async () => [anime('animeku', 'y', 'Douluo Dalu II'), anime('animeku', 'z', 'Douluo Continent')],
    });
    const registry = reg([A], null, { enrichImages: false });

    const found = await registry.browse({ source: 'animeku', q: 'douluo' });
    assert.equal(found.source, 'animeku');
    assert.deepEqual(found.data.items.map((item) => item.title), ['Douluo Dalu II', 'Douluo Continent']);
    assert.equal(found.data.query, 'douluo');
    assert.equal(found.data.hasNext, false, 'hasil pencarian tidak berhalaman');
    assert.deepEqual(A.calls, ['search'], 'tidak memanggil halaman daftar');
});

test('health melaporkan mode gerbang robots.txt yang aktif', () => {
    const A = stub('samehadaku', {});
    const registry = createRegistry({
        adapters: [A],
        network: { robotsMode: 'off', robots: { snapshot: () => ({}) }, circuit: { snapshot: () => ({}) } },
        enrichImages: false,
    });
    const health = registry.health();
    assert.equal(health.robotsMode, 'off');
    assert.equal(health.sources[0].robots, 'unchecked');
});

test('download-only provider tidak ikut latest/search fan-out; Kusonime lookup tetap memakai cache terpisah', async () => {
    const A = stub('animexin', { latest: async () => [anime('animexin', 'x', 'X')], search: async () => [anime('animexin', 'x', 'X')] });
    let calls = 0;
    const downloader = {
        id: 'kusonime-downloads',
        name: 'Kusonime downloads',
        baseUrl: 'https://kusonime.com',
        policy: { tos: { verdict: 'unknown' } },
        async findDownloads(titles) {
            calls++;
            return { query: titles[0], matchedTitle: 'Sousou no Frieren', downloads: [] };
        },
    };
    const registry = createRegistry({ adapters: [A], downloaders: [downloader], metadata: metaStub(), cache: new TtlCache(), ttl: TTL });
    await registry.latest();
    await registry.search('frieren');
    assert.equal(calls, 0);
    const first = await registry.kusonimeDownloads(['Sousou no Frieren']);
    const second = await registry.kusonimeDownloads(['Sousou no Frieren']);
    assert.equal(first.data.matchedTitle, 'Sousou no Frieren');
    assert.equal(second.source, 'kusonime');
    assert.equal(calls, 1);
});

test('latest: adapter yang mendeklarasikan supportsLatest=false dilewati', async () => {
    const O = stub('animeonsen', { latest: async () => { throw new Error('must not call'); } });
    O.supportsLatest = false;
    const A = stub('animexin', { latest: async () => [anime('animexin', 'x', 'X')] });
    const result = await reg([O, A], metaStub()).latest();
    assert.equal(result.source, 'animexin');
    assert.equal(O.calls.length, 0);
    assert.deepEqual(A.calls, ['latest']);
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

test('search: judul sama dari sumber BERBEDA tetap dikirim (halaman nonton menggabungkan server); latest tetap dedupe lintas sumber', async () => {
    const mk = (id, items) => ({
        id, name: id, baseUrl: `https://${id}.example`, policy: { tos: { verdict: 'allowed' } },
        parseRef: (p) => ({ slug: p[0] }), titleHint: (r) => r.slug,
        latest: async () => items, search: async () => items, getAnime: async () => ({}), getEpisode: async () => ({}),
    });
    const a = makeAnime({ title: 'Kusuriya no Hitorigoto Season 3', slug: 'samehadaku~k3', source: 'samehadaku' });
    const b = makeAnime({ title: 'Kusuriya no Hitorigoto Season 3', slug: 'otakudesu~k3', source: 'otakudesu' });
    const reg = createRegistry({ adapters: [mk('samehadaku', [a]), mk('otakudesu', [b])], metadata: null, enrichImages: false });
    const s = await reg.search('kusuriya');
    assert.deepEqual(s.data.map((x) => x.slug), ['samehadaku~k3', 'otakudesu~k3']);
    const l = await reg.latest();
    assert.deepEqual(l.data.map((x) => x.slug), ['samehadaku~k3'], 'latest: kartu ganda lintas sumber dibuang');
});

test('browse: filter donghua memakai metadata + browseDonghua adapter (24 Okt 2026)', async () => {
    const seen = [];
    const A = stub('animeku', {
        browse: async () => { throw new Error('browse biasa tidak boleh dipakai untuk donghua'); },
        browseDonghua: async (titles) => {
            seen.push(...titles);
            return [anime('animeku', 'douluo', 'Douluo Dalu')];
        },
    });
    const registry = reg([A], metaStub({
        latestDonghua: async () => ({
            provider: 'kitsu',
            items: [{ title: 'Douluo Dalu' }, { title: 'Perfect World' }].map((item, i) => makeAnime({ ...item, source: 'kitsu', ids: { kitsu: i + 1 } })),
        }),
    }));
    const res = await registry.browse({ source: 'animeku', filter: 'donghua' });

    assert.deepEqual(seen, ['Douluo Dalu', 'Perfect World'], 'judul donghua dari metadata diteruskan ke adapter');
    assert.deepEqual(res.data.items.map((item) => item.slug), ['animeku~douluo']);
    assert.equal(res.data.filter, 'donghua');
    assert.equal(A.calls.includes('browse'), false, 'halaman filter situs tidak dipanggil');
});

test('browse: tahun & musim diteruskan ke adapter dan ikut kunci cache', async () => {
    const calls = [];
    const O = stub('oploverz', {
        browse: async (opts) => {
            calls.push(opts);
            return { items: [], page: opts.page || 1, hasNext: false };
        },
    });
    const registry = reg([O]);

    await registry.browse({ source: 'oploverz', year: 2024, season: 'fall' });
    await registry.browse({ source: 'oploverz', year: '2024', season: 'FALL' });
    assert.deepEqual(calls[0], { filter: '', genre: '', page: 1, year: '2024', season: 'fall' });
    assert.equal(calls.length, 1, 'normalisasi nilai + cache: permintaan identik tidak menembak ulang');

    await registry.browse({ source: 'oploverz', year: 2024, season: 'winter' });
    assert.equal(calls.length, 2, 'musim berbeda = kunci cache berbeda');

    // Nilai tak sah diabaikan (validasi ketat ada di route), bukan diteruskan mentah.
    await registry.browse({ source: 'oploverz', year: 'abcd', season: 'autumn' });
    assert.deepEqual(calls[2], { filter: '', genre: '', page: 1, year: '', season: '' });
});

test('genres: genre & musim per sumber digabung; satu sumber gagal tidak menggagalkan lainnya', async () => {
    const A = stub('animeku', {
        genres: async () => ({ genres: [{ id: 'aksi', label: 'Aksi' }], seasons: [] }),
    });
    const O = stub('oploverz', {
        genres: async () => ({
            genres: [{ id: 'action', label: 'Action' }, { id: 'slice-of-life', label: 'Slice of Life' }],
            seasons: [{ id: 'fall-2024', label: 'Fall 2024', season: 'fall', year: 2024 }],
        }),
    });
    const B = stub('rusak', { genres: async () => { throw fail('blocked', 'rusak'); } });
    const registry = reg([A, O, B]);
    const res = await registry.genres();

    assert.deepEqual(res.data.sources.map((source) => source.id), ['animeku', 'oploverz']);
    assert.deepEqual(res.data.sources[1].genres.map((genre) => genre.id), ['action', 'slice-of-life']);
    assert.deepEqual(res.data.sources[1].seasons.map((season) => season.id), ['fall-2024']);
    assert.equal(res.errors.length, 1, 'sumber yang gagal dilaporkan, bukan disembunyikan');
    assert.equal(res.stale, false);
});

test('genres: semua sumber gagal → error gabungan', async () => {
    const registry = reg([stub('rusak', { genres: async () => { throw fail('blocked', 'rusak'); } })]);
    await assert.rejects(() => registry.genres(), (err) => Boolean(err.message));
});
