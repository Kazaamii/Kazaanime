/**
 * Kazanime — round16-subindo-visible.test.js
 * Putaran 16 (24 Okt 2026).
 *
 * Permintaan pengguna: *"mana server sub indo nya kembalikan"*.
 *
 * Penyebab: tombol AnimeKu & Animeloverz dibangun dari server hasil scraping. Bila backend tidak
 * bisa menjangkau sumbernya (mati/jaringan/episode belum ada), daftar server hanya berisi server
 * luar — dua tombol Sub Indo seolah hilang.
 *
 * Aturan yang dijaga:
 *  1. Daftar Sub Indo SELALU berisi dua entri: AnimeKu lalu Animeloverz.
 *  2. Situs yang tidak mengirim server diisi placeholder `available:false` + `placeholder:true`
 *     (tanpa URL) dengan badge "tidak terjangkau".
 *  3. Placeholder tidak pernah diputar otomatis; klik tombolnya = cari ulang (retrysubindo).
 *  4. Perilaku lama tidak berubah: server asli tetap satu per situs & tetap diprioritaskan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    fillSubIndoServers,
    subIndoPlaceholder,
    subIndoSiteOf,
    SUB_INDO_OFFLINE_BADGE,
    SUB_INDO_OFFLINE_REASON,
    SUB_INDO_SITES,
} from '../../js/services/subindo-slots.js';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const watchJs = read('js/watch.js');
const watchCode = stripComments(watchJs);
const playerJs = read('js/ui/player.js');
const playerCode = stripComments(playerJs);
const watchHtml = read('watch.html');
const watchCss = read('css/watch.css');

/* ------------------------------------------------------------------ */
/* 1 · Modul slot Sub Indo                                             */
/* ------------------------------------------------------------------ */
test('putaran 16: tanpa server apa pun, AnimeKu & Animeloverz tetap ada', () => {
    const list = fillSubIndoServers([]);
    assert.equal(list.length, 2, 'tepat dua tombol Sub Indo');
    assert.deepEqual(list.map((s) => s.name), ['AnimeKu', 'Animeloverz']);
    assert.deepEqual(list.map((s) => s.site), ['animeku', 'oploverz']);
    for (const slot of list) {
        assert.equal(slot.available, false, 'placeholder tidak boleh diputar otomatis');
        assert.equal(slot.placeholder, true);
        assert.equal(slot.url, null, 'placeholder tidak punya URL');
        assert.equal(slot.lang, 'id', 'tetap dikenali sebagai Sub Indo');
        assert.match(slot.source, /^backend:(animeku|oploverz)$/);
        assert.equal(slot.reason, SUB_INDO_OFFLINE_REASON);
        assert.match(slot.id, /^subindo-(animeku|oploverz)-offline$/);
    }
});

test('putaran 16: fungsi tahan input kosong/aneh', () => {
    for (const input of [undefined, null, [], 'bukan-array', 0]) {
        const list = fillSubIndoServers(input);
        assert.equal(list.length, 2, `input ${String(input)} tetap menghasilkan dua slot`);
        assert.ok(list.every((s) => s.placeholder === true));
    }
});

test('putaran 16: server asli dipertahankan, situs lain diisi placeholder', () => {
    const real = {
        id: 'animeku-ep15',
        name: 'AnimeKu',
        source: 'backend:animeku',
        url: 'https://puterin.biz/e/abc',
        available: true,
        lang: 'id',
    };
    const list = fillSubIndoServers([real]);
    assert.equal(list.length, 2);
    assert.equal(list[0], real, 'server AnimeKu asli dipakai apa adanya');
    assert.equal(list[1].placeholder, true);
    assert.equal(list[1].name, 'Animeloverz');
});

test('putaran 16: satu server per situs, urutan selalu AnimeKu dulu', () => {
    const o1 = { id: 'o1', name: 'Oploverz 1', source: 'backend:oploverz', url: 'https://oploverz.example/1', available: true, lang: 'id' };
    const o2 = { id: 'o2', name: 'Oploverz 2', source: 'backend:oploverz', url: 'https://oploverz.example/2', available: true, lang: 'id' };
    const a1 = { id: 'a1', name: 'AnimeKu 1', source: 'backend:animeku', url: 'https://animeku.example/1', available: true, lang: 'id' };
    const list = fillSubIndoServers([o1, o2, a1]);
    assert.deepEqual(list.map((s) => s.id), ['a1', 'o1'], 'satu per situs, AnimeKu dulu');
});

test('putaran 16: situs asal dikenali dari source maupun slug', () => {
    assert.equal(subIndoSiteOf({ source: 'backend:animeku' }), 'animeku');
    assert.equal(subIndoSiteOf({ source: 'animeku~judul~ep1' }), 'animeku');
    assert.equal(subIndoSiteOf({ source: 'backend:oploverz' }), 'oploverz');
    assert.equal(subIndoSiteOf({ source: 'static' }), 'static');
    assert.equal(subIndoSiteOf(null), '');
    // Daftar situs resmi tetap dua dan berurutan.
    assert.deepEqual([...SUB_INDO_SITES], ['animeku', 'oploverz']);
    assert.equal(subIndoPlaceholder('animeku').name, 'AnimeKu');
    assert.equal(SUB_INDO_OFFLINE_BADGE, 'tidak terjangkau');
});

/* ------------------------------------------------------------------ */
/* 2 · Halaman nonton memakai slot tersebut                            */
/* ------------------------------------------------------------------ */
test('watch: daftar server memakai fillSubIndoServers di kedua urutan', () => {
    assert.match(watchCode, /import \{ fillSubIndoServers, SUB_INDO_OFFLINE_BADGE \} from '\.\/services\/subindo-slots\.js';/);
    // scrape-first (default) dan static-first sama-sama mengisi dua slot.
    assert.match(watchCode, /fillSubIndoServers\(subIndo\)/);
    assert.match(watchCode, /fillSubIndoServers\(subIndoStatic\)/);
    // Perilaku lama (satu server per situs) tetap dipertahankan sebelum diisi placeholder.
    assert.match(watchCode, /const subIndo = firstPerSite\(backendServers\.filter\(isSubIndoSource\)\);/);
});

test('watch: placeholder diberi badge & keterangan, bukan disembunyikan', () => {
    assert.match(watchCode, /badge: s\.placeholder\s*\? SUB_INDO_OFFLINE_BADGE/);
    assert.match(watchCode, /description: s\.placeholder\s*\? s\.reason \|\| SUB_INDO_OFFLINE_BADGE/);
    assert.match(watchCode, /s\.placeholder/);
});

test('watch: klik tombol "tidak terjangkau" memicu pencarian ulang', () => {
    assert.match(watchCode, /player\.on\('retrysubindo', \(\) => \{ retrySubIndo\(\); \}\);/);
    assert.match(watchCode, /async function retrySubIndo\(\)/);
    const fn = watchCode.slice(watchCode.indexOf('async function retrySubIndo'), watchCode.indexOf('async function retrySubIndo') + 1200);
    assert.match(fn, /retrySourcesNow\(\)/);
    assert.match(fn, /await loadExtras\(ep, \{ refresh: true \}\)/, 'klik harus melewati cache, bukan mengulang hasil lama');
    assert.match(fn, /player\.setServers\(servers\(\)\)/);
    assert.match(fn, /subIndoRetrying/, 'klik berulang tidak menumpuk permintaan');
});

/* ------------------------------------------------------------------ */
/* 3 · Player merender & menangani placeholder                         */
/* ------------------------------------------------------------------ */
test('watch/api: pencarian ulang melewati cache episode', () => {
    const sourcesJs = stripComments(read('js/api/sources.js'));
    const streamsJs = stripComments(read('js/api/streams.js'));
    // getBackendEpisode: refresh → force + noCache.
    assert.match(sourcesJs, /export function getBackendEpisode\(slug, ep, \{ signal, refresh = false \} = \{\}\) \{/);
    const fn = sourcesJs.slice(sourcesJs.indexOf('export function getBackendEpisode('));
    assert.match(fn.slice(0, 700), /force: refresh/);
    assert.match(fn.slice(0, 700), /noCache: refresh/);
    // getEpisodeExtras meneruskan refresh ke SETIAP permintaan episode (sumber asal, ulangan,
    // padanan, dan ulangan padanan) — bukan hanya yang pertama.
    assert.match(streamsJs, /export async function getEpisodeExtras\(anime, ep, \{ slug, titles, signal, refresh = false \} = \{\}\) \{/);
    assert.match(streamsJs, /const getEpisode = \(target\) => backend\.getBackendEpisode\(target, ep, \{ signal, refresh \}\);/);
    assert.equal((streamsJs.match(/backend\.getBackendEpisode\(/g) || []).length, 1, 'tidak ada pemanggilan yang melewati refresh');
});

test('player: placeholder tampil dengan kelas is-offline dan badge khusus', () => {
    assert.match(playerCode, /retrysubindo: new Set\(\)/);
    assert.match(playerCode, /const offline = Boolean\(s\.placeholder\);/);
    assert.match(playerCode, /offline \? 'is-offline' : ''/);
    assert.match(playerCode, /server-badge--offline/);
    assert.match(playerCode, /tidak terjangkau/);
    // Tidak memakai ikon gembok untuk placeholder (tombolnya bisa diklik).
    assert.match(playerCode, /s\.available \|\| offline \? '' : html` <span class="server-lock"/);
    // Badge "tidak terjangkau" hanya dirender sekali (smoke happy-dom sempat menampilkannya dua kali).
    assert.match(playerCode, /s\.badge && !offline \? html` <span class="server-badge">\$\{s\.badge\}<\/span>` : ''/);
});

test('player: klik placeholder mengirim event retrysubindo, bukan toast "tidak tersedia"', () => {
    const click = playerCode.slice(playerCode.indexOf("const s = byId(btn.dataset.server);"), playerCode.indexOf("const s = byId(btn.dataset.server);") + 900);
    assert.match(click, /if \(s\.placeholder\) \{/);
    assert.match(click, /emit\('retrysubindo', \{ site: s\.site \|\| '', name: s\.name \}\)/);
    // Placeholder tetap bisa diklik (aria-disabled false) supaya pembaca layar tahu ini aksi.
    assert.match(playerCode, /aria-disabled="\$\{s\.available \|\| offline \? 'false' : 'true'\}"/);
});

test('watch/css: gaya tombol offline tersedia & tidak menyerupai server mati biasa', () => {
    assert.match(watchCss, /\.server-btn\.is-offline\{[^}]*cursor:pointer/);
    assert.match(watchCss, /\.server-btn\.is-offline:hover\{/);
    assert.match(watchCss, /\.server-btn \.server-badge--offline\{/);
    const hint = watchHtml.slice(watchHtml.indexOf('class="server-hint"'), watchHtml.indexOf('</p>', watchHtml.indexOf('class="server-hint"')));
    assert.match(hint, /Tombol <strong>AnimeKu\/Animeloverz<\/strong> selalu ada/);
    assert.match(hint, /tidak terjangkau/);
});
