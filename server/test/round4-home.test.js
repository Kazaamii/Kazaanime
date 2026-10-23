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

test('genre situs: tombol menu, bukan dinding chip di beranda', () => {
    assert.match(homeHtml, /id="genreMenuBtn"[^>]*aria-expanded="false"[^>]*aria-controls="genreMenu"/);
    assert.match(homeHtml, /id="genreMenu"[^>]*hidden/);
    assert.match(homeHtml, /id="genreMenuBody"/);
    assert.match(homeHtml, /id="genreMenuSearch"[^>]*type="search"|type="search"[^>]*id="genreMenuSearch"/);
    assert.match(homeHtml, /id="genreMenuClose"/);
    assert.match(homeHtml, /id="genreMenuCount"/);
    // Chip AniList tetap langsung terlihat (18 tombol, bukan 70).
    assert.match(homeHtml, /id="genreTags"[^>]*role="toolbar"/);

    assert.match(homeJs, /genreMenuBody\.querySelector\('\[data-site-genres\]'\)\?\.remove\(\)/, 'pembersihan tetap memakai kunci data-site-genres');
    assert.match(homeJs, /genreMenuBody\.insertAdjacentHTML\('beforeend', String\(html`<div class="genre-group-list" data-site-genres>/);
    assert.match(homeJs, /function setGenreMenuOpen\(open\)/);
    assert.match(homeJs, /genreMenu\.hidden = !open/);
    assert.match(homeJs, /function filterGenreMenu\(term\)/);
    assert.match(homeJs, /delegate\(genreMenuBody, 'click', '\.genre-tag'/);
    assert.match(homeJs, /if \(event\.key !== 'Escape' \|\| !genreMenu \|\| genreMenu\.hidden\) return;/);
    assert.doesNotMatch(homeJs, /genreBox\.insertAdjacentHTML\('beforeend', String\(html`<div class="genre-group-list" data-site-genres>/,
        'chip situs tidak boleh lagi disisipkan ke #genreTags');

    assert.match(homeCss, /\.genre-menu-btn\{/);
    assert.match(homeCss, /\.genre-menu-btn\[aria-expanded="true"\]/);
    assert.match(homeCss, /\.genre-menu\[hidden\]\{display:none\}/);
    assert.match(homeCss, /\.genre-menu-body\{[^}]*max-height/);
    assert.match(homeCss, /\.genre-tag\[hidden\]\{display:none\}/);
    assert.match(homeCss, /\.genre-menu-body \.genre-group\[hidden\]\{display:none\}/);
});

test('genre situs: memilih genre menutup menu dan hasil memakai filter tahun/musim', () => {
    assert.match(homeJs, /delegate\(genreMenuBody, 'click', '\.genre-tag', \(_e, tag\) => \{\s*setGenreMenuOpen\(false\);\s*handleGenreTag\(tag\);/s);
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
    assert.match(homeJs, /getSourceBrowse\(id, \{ filter: 'donghua' \}\)/);
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
