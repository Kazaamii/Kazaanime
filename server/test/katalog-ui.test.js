import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAnimeku } from '../sources/animeku.js';
import { createOploverz } from '../sources/oploverz.js';
import { fakeClientFactory } from './helpers.js';

/**
 * Halaman "Jelajah" (katalog.html) menampilkan katalog per bagian dari AnimeKu & Oploverz.
 * Test ini menjaga kontraknya: urutan bagian = urutan filter backend, ringkas 6 kartu dengan
 * tombol Expand, state tersimpan di URL, dan tidak ada klaim Sub Indo per kartu.
 */
const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const pageHtml = read('katalog.html');
const pageJs = read('js/katalog.js');
const sourcesJs = read('js/api/sources.js');
const routesJs = read('js/routes.js');
const configJs = read('js/config.js');
const homeJs = read('js/home.js');
const css = read('css/katalog.css');

/** Id bagian dari literal SOURCES di katalog.js. */
function sectionIds(sourceId) {
    const start = pageJs.indexOf(`id: '${sourceId}'`);
    assert.notEqual(start, -1, `sumber ${sourceId} harus ada di katalog.js`);
    const block = pageJs.slice(start);
    const list = block.slice(block.indexOf('sections: ['), block.indexOf('],'));
    return [...list.matchAll(/\{ id: '([^']+)'/g)].map((match) => match[1]);
}

const stubAdapter = (create, name) => create({
    network: null,
    createClient: fakeClientFactory({}).createClient,
    baseUrl: `https://${name}.test`,
});

test('katalog.html: halaman mandiri dengan wadah bagian + pemilih genre', () => {
    assert.match(pageHtml, /<body data-page="katalog">/);
    assert.match(pageHtml, /<div id="app-navbar"><\/div>/);
    assert.match(pageHtml, /<div id="app-footer"><\/div>/);
    assert.match(pageHtml, /<div class="katalog-sections" id="katalogSections" aria-busy="true">/);
    assert.match(pageHtml, /id="katalogSourceTabs"[^>]*role="tablist"/);
    assert.match(pageHtml, /data-source="animeku"/);
    assert.match(pageHtml, /data-source="oploverz"/);
    assert.match(pageHtml, /id="katalogGenre"[^>]*>/);
    assert.match(pageHtml, /css\/katalog\.css/);
    assert.match(pageHtml, /js\/katalog\.js/);
    assert.doesNotMatch(pageHtml, /id="katalogGrid"/, 'grid tunggal diganti blok per bagian');
});

test('katalog.js: hanya AnimeKu & Oploverz, tanpa empat sumber yang dihapus', () => {
    const sources = pageJs.match(/const SOURCES = Object\.freeze\(\[([\s\S]*?)\n\]\);/);
    assert.ok(sources, 'daftar sumber harus eksplisit');
    assert.match(sources[1], /id: 'animeku'/);
    assert.match(sources[1], /id: 'oploverz'/);
    assert.doesNotMatch(sources[1], /samehadaku|otakudesu|kuramanime|sakunime/);
});

test('katalog.js: urutan bagian AnimeKu sesuai permintaan', () => {
    assert.deepEqual(sectionIds('animeku'), ['baru', 'populer', 'favorit', 'coming', 'selesai']);
    assert.deepEqual(sectionIds('oploverz'), ['update', 'popular', 'rating', 'ongoing', 'completed', 'movie']);
});

test('katalog.js: setiap bagian = filter yang benar-benar ada di adapter', () => {
    const animekuFilters = stubAdapter(createAnimeku, 'animeku').browseOptions().filters.map((f) => f.id);
    const oploverzFilters = stubAdapter(createOploverz, 'oploverz').browseOptions().filters.map((f) => f.id);
    assert.deepEqual(animekuFilters.slice(0, 5), sectionIds('animeku'), 'lima bagian pertama = urutan filter AnimeKu');
    assert.deepEqual(oploverzFilters, sectionIds('oploverz'), 'bagian Oploverz = urutan filter situs');
    assert.equal(stubAdapter(createAnimeku, 'animeku').browseOptions().genres.length, 0,
        'AnimeKu memang tanpa arsip genre → pemilih genre disembunyikan');
});

test('katalog.js: ringkas 6 kartu, Expand membuka sisanya, Muat Lagi per bagian', () => {
    assert.match(pageJs, /const PREVIEW = 6;/);
    assert.match(pageJs, /runtime\.expanded \? runtime\.items : runtime\.items\.slice\(0, PREVIEW\)/);
    assert.match(pageJs, /runtime\.expanded = !runtime\.expanded;/);
    assert.match(pageJs, /'Ringkas'/);
    assert.match(pageJs, /data-expand aria-expanded="false" hidden>Expand</);
    assert.match(pageJs, /filter: runtime\.def\.id/);
    assert.match(pageJs, /refresh,/, 'Coba Lagi melewati cache/circuit frontend');
    assert.match(pageJs, /loadSection\(runtime, \{ reset: true, refresh: true \}\)/);
});

test('kartu katalog memakai varian "catalog": nomor episode, bukan klaim "Sub Indo"', () => {
    assert.match(pageJs, /variant: 'catalog'/);
    const cardJs = read('js/ui/card.js');
    assert.match(cardJs, /variant === 'catalog'/);
    assert.match(cardJs, /quality = anime\.latestEpisode != null \? `Ep \$\{anime\.latestEpisode\}` : 'Katalog'/);
    // Klaim Sub Indo tetap eksklusif untuk panel beranda yang sudah memverifikasi episode.
    assert.match(cardJs, /if \(variant === 'source'\) quality = 'Sub Indo';/);
});

test('katalog.js: bagian dimuat saat mendekati layar (bukan enam request sekaligus)', () => {
    assert.match(pageJs, /new IntersectionObserver\(/);
    assert.match(pageJs, /rootMargin: '400px 0px'/);
    assert.match(pageJs, /if \(runtime && !runtime\.loaded && !runtime\.loading\) loadSection\(runtime\)/);
    assert.match(pageJs, /if \(state\.sections\[0\]\) loadSection\(state\.sections\[0\]\)/);
});

test('katalog.js: state sumber & genre disimpan di URL', () => {
    assert.match(pageJs, /history\.replaceState/);
    assert.match(pageJs, /q\.set\('source', state\.source\)/);
    assert.match(pageJs, /q\.set\('genre', state\.genre\)/);
    assert.match(pageJs, /new URLSearchParams\(window\.location\.search\)/);
    assert.match(pageJs, /episodeOf: \(\) => 'latest'/, 'kartu katalog membuka episode terbaru');
});

test('katalog.js: genre hanya muncul bila backend mengirim daftarnya', () => {
    assert.match(pageJs, /if \(res\.genres\.length && !state\.genres\.length\)/);
    assert.match(pageJs, /if \(!state\.genres\.length\) \{/);
    assert.match(pageJs, /genreWrap\.hidden = true/);
});

test('api/sources.js: getSourceBrowse memanggil /api/anime/browse dengan parameter aman', () => {
    assert.match(sourcesJs, /export function getSourceBrowse\(source/);
    assert.match(sourcesJs, /new URLSearchParams\(\{ source: String\(source \|\| ''\) \}\)/);
    assert.match(sourcesJs, /q\.set\('filter', filter\)/);
    assert.match(sourcesJs, /q\.set\('genre', genre\)/);
    assert.match(sourcesJs, /call\(`\/browse\?\$\{q\.toString\(\)\}`/);
    assert.match(sourcesJs, /fromBackend\(item, sourceId\)/);
});

test('navigasi: menu "Jelajah" menuju katalog.html dan route-nya tersedia', () => {
    assert.match(configJs, /\{ label: 'Jelajah',\s+page: 'katalog\.html' \}/);
    assert.match(routesJs, /katalog: 'katalog\.html'/);
    assert.match(routesJs, /export function katalogUrl\(/);
    assert.match(routesJs, /return `\$\{PAGES\.katalog\}\?\$\{p\.toString\(\)\}`/);
});

test('panel Sub Indo menautkan "Lihat semua" hanya untuk sumber berhalaman daftar', () => {
    assert.match(homeJs, /import \{[^}]*katalogUrl[^}]*\} from '\.\/routes\.js'/);
    assert.match(homeJs, /\$\{source\.browse \? html`<a class="subindo-source-more" href="\$\{katalogUrl\(\{ source: source\.id \}\)\}">Lihat semua<\/a>` : ''\}/);
});

test('css/katalog.css: blok bagian + pemilih genre memakai variabel tema', () => {
    assert.match(css, /\.katalog-sections\{/);
    assert.match(css, /\.katalog-expand\{/);
    assert.match(css, /\.katalog-genre-select\{/);
    assert.match(css, /background:var\(--bg-card\)/);
    assert.match(css, /\.katalog-note\.is-error\{/);
    assert.match(css, /\.katalog-block-head\{/);
    assert.match(css, /\.katalog-block-hint\{/);
    assert.doesNotMatch(css, /#0[0-9a-f]{5}|#1[0-9a-f]{5}/i, 'warna latar harus memakai variabel tema');
});
