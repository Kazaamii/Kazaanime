import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ronde 6 (24 Okt 2026) — dua permintaan pengguna:
 *  1. "untuk genre home page yg bagian animeku dan oploverz buat seperti ini agar web tidak
 *     berat" → genre situs jadi satu <select> di kartu filter (bukan ±80 tombol), dan daftar
 *     genrenya baru diminta saat pilihan disentuh.
 *  2. "prioritaskan data anime streamingnya ke Sub Indo yg sudah tersedia di ke 2 web itu,
 *     tambahkan server dari animeku dan oploverz untuk opsi stream" → server AnimeKu &
 *     Oploverz dipakai lebih dulu dan selalu dicoba sebagai opsi tambahan.
 */

// js/api/http.js memasang listener `online` saat modul dimuat → stub window minimal.
globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
};

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const homeHtml = read('index.html');
const homeJs = read('js/home.js');
const homeCss = read('css/home.css');
const streamsJs = read('js/api/streams.js');
const watchJs = read('js/watch.js');

const json = (payload) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload),
});

const EPISODE_SERVERS = {
    hianime: [{ name: 'HD-1', url: 'https://hianime.example/embed/1', lang: 'en' }],
    animeku: [{ name: 'AnimeKu', url: 'https://animeku.example/embed/1', lang: 'id', subtitleEvidence: 'episode-page' }],
    oploverz: [{ name: 'Oploverz', url: 'https://oploverz.example/embed/1', lang: 'id', subtitleEvidence: 'episode-title' }],
    anoboy: [{ name: 'Anoboy', url: 'https://anoboy.example/embed/1', lang: '' }],
};

function installFetch() {
    const calls = [];
    globalThis.fetch = async (raw) => {
        const url = String(raw);
        calls.push(url);
        if (url.includes('/api/anime/search')) {
            return json({
                ok: true,
                source: 'backend',
                fallback: false,
                data: [
                    { title: 'Solo Leveling', slug: 'hianime~solo-leveling', source: 'hianime' },
                    { title: 'Solo Leveling', slug: 'anoboy~solo-leveling', source: 'anoboy' },
                    { title: 'Solo Leveling', slug: 'animeku~solo-leveling', source: 'animeku' },
                    { title: 'Solo Leveling', slug: 'oploverz~solo-leveling', source: 'oploverz' },
                ],
            });
        }
        const episode = url.match(/\/api\/anime\/([^/]+)\/episode\/\d+/);
        if (episode) {
            const site = decodeURIComponent(episode[1]).split('~')[0];
            return json({
                ok: true,
                source: site,
                data: { servers: EPISODE_SERVERS[site] || [], downloads: [] },
            });
        }
        return json({ ok: true, source: 'backend', data: [] });
    };
    return calls;
}

test('genre situs: pindah ke halaman katalog saja (24 Okt 2026, putaran 8)', () => {
    // Putaran 6 membuat <select> di beranda; putaran 8 memindahkannya sepenuhnya ke
    // katalog.html (permintaan pengguna) sehingga beranda hanya berisi chip AniList.
    assert.doesNotMatch(homeHtml, /id="genreSite"/);
    assert.doesNotMatch(homeHtml, /genre-filter--site/);
    assert.doesNotMatch(homeJs, /genreSite|SITE_GENRE|ensureSiteGenres|selectSiteGenre|siteGenres/);
    assert.doesNotMatch(homeJs, /getSourceGenres/);
    assert.match(read('katalog.html'), /<select id="katalogGenre"/);
    assert.match(read('js/katalog.js'), /function renderGenre\(\)/);
});

test('server Sub Indo: AnimeKu & Oploverz selalu dicoba dan didahulukan', async () => {
    const calls = installFetch();
    const { SUB_INDO_SOURCES, findBackendMatches, getEpisodeExtras } = await import('../../js/api/streams.js');

    assert.deepEqual([...SUB_INDO_SOURCES], ['animeku', 'oploverz']);

    // Padanan dari pencarian: AnimeKu & Oploverz di urutan depan walau backend mengirim
    // hianime/anoboy lebih dulu.
    const matches = await findBackendMatches({ title: 'Solo Leveling', slug: null }, {});
    assert.deepEqual(matches.map((match) => match.source).slice(0, 2), ['animeku', 'oploverz'],
        'dua situs Sub Indo berada di urutan pertama');

    // Tanpa slug: server ketiga situs digabung, Sub Indo di depan.
    const extras = await getEpisodeExtras({ title: 'Solo Leveling', slug: null }, 1, {});
    const order = extras.servers.map((server) => String(server.source).replace(/^backend:/, ''));
    assert.deepEqual(order, ['animeku', 'oploverz', 'hianime', 'anoboy'],
        'server AnimeKu → Oploverz → Sub Eng → bahasa tak diketahui');
    assert.equal(extras.servers[0].lang, 'id');

    assert.ok(calls.some((url) => url.includes('animeku')), 'episode AnimeKu diambil');
    assert.ok(calls.some((url) => url.includes('oploverz')), 'episode Oploverz diambil');
});

test('server Sub Indo: sumber asal ber-Sub Indo lain tetap menambahkan AnimeKu & Oploverz', async () => {
    installFetch();
    const { getEpisodeExtras } = await import('../../js/api/streams.js');

    // Anime dibuka dari anoboy (bukan situs Sub Indo utama, server tanpa bukti): kedua situs
    // Sub Indo tetap diambil sebagai opsi, dan tetap berada di depan.
    const extras = await getEpisodeExtras(
        { title: 'Solo Leveling', slug: 'anoboy~solo-leveling' },
        1,
        { slug: 'anoboy~solo-leveling' },
    );
    const order = extras.servers.map((server) => String(server.source).replace(/^backend:/, ''));
    assert.ok(order.includes('animeku') && order.includes('oploverz'), `Sub Indo ikut: ${order.join(',')}`);
    assert.deepEqual(order.slice(0, 2), ['animeku', 'oploverz'], 'Sub Indo tetap paling depan');
    assert.equal(order.at(-1), 'anoboy', 'sumber asal tetap tersedia sebagai opsi terakhir');
});

test('server Sub Indo: sumber asal sudah ber-Sub Indo → cukup tambah situs Sub Indo lain', async () => {
    const called = [];
    globalThis.fetch = async (raw) => {
        const url = String(raw);
        called.push(url);
        if (url.includes('/api/anime/search')) {
            return json({
                ok: true, source: 'backend',
                data: [
                    { title: 'Solo Leveling', slug: 'animeku~solo-leveling', source: 'animeku' },
                    { title: 'Solo Leveling', slug: 'oploverz~solo-leveling', source: 'oploverz' },
                    { title: 'Solo Leveling', slug: 'hianime~solo-leveling', source: 'hianime' },
                ],
            });
        }
        const episode = url.match(/\/api\/anime\/([^/]+)\/episode\/\d+/);
        if (episode) {
            const site = decodeURIComponent(episode[1]).split('~')[0];
            return json({ ok: true, source: site, data: { servers: EPISODE_SERVERS[site] || [], downloads: [] } });
        }
        return json({ ok: true, source: 'backend', data: [] });
    };
    const { getEpisodeExtras } = await import('../../js/api/streams.js');
    const extras = await getEpisodeExtras(
        { title: 'Solo Leveling', slug: 'animeku~solo-leveling' },
        1,
        { slug: 'animeku~solo-leveling' },
    );
    const sources = extras.servers.map((server) => String(server.source).replace(/^backend:/, ''));
    assert.deepEqual(sources, ['animeku', 'oploverz'], 'hanya situs Sub Indo yang ditambahkan');
    assert.equal(extras.servers[0].lang, 'id');
    assert.ok(!called.some((url) => url.includes('hianime~solo-leveling/episode')), 'situs lain tidak ikut diminta');
});

test('halaman nonton: urutan tombol server menaruh Sub Indo lebih dulu', () => {
    assert.match(watchJs, /SUB_INDO_SOURCES, withProviderServers/);
    assert.match(watchJs, /const isSubIndoSource = \(server\) => SUB_INDO_SOURCES\.includes\(siteOf\(server\)\);/);
    assert.match(watchJs, /const subIndo = firstPerSite\(backendServers\.filter\(isSubIndoSource\)\);/,
        'tepat dua tombol Sub Indo (satu per situs)');
    // Putaran 16: slot Sub Indo diisi placeholder bila sumber tidak terjangkau — urutan tidak berubah.
    assert.match(watchJs, /return numbered\(\[\.\.\.fillSubIndoServers\(subIndo\), \.\.\.multi, \.\.\.local, \.\.\.otherFallback, \.\.\.english\]\)/,
        'Sub Indo → Multi Sub → bahasa lain → cadangan → Sub Eng');
    // Server statis ber-Sub Eng juga di urutan akhir (bukan terselip di blok cadangan).
    assert.match(watchJs, /const otherFallback = fallback\.filter\(\(s\) => s\.lang !== 'multi' && s\.lang !== 'en'\);/);
    assert.match(watchJs, /const english = \[\.\.\.rest\.filter\(\(s\) => s\.lang === 'en'\), \.\.\.fallback\.filter\(\(s\) => s\.lang === 'en'\)\];/);
    assert.match(read('js/api/index.js'), /export \{ listStreamServers, getEpisodeExtras, withProviderServers, SUB_INDO_SOURCES \}/);
});

test('server Sub Indo: urutan memakai peringkat sumber, bukan asal situs', () => {
    assert.match(streamsJs, /const subIndoRank = \(source\) => \{/);
    assert.match(streamsJs, /return out\.sort\(\(a, b\) => subIndoRank\(a\.source\) - subIndoRank\(b\.source\)\);/);
    assert.match(streamsJs, /\.sort\(\(a, b\) => \(subIndoRank\(a\.server\.source\) - subIndoRank\(b\.server\.source\)\)/);
    assert.match(streamsJs, /const needsAllSources = !own \|\| !hasIndonesianServer\(primary\);/);
    assert.match(streamsJs, /alternative.*match\.source\) < SUB_INDO_SOURCES\.length/s,
        'sumber asal yang sudah ada tetap menambahkan kedua situs Sub Indo');
});
