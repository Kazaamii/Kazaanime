import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Halaman Bookmark sendiri (24 Okt 2026, permintaan pengguna):
 * bookmark keluar dari navbar yang sempit & dari beranda, lalu punya halaman
 * bookmark.html dengan pencarian + urutan. Test ini menjaga kontrak itu.
 */
const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const pageHtml = read('bookmark.html');
const pageJs = read('js/bookmark.js');
const configJs = read('js/config.js');
const routesJs = read('js/routes.js');
const navbarJs = read('js/ui/navbar.js');
const footerJs = read('js/ui/footer.js');
const homeHtml = read('index.html');
const homeJs = read('js/home.js');
const css = read('css/bookmark.css');

test('bookmark.html: halaman berdiri sendiri dengan grid, pencarian, dan urutan', () => {
    assert.match(pageHtml, /<body data-page="bookmark">/);
    assert.match(pageHtml, /<div class="anime-grid bookmark-grid" id="bookmarkGrid"/);
    assert.match(pageHtml, /id="bookmarkSearch"/);
    assert.match(pageHtml, /id="bookmarkSort"/);
    assert.match(pageHtml, /<option value="saved">Terakhir disimpan<\/option>/);
    assert.match(pageHtml, /<option value="title">Judul A–Z<\/option>/);
    assert.match(pageHtml, /<option value="score">Rating tertinggi<\/option>/);
    assert.match(pageHtml, /<link rel="stylesheet" href="css\/bookmark.css">/);
    assert.match(pageHtml, /<script type="module" src="js\/bookmark.js"><\/script>/);
    assert.match(pageHtml, /id="app-navbar"/);
    assert.match(pageHtml, /id="app-footer"/);
});

test('bookmark.js: memakai sumber bookmark yang sama + kartu varian bookmark', () => {
    assert.match(pageJs, /import \{ getBookmarks, onBookmarksChange \} from '\.\/services\/bookmark\.js'/);
    assert.match(pageJs, /import \{ initLayout \} from '\.\/ui\/layout\.js'/);
    assert.match(pageJs, /renderCards\(grid, visible, \{ variant: 'bookmark', isBookmarked: \(\) => true \}\)/);
    assert.match(pageJs, /state\.sort === 'title'/);
    assert.match(pageJs, /state\.sort === 'score'/);
    assert.match(pageJs, /onBookmarksChange\(render\)/);
    assert.match(pageJs, /onAuthChange\(render\)/);
    assert.match(pageJs, /openAuthModal\('login'\)/);
    assert.match(pageJs, /bindCardActions\(grid, \(anime\) => ctx\.toggleBookmark\(anime\)\)/);
});

test('bookmark keluar dari navbar: tidak ada lagi tautan Bookmark di daftar nav', () => {
    const navList = configJs.slice(configJs.indexOf('NAV_LINKS = Object.freeze(['), configJs.indexOf(']);', configJs.indexOf('NAV_LINKS = Object.freeze([')));
    assert.doesNotMatch(navList, /label: 'Bookmark'/, 'Bookmark tidak lagi memakan ruang navbar');
    assert.doesNotMatch(navList, /section: 'bookmarks'/);
    // Akses tetap ada lewat menu profil dan footer, menuju halaman sendiri.
    assert.match(navbarJs, /href="bookmark\.html" data-action="bookmarks"/);
    assert.match(footerJs, /<a href="bookmark\.html">Bookmark Saya<\/a>/);
});

test('beranda tidak lagi merender daftar bookmark (dipindah ke halaman sendiri)', () => {
    assert.doesNotMatch(homeHtml, /id="bookmarks"/);
    assert.doesNotMatch(homeHtml, /id="bookmarkGrid"/);
    assert.doesNotMatch(homeJs, /renderBookmarkSection/);
    assert.doesNotMatch(homeJs, /getBookmarks\(\)/);
    // Kartu di beranda tetap menyinkronkan status tombol bookmark.
    assert.match(homeJs, /syncBookmarkButtons\(isBookmarked, main\)/);
});

test('routes.js: halaman bookmark terdaftar', () => {
    assert.match(routesJs, /bookmark: 'bookmark\.html'/);
    assert.match(routesJs, /export function bookmarkUrl\(\) \{\s*return PAGES\.bookmark;/);
});

test('css/bookmark.css: toolbar memakai variabel tema', () => {
    assert.match(css, /\.bookmark-toolbar\{/);
    assert.match(css, /\.bookmark-search\{/);
    assert.match(css, /\.bookmark-sort\{/);
    assert.match(css, /background:var\(--bg-card\)/);
    assert.doesNotMatch(css, /#0[0-9a-f]{5}|#1[0-9a-f]{5}/i);
});
