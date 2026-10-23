import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Daftar genre beranda (24 Okt 2026, permintaan pengguna: "tampilkan semua genre").
 *
 * Sebelumnya hanya 10 genre (subset). Sekarang harus memuat SELURUH genre AniList
 * (18 genre) + tag Isekai, masing-masing dengan padanan slug Kitsu untuk fallback.
 * Nilai `label` juga dipakai apa adanya sebagai genre AniList, jadi ejaannya harus
 * sama persis (mis. "Sci-Fi", "Slice of Life", "Mahou Shoujo").
 */
const root = process.cwd();
const configJs = fs.readFileSync(path.join(root, 'js/config.js'), 'utf8');
const homeJs = fs.readFileSync(path.join(root, 'js/home.js'), 'utf8');
const apiJs = fs.readFileSync(path.join(root, 'js/api/index.js'), 'utf8');

const GENRES_BLOCK = configJs.slice(
    configJs.indexOf('export const GENRES = Object.freeze(['),
    configJs.indexOf(']);', configJs.indexOf('export const GENRES = Object.freeze([')),
);
const ENTRIES = [...GENRES_BLOCK.matchAll(/\{ label: '([^']+)',\s+kitsu: '([^']+)'(?:, anilistTag: '([^']+)')? \}/g)]
    .map((m) => ({ label: m[1], kitsu: m[2], anilistTag: m[3] || '' }));

const ANILIST_GENRES = [
    'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo',
    'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life',
    'Sports', 'Supernatural', 'Thriller',
];

test('GENRES: memuat seluruh genre AniList + tag Isekai', () => {
    assert.equal(ENTRIES.length, ANILIST_GENRES.length + 1, '18 genre AniList + Isekai');
    assert.deepEqual(ENTRIES.map((g) => g.label), [...ANILIST_GENRES, 'Isekai']);
    assert.deepEqual(
        ENTRIES.filter((g) => !ANILIST_GENRES.includes(g.label)).map((g) => g.label),
        ['Isekai'],
    );
});

test('GENRES: tiap genre punya slug Kitsu & Isekai memakai tag AniList', () => {
    for (const genre of ENTRIES) {
        assert.match(genre.kitsu, /^[a-z0-9-]+$/, `slug Kitsu tidak valid untuk ${genre.label}`);
    }
    const uniqueKitsu = new Set(ENTRIES.map((g) => g.kitsu));
    assert.equal(uniqueKitsu.size, ENTRIES.length, 'slug Kitsu tidak boleh duplikat');
    const isekai = ENTRIES.find((g) => g.label === 'Isekai');
    assert.equal(isekai.anilistTag, 'Isekai', 'Isekai adalah tag di AniList, bukan genre');
    assert.equal(ENTRIES.filter((g) => g.anilistTag).length, 1);
});

test('beranda & API memakai daftar GENRES yang sama (tidak ada subset terpisah)', () => {
    assert.match(homeJs, /GENRES\.map\(\(g\) => html`<button type="button" class="genre-tag"/);
    assert.match(apiJs, /return GENRES\.find\(\(g\) => g\.label\.toLowerCase\(\) === key\) \|\| null;/);
});
