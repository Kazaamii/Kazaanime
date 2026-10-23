import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ronde 4 (24 Okt 2026) — tiga keluhan pengguna:
 *  1. Deretan genre AnimeKu/Oploverz terlalu panjang → dipindah ke tombol menu.
 *  2. Donghua harus ada di AnimeKu DAN Oploverz, bukan AniList saja.
 *  3. Panel Sub Indo tidak muncul di ponsel → status jelas, tombol muat ulang,
 *     dan fallback cache lokal saat feed gagal.
 *
 * Test ini menjaga markup + perilaku yang bisa diverifikasi tanpa browser.
 * Perilaku DOM lengkap diperiksa manual lewat smoke happy-dom saat pengembangan.
 */
const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const homeHtml = read('index.html');
const homeJs = read('js/home.js');
const homeCss = read('css/home.css');
const componentsCss = read('css/components.css');
const katalogJs = read('js/katalog.js');

test('genre situs: satu <select> ringkas, bukan dinding chip (24 Okt 2026)', () => {
    // Ronde 6 mengganti tombol menu (yang masih membuat ±80 chip saat dibuka) dengan
    // satu pilihan di kartu filter, seperti kontrol Tahun/Musim/Urutkan.
    assert.match(homeHtml, /<label class="genre-filter genre-filter--site" for="genreSite">/);
    assert.match(homeHtml, /<select id="genreSite"[^>]*aria-label="Genre dari AnimeKu atau Oploverz"/);
    assert.doesNotMatch(homeHtml, /id="genreMenuBtn"/, 'tombol menu genre situs sudah tidak dipakai');
    assert.doesNotMatch(homeHtml, /id="genreMenu"/);
    // Chip AniList tetap langsung terlihat (bukan ±80 tombol genre situs).
    assert.match(homeHtml, /id="genreTags"[^>]*role="toolbar"/);

    assert.match(homeJs, /const genreSite = \$\('#genreSite'\)/);
    assert.match(homeJs, /function renderSiteGenreOptions\(\)/);
    assert.match(homeJs, /<optgroup label="\$\{source\.name\}">/, 'genre dikelompokkan per situs di dalam select');
    assert.match(homeJs, /value="\$\{source\.id\}:\$\{genre\.id\}"/, 'nilai pilihan = sumber:token');
    assert.match(homeJs, /async function ensureSiteGenres\(\)/);
    assert.match(homeJs, /const SITE_GENRE_CACHE_KEY = 'kz:site-genres'/);
    // Daftar genre situs tidak diminta saat halaman dibuka (beranda ringan).
    assert.doesNotMatch(homeJs, /^void loadSiteGenres\(\);$/m, 'tidak ada permintaan genre situs saat memuat beranda');
    assert.match(homeJs, /genreSite\?\.addEventListener\('change', handleSiteGenreChange\)/);

    assert.match(homeCss, /\.genre-filter--site select\{/, 'select genre situs punya gaya sendiri');
    assert.doesNotMatch(homeCss, /\.genre-menu-btn\{/, 'CSS menu lama dibuang');
});

test('genre situs: memilih genre menampilkan hasil dengan filter tahun/musim', () => {
    assert.match(homeJs, /function handleSiteGenreChange\(\)/);
    assert.match(homeJs, /const \[source, \.\.\.rest\] = value\.split\(':'\)/);
    assert.match(homeJs, /selectSiteGenre\(source, id, label\)/);
    assert.match(homeJs, /katalogUrl\(\{\s*source, genre: id, year: genreState\.year, season: genreState\.season,\s*\}\)/s);
    assert.match(homeJs, /year: genreState\.year,\s*season: genreState\.season,/s, 'filter tahun & musim diteruskan ke browse');
});

test('donghua beranda: panel AnimeKu & Oploverz di atas grid metadata', () => {
    assert.match(homeHtml, /id="donghuaSites"/);
    assert.match(homeHtml, /id="donghuaNote"/);
    const sites = homeHtml.indexOf('id="donghuaSites"');
    const grid = homeHtml.indexOf('id="donghuaGrid"');
    assert.ok(sites > -1 && grid > sites, 'panel situs tampil sebelum grid metadata AniList');

    assert.match(homeJs, /const DONGHUA_SITE_IDS = \['animeku', 'oploverz'\]/);
    // Ronde 5: permintaan panel donghua memakai percobaan ulang otomatis (refresh pada percobaan kedua).
    assert.match(homeJs, /getSourceBrowse\(id, \{ filter: 'donghua', refresh: refresh \|\| attempt > 1 \}\)/);
    assert.match(homeJs, /katalogUrl\(\{ source: source\.id, filter: 'donghua' \}\)/);
    assert.match(homeJs, /whenVisible\(\$\('#donghua'\), loadDonghuaSites\)/, 'panel donghua situs dimuat saat section mendekati layar');
    assert.match(homeJs, /data-donghua-source/);
    assert.doesNotMatch(homeJs, /DONGHUA_SITE_IDS = \['animeku'\]/, 'Oploverz tidak boleh tertinggal');

    // Sumber yang gagal sebagian (metadata mati) tidak boleh tampak seperti "situs kosong".
    assert.match(read('js/api/sources.js'), /error: fromBackendError\(Array\.isArray\(json\.errors\) \? json\.errors\[0\] : null\)/);
    assert.match(homeJs, /panel\.error \? `\$\{panel\.name\} gagal dimuat`/);

    assert.match(homeCss, /\.donghua-sites\{/);
    assert.match(homeCss, /\.donghua-note\{/);
    // Katalog sudah menyediakan bagian donghua untuk kedua situs (dijaga juga oleh katalog-ui.test.js).
    assert.match(katalogJs, /label: 'Donghua di AnimeKu'/);
    assert.match(katalogJs, /label: 'Donghua di Oploverz'/);
});

test('Sub Indo ponsel: tombol muat ulang + status terlihat', () => {
    assert.match(homeHtml, /id="subIndoRefresh"[^>]*aria-label="Muat ulang daftar Sub Indo"/);
    assert.match(homeHtml, /id="subIndoRefresh"[\s\S]{0,400}data-icon="refresh-cw"/);
    assert.match(homeJs, /const subIndoRefreshBtn = \$\('#subIndoRefresh'\)/);
    assert.match(homeJs, /async function refreshSubIndoSection\(\)/);
    assert.match(homeJs, /subIndoRefreshBtn\?\.addEventListener\('click'/);
    assert.match(homeJs, /subIndoStatus\.textContent = 'Memuat katalog AnimeKu & Oploverz…'/, 'status selalu memberi umpan balik');

    assert.match(componentsCss, /\.subindo-refresh\{/);
    assert.match(componentsCss, /\.subindo-refresh\.is-busy svg\{animation:spin/);
    // Regresi: tidak ada aturan yang menyembunyikan wadah/panel Sub Indo.
    for (const css of [componentsCss, homeCss]) {
        assert.doesNotMatch(css, /\.subindo-sources[^{]*\{[^}]*display:\s*none/, 'wadah panel Sub Indo tidak boleh disembunyikan');
        assert.doesNotMatch(css, /\.subindo-source[^-][^{]*\{[^}]*display:\s*none/, 'panel Sub Indo tidak boleh disembunyikan');
    }
});

test('Sub Indo: hasil sukses di-cache, feed gagal memakai cache (bukan kotak kosong)', () => {
    assert.match(homeJs, /const SUB_INDO_CACHE_KEY = 'kz:subindo-last'/);
    assert.match(homeJs, /function readSubIndoCache\(\)/);
    assert.match(homeJs, /function writeSubIndoCache\(sections\)/);
    assert.match(homeJs, /writeSubIndoCache\(sections\);/);
    assert.match(homeJs, /const cached = readSubIndoCache\(\);/);
    assert.match(homeJs, /subIndoState = \{ sections \};\s*renderSubIndoSources\(sections\);\s*const when = cached\.savedAt/s,
        'cache dirender sebagai panel normal bertanda stale');
    assert.match(homeJs, /Menampilkan data tersimpan/);
    // Jaringan ponsel: satu percobaan ulang otomatis, lalu cache/pesan error.
    assert.match(homeJs, /if \(retry && \(error\?\.kind === 'timeout' \|\| error\?\.kind === 'network'\)\)/);
    assert.match(homeJs, /Jaringan lambat — mencoba sekali lagi…/);
});
