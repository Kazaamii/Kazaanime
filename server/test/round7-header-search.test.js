import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Putaran 7 (24 Okt 2026) — permintaan pengguna:
 * "gabungkan pencarian data yg di top header jangan dari kitsu dan anilist saja,
 *  gunakan yg di anime ku dan oploverz juga".
 *
 * Kotak pencarian header kini memakai tiga grup: AnimeKu & Oploverz, AniList, Kitsu.
 * Grup situs punya aturan sendiri (lihat js/ui/search-suggest.js) karena tujuannya
 * berbeda: item situs membuka episode langsung di sumbernya.
 */

// js/api/http.js memasang listener `online` saat modul dimuat → stub minimal.
globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
};

const { groupSuggestions, siteOfSuggestion, siteResults, SITE_SOURCES, SITE_PER_SOURCE } = await import('../../js/ui/search-suggest.js');
const { searchAnime } = await import('../../js/api/index.js');

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const dropdownJs = read('js/ui/search-dropdown.js');
const apiIndexJs = read('js/api/index.js');
const searchJs = read('js/search.js');
const searchHtml = read('search.html');
const searchCss = read('css/search.css');
const componentsCss = read('css/components.css');

const GROUPS = [
    { source: 'backend', label: 'AnimeKu & Oploverz', badge: 'source-site', name: 'AnimeKu & Oploverz' },
    { source: 'anilist', label: 'AniList', badge: 'source-anilist', name: 'AniList' },
    { source: 'kitsu', label: 'Kitsu', badge: 'source-kitsu', name: 'Kitsu' },
];
const limitOf = () => 5;

const meta = (title, extra = {}) => ({ title, titleAlt: '', ids: {}, ...extra });
const siteItem = (site, title, slug, extra = {}) => ({ title, slug, source: `backend:${site}`, ids: {}, ...extra });

test('saran header: judul yang sama tetap muncul di grup situs (bukan dibuang)', () => {
    const state = {
        anilist: [meta('Solo Leveling', { ids: { anilist: 151807 } })],
        kitsu: [meta('Solo Leveling', { ids: { kitsu: '1' } })],
        backend: [
            siteItem('animeku', 'Solo Leveling', 'animeku~solo-leveling'),
            siteItem('oploverz', 'Solo Leveling', 'oploverz~solo-leveling'),
        ],
    };
    const { groups, total } = groupSuggestions(state, { groups: GROUPS, limitOf });
    // Kitsu tidak punya baris sendiri karena judulnya sudah tampil dari AniList (aturan lama).
    assert.deepEqual(groups.map((group) => group.source), ['backend', 'anilist']);
    assert.deepEqual(groups[0].items.map((item) => item.source), ['backend:animeku', 'backend:oploverz']);
    assert.equal(groups[1].items.length, 1, 'AniList tetap tampil');
    assert.equal(total, 3);
});

test('saran header: hanya AnimeKu & Oploverz, maks 3 per situs, AnimeKu lebih dulu', () => {
    const state = {
        anilist: [],
        kitsu: [],
        backend: [
            siteItem('hianime', 'Bleach', 'hianime~bleach'),
            siteItem('oploverz', 'Bleach', 'oploverz~bleach'),
            siteItem('animeku', 'Bleach', 'animeku~bleach'),
            siteItem('anoboy', 'Naruto', 'anoboy~naruto'),
            siteItem('animeku', 'Naruto', 'animeku~naruto'),
            siteItem('animeku', 'One Piece', 'animeku~one-piece'),
            siteItem('animeku', 'Bleach', 'animeku~bleach'),
            siteItem('animeku', 'Fairy Tail', 'animeku~fairy-tail'),
            siteItem('oploverz', 'Naruto', 'oploverz~naruto'),
        ],
    };
    const { groups } = groupSuggestions(state, { groups: GROUPS, limitOf });
    const sites = groups.find((group) => group.source === 'backend');
    assert.ok(sites, 'grup situs ada');
    assert.deepEqual([...SITE_SOURCES], ['animeku', 'oploverz']);
    assert.equal(SITE_PER_SOURCE, 3);
    assert.equal(sites.items.length, 5, '3 judul AnimeKu + 2 Oploverz');
    assert.deepEqual(sites.items.map((item) => item.source), [
        'backend:animeku', 'backend:animeku', 'backend:animeku', 'backend:oploverz', 'backend:oploverz',
    ]);
    assert.equal(new Set(sites.items.map((item) => item.slug)).size, sites.items.length, 'slug tidak dobel');
    assert.ok(!sites.items.some((item) => /hianime|anoboy/.test(item.source)), 'situs lain tidak ditampilkan');
});

test('saran header: sumber yang masih dimuat atau gagal tidak menghentikan grup lain', () => {
    const pending = groupSuggestions({ anilist: [meta('Bleach')] }, { groups: GROUPS, limitOf });
    assert.deepEqual(pending.pending, ['AnimeKu & Oploverz', 'Kitsu']);
    assert.equal(pending.failed, 0);
    assert.equal(pending.groups.length, 1);

    const failing = groupSuggestions({
        anilist: [meta('Bleach')],
        kitsu: new Error('jaringan'),
        backend: [],
    }, { groups: GROUPS, limitOf });
    assert.equal(failing.failed, 1);
    assert.deepEqual(failing.pending, []);
    assert.deepEqual(failing.groups.map((group) => group.source), ['anilist']);

    const empty = groupSuggestions({ anilist: [], kitsu: [], backend: [] }, { groups: GROUPS, limitOf });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.groups, []);
});

test('saran header: item situs dikenali dari `backend:<situs>`', () => {
    assert.equal(siteOfSuggestion({ source: 'backend:animeku' }), 'animeku');
    assert.equal(siteOfSuggestion({ source: 'backend:oploverz~judul' }), 'oploverz');
    assert.equal(siteOfSuggestion({ source: 'backend:hianime' }), '');
    assert.equal(siteOfSuggestion({ source: 'anilist' }), '');
    assert.equal(siteOfSuggestion(null), '');
});

test('autocomplete: AnimeKu & Oploverz ikut diminta bersama AniList & Kitsu', () => {
    assert.match(apiIndexJs, /backend: backend\.searchBackend\(q, \{ signal \}\)\.then\(\(r\) => r\.items \|\| \[\]\)/);
    assert.match(dropdownJs, /\{ source: 'backend', label: 'AnimeKu & Oploverz', badge: 'source-site', name: 'AnimeKu & Oploverz' \}/);
    assert.match(dropdownJs, /const \{ groups, pending: pendingNames, failed, total \} = groupSuggestions\(state, \{/);
    assert.match(dropdownJs, /Mencari "\$\{q\}" di AniList, Kitsu, AnimeKu & Oploverz\.\.\./);
    assert.match(dropdownJs, /<span class="source-badge source-site">\$\{SITE_LABELS\[site\]\}<\/span><span>Sub Indo<\/span>/,
        'item situs menampilkan nama situs + Sub Indo');
    assert.match(dropdownJs, /katalogUrl\(\{ source: 'animeku', q \}\)/, 'footer menawarkan pencarian penuh di katalog situs');
    assert.match(componentsCss, /\.source-site\{/, 'badge situs punya gaya sendiri');
    assert.match(componentsCss, /\.search-dropdown-actions\{/, 'dua aksi footer tetap rapi');
});

test('searchAnime: sumber situs memakai backend dan tidak punya paginasi', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({
                ok: true,
                source: 'animeku,oploverz',
                data: [
                    { title: 'Bleach', slug: 'animeku~bleach', source: 'animeku' },
                    { title: 'Bleach', slug: 'oploverz~bleach', source: 'oploverz' },
                ],
            }),
        };
    };
    try {
        const res = await searchAnime('bleach', { sources: ['backend'] });
        assert.ok(calls.some((url) => url.includes('/api/anime/search?q=bleach')), calls.join(','));
        assert.equal(res.backend.items.length, 2);
        assert.equal(res.backend.hasNext, false, 'situs tidak punya halaman berikutnya');
        assert.deepEqual(res.backend.items.map((anime) => anime.source), ['backend:animeku', 'backend:oploverz']);
        const sites = siteResults(res.backend.items, 8);
        assert.equal(sites.length, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('halaman pencarian: hasil AnimeKu & Oploverz tampil di bagian sendiri', () => {
    assert.match(searchHtml, /<section class="search-site-section" id="searchSiteResults" hidden aria-labelledby="searchSiteTitle">/);
    assert.match(searchHtml, /<div class="anime-grid" id="searchSiteGrid"><\/div>/);
    assert.match(searchHtml, /Langsung dari AnimeKu &amp; Oploverz/);
    assert.match(searchJs, /const SITE_SOURCE = 'backend';/);
    assert.match(searchJs, /: \[\.\.\.SEARCH_SOURCE_ORDER, SITE_SOURCE\]/, 'backend ikut diminta di halaman pertama');
    assert.match(searchJs, /sources\.filter\(\(source\) => source !== SITE_SOURCE\)/, 'hasil situs tidak masuk tab metadata');
    assert.match(searchJs, /state\.siteItems = siteResults\(siteRes\?\.items \|\| \[\], SITE_SEARCH_LIMIT\)/);
    assert.match(searchJs, /renderCards\(siteGrid, items, \{ variant: 'source', isBookmarked, episodeOf: latestEpisodeOf \}\)/);
    assert.match(searchJs, /bindCardActions\(siteGrid, \(anime\) => ctx\.toggleBookmark\(anime\)\)/);
    assert.match(searchCss, /\.search-site-section\[hidden\]\{display:none\}/);
    assert.match(searchCss, /\.search-site-note\{/);
});

test('siteResults: batas per situs bisa dinaikkan untuk halaman hasil', () => {
    const list = [];
    for (let i = 0; i < 10; i += 1) {
        list.push(siteItem('animeku', `Judul ${i}`, `animeku~judul-${i}`));
        list.push(siteItem('oploverz', `Judul ${i}`, `oploverz~judul-${i}`));
    }
    assert.equal(siteResults(list).length, SITE_PER_SOURCE * 2);
    assert.equal(siteResults(list, 8).length, 16);
    assert.equal(siteResults(list, 8)[0].source, 'backend:animeku');
    assert.equal(siteResults(list, 8)[8].source, 'backend:oploverz');
});
