import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Putaran 8 (24 Okt 2026) — empat permintaan pengguna:
 *  1. "hapus Genre dari Animeloverz di bagian home page dan Animeku, muncul hanya di
 *     halaman katalog saja" → beranda tanpa pemilih genre situs.
 *  2. "bug Scraper backend offline tapi pas di test lagi ... Online" → status backend
 *     tidak boleh "nyangkut" offline setelah satu kegagalan sementara.
 *  3. "benar benar memprioritaskan untuk sub indo dlu" + "pilihan server sub indo ...
 *     di buat 2 dan tuliskan dari web Animeloverz dan animeku" → dua tombol server
 *     bernama situs, di urutan paling depan.
 *  4. "hapus Tombol Pop Up block ... tambahkan pemutar eksternal ... iklan dari host
 *     streaming ... tidak berusaha membuka tab baru" → lihat player-popup-guard.test.js.
 */

// js/api/http.js memasang listener `online` saat modul dimuat → stub minimal.
globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
};

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const homeHtml = read('index.html');
const homeJs = read('js/home.js');
const katalogHtml = read('katalog.html');
const katalogJs = read('js/katalog.js');
const watchJs = read('js/watch.js');
const configJs = read('js/config.js');
const apiIndexJs = read('js/api/index.js');
const sourcesJs = read('js/api/sources.js');

const json = (payload) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload),
});

test('beranda: genre AnimeKu/Animeloverz pindah ke halaman katalog', () => {
    assert.doesNotMatch(homeHtml, /id="genreSite"/);
    assert.doesNotMatch(homeHtml, /genre-filter--site/);
    assert.doesNotMatch(homeJs, /genreSite|SITE_GENRE|ensureSiteGenres|selectSiteGenre|siteGenres/);
    assert.doesNotMatch(homeJs, /getSourceGenres/);

    // Katalog tetap punya pemilih genre per sumber + tahun/musim.
    assert.match(katalogHtml, /<div class="katalog-genre" id="katalogGenreWrap" hidden>/);
    assert.match(katalogHtml, /<select id="katalogGenre" class="katalog-genre-select"><\/select>/);
    assert.match(katalogJs, /function renderGenre\(\)/);
    assert.match(katalogJs, /genreSelect\.addEventListener\('change', \(\) => switchGenre\(genreSelect\.value\)\)/);
});

test('status backend: sumber offline diuji ulang, bukan hanya yang belum dikenal', () => {
    assert.match(apiIndexJs, /health\[s\]\.state === 'unknown'[\s\S]{0,60}health\[s\]\.state === 'offline'/,
        'sumber offline ikut di-ping ulang');
    assert.match(apiIndexJs, /Sekarang sumber offline ikut diuji ulang lewat ping[\s\S]{0,160}nyangkut/);
    // Ping backend lebih sabar terhadap cold start + satu percobaan ulang.
    assert.match(sourcesJs, /timeout: 15000, force: true/);
    assert.match(sourcesJs, /withAutoRetry\(\s*\n\s*\(\) => fetchJSON\(`\$\{base\}\/api\/health`/);
    assert.match(sourcesJs, /\{ attempts: 2, delay: 600 \}/);
});

test('status backend: satu kegagalan sementara pulih setelah diperiksa ulang', async () => {
    const { checkApiSources, getAllHealth } = await import('../../js/api/index.js');
    const { getLatest } = await import('../../js/api/sources.js');

    const originalFetch = globalThis.fetch;
    try {
        // 1) Backend gagal (jaringan putus) → status offline.
        globalThis.fetch = async () => {
            throw new TypeError('Failed to fetch');
        };
        await assert.rejects(() => getLatest());
        assert.equal(getAllHealth().backend.state, 'offline', 'gagal sekali → offline');

        // 2) Backend hidup lagi. checkApiSources() memperbaiki statusnya TANPA harus
        //    menekan tombol status di footer (bug yang dilaporkan pengguna).
        let healthCalls = 0;
        globalThis.fetch = async (url) => {
            if (String(url).includes('/api/health')) {
                healthCalls += 1;
                return json({ ok: true, uptime: 1 });
            }
            return json({ ok: true, data: [] });
        };
        const health = await checkApiSources();
        assert.ok(healthCalls >= 1, 'ping /api/health dijalankan');
        assert.equal(health.backend.state, 'online');
        assert.equal(getAllHealth().backend.state, 'online');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('status backend: ping yang timeout dicoba ulang sebelum dinyatakan offline', () => {
    // withAutoRetry mengulang timeout/jaringan/5xx; 403/429/challenge tidak pernah diulang.
    assert.match(sourcesJs, /Sekarang batasnya 15 dtk DAN kegagalan sementara \(timeout\/jaringan\/5xx\) dicoba satu/);
    assert.match(sourcesJs, /403\/429\/challenge tetap tidak pernah diulang/);
});

test('server Sub Indo: dua tombol bernama AnimeKu & Animeloverz', () => {
    assert.match(configJs, /siteLabels: Object\.freeze\(\{ animeku: 'AnimeKu', oploverz: 'Animeloverz' \}\)/);
    assert.match(watchJs, /const siteOf = \(server\) => String\(server\?\.source \|\| ''\)\.replace\(\/\^backend:\/, ''\)\.split\('~'\)\[0\]\.toLowerCase\(\);/);
    assert.match(watchJs, /const site = isSubIndoSource\(s\) \? PLAYER\.siteLabels\[siteOf\(s\)\] : '';/);
    assert.match(watchJs, /const name = site \|\| `Server \$\{counter\}`;/);
    assert.match(watchJs, /function firstPerSite\(list\) \{/);
    assert.match(watchJs, /const subIndo = firstPerSite\(backendServers\.filter\(isSubIndoSource\)\);/);
    // Putaran 16: dua slot itu diisi placeholder saat sumber mati, tetap paling depan.
    assert.match(watchJs, /return numbered\(\[\.\.\.fillSubIndoServers\(subIndo\), \.\.\.multi, \.\.\.local, \.\.\.otherFallback, \.\.\.english, \.\.\.dub\]\)/,
        'Sub Indo (AnimeKu & Animeloverz) tetap paling depan');
    assert.match(watchJs, /site \? `diputar langsung dari \$\{site\}` : ''/);
});
