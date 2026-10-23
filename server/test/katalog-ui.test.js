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
 * tautan **Lihat Semua** (bukan Expand/Ringkas), state tersimpan di URL, dan tidak ada klaim
 * Sub Indo per kartu.
 */
const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const pageHtml = read('katalog.html');
const pageJs = read('js/katalog.js');
const sourcesJs = read('js/api/sources.js');
const routesJs = read('js/routes.js');
const configJs = read('js/config.js');
const homeJs = read('js/home.js');
const homeHtml = read('index.html');
const css = read('css/katalog.css');
const homeCss = read('css/home.css');

/** Id bagian dari literal SOURCES di katalog.js. */
function sectionIds(sourceId) {
    const start = pageJs.search(new RegExp(`\\n {8}id: '${sourceId}',`));
    assert.notEqual(start, -1, `sumber ${sourceId} harus ada di katalog.js`);
    const block = pageJs.slice(start);
    const list = block.slice(block.indexOf('sections: ['), block.indexOf('],'));
    return [...list.matchAll(/\{\s*id: '([^']+)'/g)].map((match) => match[1]);
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
    assert.match(pageHtml, /data-source="donghua"/, 'tab Donghua (feed Kazanime, bukan kategori Oploverz)');
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
    assert.deepEqual(sectionIds('animeku'), ['baru', 'populer', 'favorit', 'coming', 'selesai', 'donghua'],
        'lima bagian tetap sesuai permintaan; Donghua ditambahkan sebagai bagian keenam');
    assert.deepEqual(sectionIds('oploverz'), ['update', 'popular', 'rating', 'ongoing', 'completed', 'movie', 'donghua'],
        'enam bagian situs + Donghua di Oploverz (24 Okt 2026)');
});

test('katalog.js: bagian berbasis situs = filter yang benar-benar ada di adapter', () => {
    const animekuFilters = stubAdapter(createAnimeku, 'animeku').browseOptions().filters.map((f) => f.id);
    const oploverzFilters = stubAdapter(createOploverz, 'oploverz').browseOptions().filters.map((f) => f.id);
    // Coming Soon bukan halaman situs: AnimeKu tidak punya /upcoming/ (404, dicek 23 Okt 2026).
    const siteSections = sectionIds('animeku').filter((id) => id !== 'coming');
    assert.deepEqual(animekuFilters.filter((id) => siteSections.includes(id)), siteSections,
        'urutan bagian = urutan filter AnimeKu (Donghua memakai filter khusus)');
    // `donghua` di kedua sumber ditangani registry lewat browseDonghua, bukan filter form situs.
    assert.deepEqual(oploverzFilters, sectionIds('oploverz').filter((id) => id !== 'donghua'),
        'bagian Oploverz = urutan filter situs');
    assert.equal(animekuFilters.includes('coming'), false, 'tidak ada filter coming yang dikarang');
    assert.ok(stubAdapter(createAnimeku, 'animeku').browseOptions().genres.length > 0,
        'AnimeKu punya arsip genre bertoken → pemilih genre tersedia (24 Okt 2026)');
});

test('katalog.js: bagian Donghua AnimeKu dijelaskan sebagai deteksi, bukan kategori situs', () => {
    const block = pageJs.slice(pageJs.indexOf("id: 'donghua',\n                label: 'Donghua di AnimeKu'"));
    assert.ok(block.length > 0, 'bagian Donghua di AnimeKu harus ada');
    assert.match(block, /tidak memberi kategori donghua yang bisa dipakai/, 'pengguna diberi tahu batas sumbernya');
    assert.match(block, /metadata/, 'asal daftar dijelaskan');
    assert.match(pageJs, /filter: state\.query \? '' : runtime\.def\.id/, 'bagian dikirim sebagai filter=donghua ke backend (kecuali saat mencari)');
});

test('katalog.js: tab Donghua memakai feed Donghua Kazanime (bukan kategori karangan)', () => {
    assert.deepEqual(sectionIds('donghua'), ['donghua']);
    assert.match(pageJs, /loader: 'donghua'/);
    assert.match(pageJs, /browseAnime\('donghua', \{ page: runtime\.page \+ 1 \}\)/);
    const indexJs = read('js/api/index.js');
    assert.match(indexJs, /case 'donghua':/);
    assert.match(pageJs, /\{\s*id: 'donghua',\s*label: 'Donghua'/, 'tab ketiga berlabel Donghua');
});

test('katalog.js: Coming Soon memakai metadata, bukan halaman karangan', () => {
    assert.match(pageJs, /loader: 'metadata'/);
    assert.match(pageJs, /getUpcomingAnime\(\{ page: runtime\.page \+ 1, perPage: PREVIEW \* 2 \}\)/);
    const indexJs = read('js/api/index.js');
    assert.match(indexJs, /export async function getUpcomingAnime\(/);
    assert.match(indexJs, /status: 'NOT_YET_RELEASED'/);
    assert.match(indexJs, /status: 'upcoming'/);
});

test('katalog.js: ringkas 6 kartu + tombol Tampilkan lebih banyak + Lihat Semua', () => {
    assert.match(pageJs, /const PREVIEW = 6;/);
    assert.match(pageJs, /const visible = expanded \? runtime\.items : runtime\.items\.slice\(0, PREVIEW\)/);
    assert.match(pageJs, /const expanded = focused \|\| runtime\.expanded;/);
    // Tombol expand membuka sisa judul yang sudah dimuat, di dalam bagian itu.
    assert.match(pageJs, /data-expand aria-expanded="false" hidden>Tampilkan lebih banyak</);
    assert.match(pageJs, /\? 'Tampilkan lebih sedikit'/);
    assert.match(pageJs, /: `Tampilkan lebih banyak \(\$\{runtime\.items\.length\}\$\{runtime\.hasNext \? '\+' : ''\}\)`/);
    assert.match(pageJs, /runtime\.expanded = !runtime\.expanded;/);
    // Tautan bergaya section beranda tetap ada untuk daftar penuh.
    assert.match(pageJs, /class="see-all" data-see-all href="\$\{katalogUrl\(\{ source: state\.source, filter: def\.id, genre: state\.genre \}\)\}"/);
    assert.match(pageJs, /Lihat Semua \$\{icon\('chevron-right'\)\}/);
    assert.match(pageJs, /filter: state\.query \? '' : runtime\.def\.id/);
    // Ronde 5: "Coba Lagi" tetap memaksa refresh; percobaan ulang otomatis juga melewati circuit.
    assert.match(pageJs, /refresh: refresh \|\| attempt > 1,/, 'Coba Lagi melewati cache/circuit frontend');
    assert.match(pageJs, /loadSection\(runtime, \{ reset: true, refresh: true \}\)/);
});

test('katalog.html: kolom pencarian mencari DI DALAM sumber (AnimeKu & Oploverz)', () => {
    assert.match(pageHtml, /<form class="katalog-search" id="katalogSearch" role="search"/);
    assert.match(pageHtml, /id="katalogSearchInput" name="q" type="search"/);
    assert.match(pageHtml, /minlength="2" maxlength="100"/);
    assert.match(pageJs, /function applyQuery\(value\)/);
    assert.match(pageJs, /state\.query = next\.length >= 2 \? next : ''/);
    assert.match(pageJs, /const keyword = \(q\.get\('q'\) \|\| ''\)/);
    assert.match(pageJs, /q\.set\('q', state\.query\)/);
    assert.match(pageJs, /q: state\.query,/);
    assert.match(pageJs, /label: `Hasil untuk/);
    assert.match(sourcesJs, /if \(keyword\) q\.set\('q', keyword\)/);
    assert.match(sourcesJs, /query: String\(data\.query \|\| ''\)/);
    assert.match(pageJs, /searchInput\.reportValidity\(\)/, 'kata kunci < 2 karakter ditolak di klien');
    assert.match(pageJs, /getSourceBrowse\(state\.source, \{/);
});

test('beranda: tiap panel sumber punya kolom cari yang membuka Jelajah', () => {
    assert.match(homeJs, /data-subindo-search="\$\{source\.id\}"/);
    assert.match(homeJs, /placeholder="Cari di \$\{source\.name\}…"/);
    assert.match(homeJs, /window\.location\.href = katalogUrl\(\{ source: id, q: value \}\)/);
    assert.match(homeJs, /delegate\(subIndoRoot, 'submit', '\[data-subindo-search\]'/);
});

test('katalog.js: "Lihat Semua" membuka daftar penuh satu bagian (?filter=) dengan Muat Lagi', () => {
    assert.match(pageJs, /const filter = known\.has\(q\.get\('filter'\)\) \? q\.get\('filter'\) : ''/);
    assert.match(pageJs, /if \(state\.filter\) q\.set\('filter', state\.filter\)/);
    assert.match(pageJs, /const focused = state\.filter \? defs\.filter\(\(section\) => section\.id === state\.filter\) : defs/);
    // Daftar penuh/expanded menampilkan semua item + Muat Lagi untuk halaman berikutnya.
    assert.match(pageJs, /if \(foot\) foot\.hidden = !expanded \|\| !runtime\.hasNext;/);
    // Ada jalan kembali ke tampilan seluruh bagian tanpa kehilangan genre.
    assert.match(pageJs, /katalogUrl\(\{ source: state\.source, genre: state\.genre \}\)/);
    assert.match(pageJs, /Semua bagian/);
});

test('katalogUrl() mendukung filter bagian tanpa memaksa halaman 1', () => {
    assert.match(routesJs, /export function katalogUrl\(\{ source = 'animeku', filter = '', genre = '', q = '', page = 1, year = '', season = '' \} = \{\}\)/);
    assert.match(routesJs, /if \(filter\) p\.set\('filter', filter\)/);
});

test('kartu katalog memakai varian "catalog": nomor episode, bukan klaim "Sub Indo"', () => {
    assert.match(pageJs, /variant: 'catalog'/);
    const cardJs = read('js/ui/card.js');
    assert.match(cardJs, /variant === 'catalog'/);
    assert.match(cardJs, /anime\.status === 'UPCOMING' \? 'Segera'/);
    assert.match(cardJs, /anime\.latestEpisode != null \? `Ep \$\{anime\.latestEpisode\}` : 'Katalog'/);
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
    assert.match(pageJs, /if \(!paged && \(res\.genres\.length \|\| res\.seasons\.length\)\)/);
    assert.match(pageJs, /if \(\(!state\.genres\.length && !state\.seasons\.length\) \|\| state\.query\) \{/,
        'pemilih genre disembunyikan saat mode pencarian');
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
    assert.match(homeJs, /\$\{source\.browse \? html`<a class="see-all subindo-source-more" href="\$\{katalogUrl\(\{ source: source\.id \}\)\}">Lihat Semua \$\{icon\('chevron-right'\)\}<\/a>` : ''\}/);
});

test('css/katalog.css: blok bagian + pemilih genre memakai variabel tema', () => {
    assert.match(css, /\.katalog-sections\{/);
    assert.match(css, /\.katalog-block-actions \.see-all\[hidden\]\{display:none\}/);
    assert.match(css, /\.katalog-expand\{/);
    assert.match(css, /\.katalog-expand\[hidden\]\{display:none\}/);
    assert.match(css, /\.katalog-genre-select\{/);
    assert.match(css, /background:var\(--bg-card\)/);
    assert.match(css, /\.katalog-note\.is-error\{/);
    assert.match(css, /\.katalog-block-head\{/);
    assert.match(css, /\.katalog-block-hint\{/);
    assert.doesNotMatch(css, /#0[0-9a-f]{5}|#1[0-9a-f]{5}/i, 'warna latar harus memakai variabel tema');
});

test('katalog: filter Tahun & Musim diteruskan ke browse dan disimpan di URL', () => {
    assert.match(pageHtml, /id="katalogYear"/);
    assert.match(pageHtml, /id="katalogSeason"/);
    assert.match(pageJs, /year: state\.year,\s*season: state\.season,/s);
    assert.match(pageJs, /if \(state\.year\) q\.set\('year', state\.year\)/);
    assert.match(pageJs, /if \(state\.season\) q\.set\('season', state\.season\)/);
    assert.match(pageJs, /yearSelect\?\.addEventListener\('change'/);
    assert.match(pageJs, /seasonSelect\?\.addEventListener\('change'/);
    assert.match(routesJs, /p\.set\('year', String\(year\)\)/);
});

test('beranda: Jadwal & Genre di atas panel Sub Indo, tanpa paragraf pengantar (24 Okt 2026)', () => {
    const jadwal = homeHtml.indexOf('id="jadwal"');
    const genre = homeHtml.indexOf('id="genre"');
    const subindo = homeHtml.indexOf('id="subindo"');
    assert.ok(jadwal > -1 && genre > jadwal, 'Jadwal lalu Genre harus di paling atas beranda');
    assert.ok(subindo > genre, 'panel Sub Indo tetap ada SETELAH Jadwal & Genre');
    assert.doesNotMatch(homeHtml, /subindo-intro/, 'paragraf pengantar di atas panel Sub Indo dihapus');
    assert.match(homeHtml, /id="genreYear"/);
    assert.match(homeHtml, /id="genreSeason"/);
    assert.match(homeHtml, /id="genreSort"/);
    assert.match(homeCss, /\.genre-filters\{/);
    assert.match(homeCss, /\.genre-group-list\{/);
});

test('home.js: sort Tahun/Musim + genre situs (Oploverz & AnimeKu) memakai data backend', () => {
    assert.match(homeJs, /getSourceGenres\(\)/);
    assert.match(homeJs, /getSourceBrowse\(source, \{\s*genre: id,\s*year: genreState\.year,\s*season: genreState\.season,/s);
    assert.match(homeJs, /SITE_ORDER = \{ oploverz:/, 'urutan situs memakai token order Oploverz');
    assert.match(homeJs, /getGenreAnime\(genre, \{\s*year: genreState\.year,\s*season: genreState\.season,/s);
    assert.match(homeJs, /data-site-genres/, 'genre situs dirender sebagai grup terpisah');
    assert.match(homeJs, /katalogUrl\(\{\s*source, genre: id, year: genreState\.year, season: genreState\.season,/s, 'Lihat Semua membuka katalog sumber+genre (tahun/musim ikut)');
});

test('katalog: filter Tahun & Musim diteruskan ke browse dan disimpan di URL', () => {
    assert.match(pageHtml, /id="katalogYear"/);
    assert.match(pageHtml, /id="katalogSeason"/);
    assert.match(pageJs, /year: state\.year,\s*season: state\.season,/s);
    assert.match(routesJs, /export function katalogUrl\(\{ source = 'animeku', filter = '', genre = '', q = '', page = 1, year = '', season = '' \}/);
    assert.match(routesJs, /if \(\/\^\\d\{4\}\$\/\.test\(String\(year \|\| ''\)\)\) p\.set\('year'/);
    assert.match(routesJs, /winter\|spring\|summer\|fall/);
    assert.match(css, /\.katalog-genre-select\{/);
    assert.match(pageHtml, /<select id="katalogYear" class="katalog-genre-select">/);
});
