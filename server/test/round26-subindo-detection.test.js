import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Putaran 26 (29 Okt 2026) — permintaan pengguna:
 * *"tolong perbaiki Deteksi Anime Untuk Sub Indo Kadang Tidak Terdeteksi Perkuat Deteksi Dan
 * Pencocokan Judul dan Fokus terhadap sub indo nya dlu apapun yang terjadi Harus bekerja."*
 *
 * Tiga penyebab "Sub Indo tidak terdeteksi" yang diperbaiki di sini:
 *  1. Pencocokan judul hanya menerima judul yang SAMA PERSIS (titleKey/looseTitleKey) → anime
 *     yang ada di AnimeKu/Animeloverz dianggap tidak ada bila situs menulis judulnya sedikit
 *     berbeda (angka Romawi, tahun, "Sub Indo", "Season 2" vs "2nd Season", salah ketik).
 *  2. Kata kunci pencarian hanya judul utuh + tanpa penanda season → pencarian WordPress
 *     (semua kata wajib ada) tidak menemukan judul yang ditulis situs dengan gaya lain.
 *  3. Hasil pencarian yang kehilangan AnimeKu/Animeloverz (situs sempat gagal/rate limit)
 *     tetap di-cache ±15 menit di CDN & peramban → Sub Indo "hilang" sampai cache habis.
 */

// js/api/http.js memasang listener `online` saat modul dimuat → stub minimal.
globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
};
// Cache http memakai sessionStorage; Map kecil sudah cukup untuk menguji "tidak disimpan".
const storage = new Map();
globalThis.sessionStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    get length() { return storage.size; },
    key: (index) => [...storage.keys()][index] ?? null,
};

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

/** fetch asli — tes sisi server memakai HTTP nyata, sedangkan tes frontend men-stub fetch. */
const realFetch = globalThis.fetch;

const { titleSignature, titleMatchScore, titleQueryVariants, TITLE_MATCH_THRESHOLD } = await import('../../js/api/normalize.js');
const { matchBackendItem, findBackendMatches, SUB_INDO_SOURCES } = await import('../../js/api/streams.js');
const { searchBackend } = await import('../../js/api/sources.js');

/* ------------------------------------------------------------------ */
/* Alat bantu                                                          */
/* ------------------------------------------------------------------ */
const json = (payload) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload),
});

/** Satu item hasil pencarian backend (bentuk respons /api/anime/search). */
const item = (title, site, slug) => ({
    title,
    titleAlt: '',
    slug: `${site}~${slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}`,
    source: site,
    country: 'JP',
});

/**
 * Stub fetch: `map` = { kata kunci → item[] }. Kueri yang tidak ada di map → kosong.
 * Semua permintaan dicatat di `calls` (path + query) untuk memeriksa `sources=` & cache.
 */
function stubSearch(map) {
    return stubSearchWith((q, only) => (map[q] || []).filter((row) => !only.length || only.includes(row.source)));
}

/** Stub fetch dengan fungsi penentu baris: (kata kunci, daftar situs yang diminta) → item[]. */
function stubSearchWith(rowsOf) {
    const calls = [];
    globalThis.fetch = async (raw) => {
        const url = new URL(String(raw), 'https://kazanime.test');
        calls.push(`${url.pathname}${url.search}`);
        const q = url.searchParams.get('q') || '';
        const only = (url.searchParams.get('sources') || '').split(',').filter(Boolean);
        return json({ ok: true, source: 'stub', fallback: false, data: rowsOf(q, only) || [] });
    };
    return calls;
}

/* ------------------------------------------------------------------ */
/* 1 · Tanda pengenal judul                                            */
/* ------------------------------------------------------------------ */
test('judul: angka Romawi, tahun, "Sub Indo" & season dibaca sebagai penanda, bukan kata judul', () => {
    const roman = titleSignature('Mushoku Tensei II: Isekai Ittara Honki Dasu');
    assert.equal(roman.season, 2, 'angka Romawi II = season 2');
    assert.equal(roman.tokens.includes('ii'), false, '"ii" tidak ikut jadi kata judul');

    const noisy = titleSignature('One Piece Film: Red (2022) Sub Indo');
    assert.equal(noisy.year, 2022);
    assert.equal(noisy.markers.includes('film'), true, 'film = penanda jenis karya');
    assert.deepEqual(noisy.tokens, ['one', 'piece', 'red'], 'kata tambahan situs dibuang');

    const season = titleSignature('Sousou No Frieren 2Nd Season');
    assert.equal(season.season, 2);
    assert.deepEqual(season.tokens, ['sousou', 'no', 'frieren']);

    const short = titleSignature('Overlord S4');
    assert.equal(short.season, 4);
    assert.deepEqual(short.tokens, ['overlord']);
});

test('judul: variasi penulisan yang sama tetap dianggap sama', () => {
    const same = [
        ['Sousou no Frieren', 'Sousou No Frieren'],
        ['Steins;Gate', 'Steins Gate'],
        ['Solo Leveling', 'Solo Leveling Sub Indo'],
        ['Frieren: Beyond Journey’s End', 'Frieren Beyond Journeys End'],
        ['Kusuriya no Hitorigoto Season 3', 'Kusuriya no Hitorigoto 3rd Season'],
        ['Jujutsu Kaisen S2', 'Jujutsu Kaisen Season 2'],
    ];
    for (const [left, right] of same) {
        const score = titleMatchScore(left, right);
        assert.ok(score >= TITLE_MATCH_THRESHOLD, `${left} ⟷ ${right} harus cocok (skor ${score})`);
    }
});

test('judul: season & jenis karya berbeda TIDAK boleh tercocokkan', () => {
    const different = [
        ['Sousou no Frieren', 'Sousou no Frieren 2nd Season'],
        ['Overlord', 'Overlord IV'],
        ['Mushoku Tensei II: Isekai Ittara Honki Dasu', 'Mushoku Tensei III: Isekai Ittara Honki Dasu'],
        ['Mushoku Tensei: Isekai Ittara Honki Dasu', 'Mushoku Tensei II: Isekai Ittara Honki Dasu'],
        ['Jujutsu Kaisen', 'Jujutsu Kaisen 0'],
        ['Naruto', 'Naruto Shippuden'],
        ['Attack on Titan', 'Attack on Titan Final Season'],
        ['Kimetsu no Yaiba', 'Kimetsu no Yaiba: Hashira Geiko-hen'],
        ['Boku no Hero Academia', 'Boku no Hero Academia 7th Season'],
    ];
    for (const [left, right] of different) {
        const score = titleMatchScore(left, right);
        assert.ok(score < TITLE_MATCH_THRESHOLD, `${left} ⟷ ${right} tidak boleh cocok (skor ${score})`);
    }
    // "Film" hanya di satu sisi: bukan padanan (masih di bawah ambang), walau judulnya mirip.
    assert.ok(titleMatchScore('One Piece', 'One Piece Film: Red') < TITLE_MATCH_THRESHOLD);
});

test('judul: kata "Movie"/"Special" pada judul situs tidak menggagalkan padanan yang sama', () => {
    const score = titleMatchScore('Jujutsu Kaisen 0', 'Jujutsu Kaisen 0 Movie');
    assert.ok(score >= TITLE_MATCH_THRESHOLD, `skor ${score} harus lolos ambang`);
});

test('judul: salah ketik satu huruf tetap dikenali', () => {
    const score = titleMatchScore('Shingeki no Kyojin', 'Shingeki no Kyoujin');
    assert.ok(score >= TITLE_MATCH_THRESHOLD, `skor ${score} harus lolos ambang`);
});

/* ------------------------------------------------------------------ */
/* 2 · Kata kunci pencarian                                            */
/* ------------------------------------------------------------------ */
test('kata kunci: gaya penulisan season lain ikut dicari', () => {
    assert.deepEqual(titleQueryVariants('Jujutsu Kaisen 2nd Season'),
        ['Jujutsu Kaisen 2nd Season', 'Jujutsu Kaisen', 'Jujutsu Kaisen Season 2'],
        '"2nd Season" juga dicari sebagai "Season 2" (pencarian WordPress wajib semua kata)');
    assert.ok(titleQueryVariants('Kusuriya no Hitorigoto Season 3').includes('Kusuriya no Hitorigoto 3rd Season'));
    assert.ok(titleQueryVariants('Overlord S4').includes('Overlord Season 4'));
});

test('kata kunci: angka Romawi & bagian utama judul dipakai sebagai cadangan', () => {
    const variants = titleQueryVariants('Mushoku Tensei II: Isekai Ittara Honki Dasu');
    assert.equal(variants[0], 'Mushoku Tensei II: Isekai Ittara Honki Dasu');
    assert.ok(variants.includes('Mushoku Tensei: Isekai Ittara Honki Dasu'), 'angka Romawi dibuang');
    assert.ok(variants.includes('Mushoku Tensei II'), 'bagian sebelum titik dua');
    assert.ok(titleQueryVariants('One Piece (2024)').includes('One Piece'));
});

/* ------------------------------------------------------------------ */
/* 3 · Pencocokan: kandidat terbaik, bukan yang pertama kebetulan cocok */
/* ------------------------------------------------------------------ */
test('pencocokan: memilih kandidat dengan skor tertinggi, bukan kandidat pertama', () => {
    const items = [
        item('Jujutsu Kaisen 2nd Season', 'animeku'),
        item('Jujutsu Kaisen', 'animeku', 'jujutsu-kaisen-s1'),
        item('Jujutsu Kaisen 0', 'animeku', 'jujutsu-kaisen-0'),
    ];
    const hit = matchBackendItem(['Jujutsu Kaisen'], items);
    assert.equal(hit.slug, 'animeku~jujutsu-kaisen-s1', 'season 1 dipilih, bukan season 2');
});

test('pencocokan: hanya season lain tersedia → tidak ada padanan (bukan season yang salah)', () => {
    assert.equal(matchBackendItem(['Sousou no Frieren'], [item('Sousou no Frieren 2nd Season', 'animeku')]), null);
});

/* ------------------------------------------------------------------ */
/* 4 · findBackendMatches: pencarian bertahap khusus Sub Indo           */
/* ------------------------------------------------------------------ */
test('pencarian: judul persis di kedua situs Sub Indo ditemukan pada tahap pertama', async () => {
    const calls = stubSearch({
        'Sousou no Frieren': [
            item('Sousou No Frieren', 'animeku'),
            item('Sousou no Frieren', 'oploverz'),
            item('Frieren: Beyond Journey’s End', 'hianime'),
        ],
    });
    const matches = await findBackendMatches({ title: 'Sousou no Frieren', titleAlt: '' }, {});
    assert.deepEqual(matches.slice(0, 2).map((match) => match.source), ['animeku', 'oploverz'],
        'dua situs Sub Indo berada di urutan pertama');
    assert.equal(calls.length, 1, 'satu kata kunci sudah cukup');
    assert.ok(SUB_INDO_SOURCES.every((site) => matches.some((match) => match.source === site)));
});

test('pencarian: bila tahap pertama melewatkan Sub Indo, dicari ulang HANYA di dua situs itu', async () => {
    // Situs lain selalu menemukan judulnya; AnimeKu/Oploverz baru muncul saat pencarian
    // dibatasi ke dua situs itu (meniru situs yang menulis judul dengan gaya berbeda).
    const calls = stubSearchWith((q, only) => {
        if (only.length) return only.map((site) => item('Jujutsu Kaisen Season 2', site, `jujutsu-kaisen-season-2-${site}`));
        return [item('Jujutsu Kaisen 2nd Season', 'hianime'), item('Jujutsu Kaisen 2nd Season', 'anoboy')];
    });
    const matches = await findBackendMatches({ title: 'Jujutsu Kaisen 2nd Season', titleAlt: '' }, {});
    const sources = matches.map((match) => match.source);
    assert.deepEqual(sources.slice(0, 2), ['animeku', 'oploverz'], `Sub Indo harus paling depan: ${sources.join(',')}`);
    assert.ok(calls.every((url) => !url.includes('/episode/')), 'hanya pencarian, belum ada permintaan episode');
    const subIndoSearch = calls.filter((url) => url.includes('sources=animeku%2Coploverz'));
    assert.ok(subIndoSearch.length >= 1, 'pencarian cadangan dibatasi ke AnimeKu & Oploverz');
});

test('pencarian: kata kunci dari judul utama DAN judul alternatif sama-sama dicoba', async () => {
    const calls = stubSearch({
        'Sousou no Frieren': [],
        'Frieren at the Funeral': [item('Sousou no Frieren', 'animeku'), item('Sousou no Frieren', 'oploverz')],
    });
    const matches = await findBackendMatches({ title: 'Sousou no Frieren', titleAlt: 'Frieren at the Funeral' }, {});
    assert.deepEqual(matches.map((match) => match.source), ['animeku', 'oploverz']);
    assert.ok(calls.some((url) => url.includes('q=Frieren+at+the+Funeral')), 'judul alternatif ikut dicari');
});

test('pencarian: padanan lengkap dipakai ulang (tidak menembak jaringan lagi)', async () => {
    const calls = stubSearch({
        'Kimetsu no Yaiba': [item('Kimetsu no Yaiba', 'animeku'), item('Kimetsu no Yaiba', 'oploverz')],
    });
    await findBackendMatches({ title: 'Kimetsu no Yaiba', titleAlt: '' }, {});
    const afterFirst = calls.length;
    const again = await findBackendMatches({ title: 'Kimetsu no Yaiba', titleAlt: '' }, {});
    assert.equal(calls.length, afterFirst, 'cache sesi dipakai, tanpa permintaan baru');
    assert.deepEqual(again.map((match) => match.source), ['animeku', 'oploverz']);
});

test('pencarian: refresh (tombol "cari ulang") mengulang pencarian khusus Sub Indo', async () => {
    const calls = stubSearchWith((q, only) => only.map((site) => item('Judul Uji Refresh', site, `judul-uji-refresh-${site}`)));
    await findBackendMatches({ title: 'Judul Uji Refresh', titleAlt: '' }, {});
    const cacheHit = await findBackendMatches({ title: 'Judul Uji Refresh', titleAlt: '' }, {});
    assert.deepEqual(cacheHit.map((match) => match.source), ['animeku', 'oploverz'], 'padanan lengkap dipakai ulang');
    const before = calls.filter((url) => url.includes('sources=')).length;
    await findBackendMatches({ title: 'Judul Uji Refresh', titleAlt: '' }, { refresh: true });
    const after = calls.filter((url) => url.includes('sources=')).length;
    assert.ok(after > before, 'refresh harus mencari ulang ke AnimeKu/Oploverz tanpa cache');
});

test('pencarian: judul yang tidak ada di mana pun → hasil kosong, bukan error', async () => {
    stubSearch({});
    const matches = await findBackendMatches({ title: 'Judul Yang Tidak Ada Sama Sekali', titleAlt: '' }, {});
    assert.deepEqual(matches, []);
});

test('alur nonton: Sub Indo tetap muncul walau pencarian pertama melewatkannya', async () => {
    const { getEpisodeExtras } = await import('../../js/api/streams.js');
    const SERVERS = {
        animeku: [{ name: 'AnimeKu', url: 'https://animeku.example/embed/2', lang: 'id', subtitleEvidence: 'episode-page' }],
        oploverz: [{ name: 'Oploverz', url: 'https://oploverz.example/embed/2', lang: 'id', subtitleEvidence: 'episode-title' }],
        hianime: [{ name: 'HD-1', url: 'https://hianime.example/embed/2', lang: 'en' }],
        anoboy: [{ name: 'Anoboy', url: 'https://anoboy.example/embed/2', lang: '' }],
    };
    globalThis.fetch = async (raw) => {
        const url = new URL(String(raw), 'https://kazanime.test');
        if (url.pathname.endsWith('/api/anime/search')) {
            const only = (url.searchParams.get('sources') || '').split(',').filter(Boolean);
            const data = only.length
                ? only.map((site) => item('Jujutsu Kaisen Season 2', site, `jujutsu-kaisen-season-2-${site}`))
                : [item('Jujutsu Kaisen 2nd Season', 'hianime'), item('Jujutsu Kaisen 2nd Season', 'anoboy')];
            return json({ ok: true, source: 'stub', fallback: false, data });
        }
        const episode = url.pathname.match(/\/api\/anime\/([^/]+)\/episode\/\d+/);
        if (episode) {
            const site = decodeURIComponent(episode[1]).split('~')[0];
            return json({ ok: true, source: site, data: { servers: SERVERS[site] || [], downloads: [] } });
        }
        return json({ ok: true, source: 'stub', data: [] });
    };
    const extras = await getEpisodeExtras({ title: 'Jujutsu Kaisen 2nd Season', slug: null }, 1, {});
    const order = extras.servers.map((server) => String(server.source).replace(/^backend:/, ''));
    assert.deepEqual(order.slice(0, 2), ['animeku', 'oploverz'], `Sub Indo harus paling depan: ${order.join(',')}`);
    assert.equal(extras.servers.filter((server) => server.lang === 'id').length >= 2, true,
        'dua server Sub Indo (AnimeKu & Animeloverz) ikut terkirim ke panel server');
});

/* ------------------------------------------------------------------ */
/* 5 · Cache tidak boleh menyimpan hasil tanpa Sub Indo                 */
/* ------------------------------------------------------------------ */
test('cache: hasil pencarian tanpa AnimeKu tidak disimpan (agar Sub Indo cepat kembali)', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return json({
            ok: true,
            source: 'backend',
            data: [item('Judul Uji Cache Sub Indo', 'oploverz')],
            errors: [{ source: 'animeku', kind: 'http', message: 'AnimeKu sedang gangguan (HTTP 503).', httpStatus: 503 }],
        });
    };
    await searchBackend('Judul Uji Cache Sub Indo');
    await searchBackend('Judul Uji Cache Sub Indo');
    assert.equal(calls, 2, 'respons tanpa AnimeKu tidak boleh di-cache');
});

test('cache: hasil pencarian yang utuh tetap disimpan seperti biasa', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return json({
            ok: true,
            source: 'backend',
            data: [item('Judul Uji Cache Utuh', 'animeku'), item('Judul Uji Cache Utuh', 'oploverz')],
            errors: [{ source: 'animexin', kind: 'blocked', message: 'CAPTCHA' }],
        });
    };
    await searchBackend('Judul Uji Cache Utuh');
    const cached = await searchBackend('Judul Uji Cache Utuh');
    assert.equal(calls, 1, 'hasil utuh di-cache (galat situs lain tidak membatalkan cache)');
    assert.equal(cached.errors.length, 1, 'daftar sumber yang gagal tetap diteruskan ke pemanggil');
});

test('cache: noCache memaksa permintaan baru walau hasil lama tersimpan', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return json({ ok: true, source: 'backend', data: [item('Judul Uji NoCache', 'animeku')], errors: [] });
    };
    await searchBackend('Judul Uji NoCache');
    await searchBackend('Judul Uji NoCache', { noCache: true });
    assert.equal(calls, 2);
});

/* ------------------------------------------------------------------ */
/* 6 · Sisi backend: ?sources= & header cache                          */
/* ------------------------------------------------------------------ */
test('backend: readSourceList memvalidasi daftar situs', async () => {
    const { readSourceList } = await import('../routes/anime.js');
    assert.deepEqual(readSourceList(undefined), []);
    assert.deepEqual(readSourceList(''), []);
    assert.deepEqual(readSourceList('animeku,oploverz'), ['animeku', 'oploverz']);
    assert.deepEqual(readSourceList('animeku,animeku'), ['animeku'], 'duplikat dibuang');
    assert.throws(() => readSourceList('animeku,../etc'), (error) => error.code === 'BAD_REQUEST');
});

test('backend: registry.search hanya memakai situs yang diminta', async () => {
    const { createRegistry } = await import('../sources/index.js');
    const seen = [];
    const adapter = (id) => ({
        id,
        name: id,
        policy: {},
        async search(q) {
            seen.push(`${id}:${q}`);
            return [item(`${q} ${id}`, id)];
        },
    });
    const registry = createRegistry({ adapters: [adapter('animeku'), adapter('oploverz'), adapter('hianime')], metadata: null });
    const result = await registry.search('judul uji', {}, { sources: ['animeku', 'oploverz'] });
    assert.deepEqual(seen.sort(), ['animeku:judul uji', 'oploverz:judul uji'], 'situs lain tidak dipanggil');
    assert.equal(result.data.every((row) => ['animeku', 'oploverz'].includes(row.source)), true);
});

test('backend: /api/anime/search meneruskan sources & menolak daftar yang tidak valid', async () => {
    const { createApp } = await import('../app.js');
    const calls = [];
    const registry = {
        async search(q, ctx, opts = {}) {
            calls.push({ q, sources: opts.sources });
            return {
                source: 'animeku,oploverz',
                data: [item('Judul', 'animeku')],
                fallback: false,
                stale: false,
                errors: [],
            };
        },
    };
    const app = createApp({ registry, log: false, rateLimitPerMinute: 0, budgetMs: 5000 });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const ok = await realFetch(`${base}/api/anime/search?q=judul&sources=animeku,oploverz`);
        assert.equal(ok.status, 200);
        assert.deepEqual(calls[0].sources, ['animeku', 'oploverz']);

        const bad = await realFetch(`${base}/api/anime/search?q=judul&sources=../rahasia`);
        assert.equal(bad.status, 400, 'id situs aneh ditolak');
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('backend: hasil yang kehilangan situs Sub Indo tidak di-cache CDN', async () => {
    const { createApp } = await import('../app.js');
    const makeRegistry = (errors) => ({
        async search() {
            return { source: 'hianime', data: [item('Judul', 'hianime')], fallback: false, stale: false, errors };
        },
    });
    const withSubIndoError = () => makeRegistry([{ source: 'animeku', kind: 'http', message: 'AnimeKu 503', httpStatus: 503 }]);
    const withOtherError = () => makeRegistry([{ source: 'animexin', kind: 'blocked', message: 'CAPTCHA', httpStatus: 403 }]);
    const run = async (registry) => {
        const app = createApp({ registry, log: false, rateLimitPerMinute: 0, budgetMs: 5000 });
        const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/anime/search?q=judul`);
            return res.headers.get('cache-control') || '';
        } finally {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        }
    };
    assert.equal(await run(withSubIndoError()), 'no-store',
        'Sub Indo gagal → jangan simpan hasil di CDN/browser');
    assert.match(await run(withOtherError()), /s-maxage=\d+/, 'galat situs lain tidak membatalkan cache');
});

/* ------------------------------------------------------------------ */
/* 7 · Dokumentasi perilaku                                            */
/* ------------------------------------------------------------------ */
test('kode: pencocokan memakai skor judul, bukan pencarian judul pertama', () => {
    const streams = read('js', 'api', 'streams.js');
    assert.match(streams, /import \{[^}]*titleMatchScore[^}]*\} from '\.\/normalize\.js';/);
    assert.match(streams, /const score = titleMatchScore\(mine, candidates\);/);
    assert.match(streams, /return bestScore >= TITLE_MATCH_THRESHOLD \? best : null;/);
    assert.match(streams, /const MAX_FALLBACK_QUERIES = 3;/);
    assert.match(streams, /sources: \[\.\.\.SUB_INDO_SOURCES\]/);
    // Urutan akhir tetap Sub Indo lebih dulu.
    assert.match(streams, /return out\.sort\(\(a, b\) => subIndoRank\(a\.source\) - subIndoRank\(b\.source\)\);/);
});
