/**
 * Kazanime — round25-server-options.test.js
 * Putaran 25 (25 Okt 2026).
 *
 * Dua permintaan pengguna:
 *  1. *"untuk Oploverz bisa di upayakan agar tidak bertabrakan kasih tombol opsi saja jadi oploverz
 *     punya 2 server"* — Oploverz (`HD-1` + `HD-2`) tetap **satu** tombol situs, tetapi punya
 *     dropdown **opsi**; pilihan diingat (`kz:mirror`).
 *  2. *"untuk animewave pisahkan tombol nya agar tidak terlalu banyak jadi untuk english dipisah
 *     baris nya dan dub nya"* — tombol server dipisah per baris jenis (Sub Indo / Multi Sub /
 *     Subtitle Inggris / Dub), dan bahasa `dub` didukung penuh.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g).replace(/(^|[^:])\/\/.*$/gm, '$1');

const playerCode = stripComments(read('js/ui/player.js'));
const watchCode = stripComments(read('js/watch.js'));
const configJs = read('js/config.js');
const watchCss = read('css/watch.css');
const sourcesJs = read('js/api/sources.js');
const animeLib = read('server/lib/anime.js');
const { fillSubIndoServers, siteSlots, subIndoSiteOf, MAX_SITE_OPTIONS } =
    await import('../../js/services/subindo-slots.js');

const oploverzServers = () => [
    { id: 'backend-oploverz-0', name: 'HD-1', url: 'https://play.example/hd1', available: true, source: 'backend:oploverz', lang: 'id' },
    { id: 'backend-oploverz-1', name: 'HD-2', url: 'https://play.example/hd2', available: true, source: 'backend:oploverz', lang: 'id' },
];

/* ------------------------------------------------------------------ */
/* 1 · Slot Sub Indo: satu tombol situs, banyak opsi                  */
/* ------------------------------------------------------------------ */
test('slot: Oploverz HD-1 + HD-2 menjadi SATU slot dengan dua opsi', () => {
    const animeku = { id: 'backend-animeku-0', name: 'AnimeKu', url: 'https://k/1', available: true, source: 'backend:animeku', lang: 'id' };
    const list = fillSubIndoServers([animeku, ...oploverzServers()]);
    assert.equal(list.length, 2, 'tetap tepat dua tombol situs (putaran 16 tidak dilanggar)');
    assert.equal(list[0].id, 'backend-animeku-0');
    const slot = list[1];
    assert.equal(slot.id, 'backend-oploverz-0', 'slot memakai server pertama situs');
    assert.equal(slot.url, 'https://play.example/hd1');
    assert.deepEqual(slot.options.map((o) => o.label), ['HD-1', 'HD-2']);
    assert.deepEqual(slot.mirrors, ['https://play.example/hd1', 'https://play.example/hd2']);
    assert.deepEqual(slot.mirrorLabels, ['HD-1', 'HD-2']);
    assert.equal(slot.optionCount, 2);
    assert.equal(slot.hasOptions, true);
});

test('slot: satu server saja tidak menambah properti apa pun (identitas objek dipertahankan)', () => {
    const solo = { id: 'o1', name: 'HD-1', url: 'https://x/1', available: true, source: 'backend:oploverz', lang: 'id' };
    // Urutan slot selalu AnimeKu dulu → server Oploverz ada di indeks 1.
    assert.equal(fillSubIndoServers([solo])[1], solo, 'objek asli dikembalikan apa adanya');
    assert.equal(siteSlots([solo]).oploverz, solo);
});

test('slot: situs tanpa server tetap placeholder, urutan AnimeKu → Animeloverz', () => {
    const list = fillSubIndoServers([]);
    assert.deepEqual(list.map((s) => s.name), ['AnimeKu', 'Animeloverz']);
    assert.ok(list.every((s) => s.placeholder && s.url === null));
    assert.equal(subIndoSiteOf({ source: 'oploverz~judul' }), 'oploverz');
});

test('slot: opsi dibatasi & duplikat URL dibuang', () => {
    const many = Array.from({ length: MAX_SITE_OPTIONS + 3 }, (_, i) => ({
        id: `o${i}`, name: `HD-${i + 1}`, url: `https://x/${i}`, available: true, source: 'backend:oploverz', lang: 'id',
    }));
    const slot = fillSubIndoServers(many)[1];
    assert.equal(slot.options.length, MAX_SITE_OPTIONS);
    const dup = fillSubIndoServers([
        { id: 'a', name: 'HD-1', url: 'https://x/sama', available: true, source: 'backend:oploverz', lang: 'id' },
        { id: 'b', name: 'HD-2', url: 'https://x/sama', available: true, source: 'backend:oploverz', lang: 'id' },
    ])[1];
    assert.equal(dup.options, undefined, 'URL identik memutar berkas yang sama → satu opsi');
    assert.equal(dup.url, 'https://x/sama');
});

/* ------------------------------------------------------------------ */
/* 2 · Pemutar: pilihan opsi disimpan & dipakai                       */
/* ------------------------------------------------------------------ */
test('config: kunci ingatan opsi ada', () => {
    assert.match(configJs, /mirrorChoice: 'kz:mirror'/);
});

test('player: opsi dibaca dari localStorage lalu memori sesi', () => {
    assert.match(playerCode, /const MIRROR_LIMIT = PLAYER\.externalGuard\?\.maxServers \|\| 40;/);
    assert.match(playerCode, /function readMirrorChoice\(\) \{/);
    assert.match(playerCode, /function writeMirrorChoice\(serverId, index\) \{/);
    assert.match(playerCode, /storage\.set\(STORAGE_KEYS\.mirrorChoice, all\);/);
    const fn = playerCode.slice(playerCode.indexOf('function optionIndex(server)'), playerCode.indexOf('function optionIndex(server)') + 700);
    assert.match(fn, /if \(mirror\.has\(server\.id\)\) return mirror\.get\(server\.id\) \|\| 0;/);
    assert.match(fn, /const saved = Number\(readMirrorChoice\(\)\[server\.id\]\);/);
    assert.match(playerCode, /const urlOf = \(server\) => server\.mirrors\?\.\[optionIndex\(server\)\] \|\| server\.url;/);
});

test('player: setOption memutar ulang server aktif & menyimpan pilihan', () => {
    const fn = playerCode.slice(playerCode.indexOf('function setOption(serverId, index)'), playerCode.indexOf('function setOption(serverId, index)') + 1100);
    assert.match(fn, /mirror\.set\(serverId, index\);/);
    assert.match(fn, /writeMirrorChoice\(serverId, index\);/);
    assert.match(fn, /if \(serverId === currentId && \(state === 'loading' \|\| state === 'playing'\)\)/);
    assert.match(fn, /if \(!Number\.isInteger\(index\) \|\| index < 0 \|\| index >= total\) return false;/);
    assert.match(playerCode, /setOption,\n/);
    assert.match(playerCode, /serverOptions\(serverId\) \{/);
});

test('player: mirror otomatis memakai opsi tersimpan, klik server tidak mereset pilihan', () => {
    const fail = playerCode.slice(playerCode.indexOf('function fail(server, reason)'), playerCode.indexOf('function fail(server, reason)') + 600);
    assert.match(fail, /const idx = optionIndex\(server\);/);
    assert.match(fail, /mirror\.set\(server\.id, idx \+ 1\);/);
    const click = playerCode.slice(playerCode.indexOf("delegate(serverBox, 'click', '.server-btn[data-server]'"));
    assert.doesNotMatch(click.slice(0, 400), /mirror\.delete\(s\.id\)/, 'pilihan opsi tidak direset saat tombol diklik');
});

/* ------------------------------------------------------------------ */
/* 3 · Dropdown opsi & pemisahan baris di panel server                */
/* ------------------------------------------------------------------ */
test('player: dropdown opsi dirender untuk server dengan lebih dari satu opsi', () => {
    assert.match(playerCode, /function optionRow\(list\) \{/);
    const fn = playerCode.slice(playerCode.indexOf('function optionRow(list)'), playerCode.indexOf('function optionRow(list)') + 900);
    assert.match(fn, /s\.options\.length > 1 && s\.available/);
    assert.match(fn, /<select data-server-option="\$\{s\.id\}"/);
    assert.match(fn, /<option value="\$\{i\}"\$\{i === active \? ' selected' : ''\}>\$\{option\.label\}<\/option>/);
    assert.match(playerCode, /delegate\(serverBox, 'change', 'select\[data-server-option\]'/);
});

test('player: server ber-group dirender per baris, yang lain tetap datar', () => {
    assert.match(playerCode, /function serverRows\(list\) \{/);
    const fn = playerCode.slice(playerCode.indexOf('function serverRows(list)'), playerCode.indexOf('function serverRows(list)') + 700);
    assert.match(fn, /const key = String\(server\.group \|\| ''\);/);
    const render = playerCode.slice(playerCode.indexOf('function renderServers()'));
    assert.match(render.slice(0, 1800), /if \(!servers\.some\(\(s\) => s\.group\)\)/);
    assert.match(render.slice(0, 1800), /serverRows\(servers\)/);
    assert.match(render.slice(0, 1800), /server-group-title/);
    assert.match(watchCss, /\.server-group\{/);
    assert.match(watchCss, /\.server-group-title\{/);
    assert.match(watchCss, /\.server-option select\{/);
});

test('watch: kelompok baris per bahasa & opsi situs disebut di keterangan', () => {
    assert.match(watchCode, /const LANG_GROUP = \{/);
    assert.match(watchCode, /id: \{ title: 'Sub Indo', hint: 'AnimeKu & Animeloverz' \}/);
    assert.match(watchCode, /en: \{ title: 'Subtitle Inggris'/);
    assert.match(watchCode, /dub: \{ title: 'Dub', hint: 'sulih suara' \}/);
    assert.match(watchCode, /\.\.\.\(group && !s\.group \? \{ group: group\.title, groupHint: group\.hint \} : \{\}\)/);
    assert.match(watchCode, /`opsi: \$\{s\.options\.map\(\(option\) => option\.label\)\.join\(' \/ '\)\}`/);
});

/* ------------------------------------------------------------------ */
/* 4 · Bahasa dub                                                     */
/* ------------------------------------------------------------------ */
test('dub: badge, urutan, dan kontrak API mendukung sulih suara', () => {
    assert.match(watchCode, /const LANG_BADGE = \{ id: 'Sub Indo', en: 'Sub Eng', multi: 'Multi Sub', dub: 'Dub' \};/);
    assert.match(watchCode, /dub: 'Sulih suara \(dub\)/);
    assert.match(read('js/api/streams.js'), /const LANG_RANK = \{ multi: 0, id: 1, en: 2, dub: 3 \};/);
    assert.match(animeLib, /const LANG_ORDER = \{ multi: 0, id: 1, en: 2, dub: 3 \};/);
    assert.match(sourcesJs, /lang: \['id', 'en', 'multi', 'dub'\]\.includes\(x\.lang\) \? x\.lang : ''/);
    // Grup baris ikut dikirim backend → frontend.
    assert.match(animeLib, /\.\.\.\(s\.group \? \{ group: clip\(s\.group, 20\) \} : \{\}\)/);
    assert.match(sourcesJs, /\.\.\.\(x\.group \? \{ group: String\(x\.group\)\.slice\(0, 20\) \} : \{\}\)/);
});

test('watch: dub dipisahkan dari Sub Eng di urutan pemutaran', () => {
    assert.match(watchCode, /const local = rest\.filter\(\(s\) => !\['en', 'multi', 'dub'\]\.includes\(s\.lang\)\);/);
    assert.match(watchCode, /const dub = \[\.\.\.rest\.filter\(\(s\) => s\.lang === 'dub'\), \.\.\.fallback\.filter\(\(s\) => s\.lang === 'dub'\)\];/);
    assert.match(watchCode, /\.\.\.english, \.\.\.dub\]\)/);
});

/* ------------------------------------------------------------------ */
/* 5 · Bukti pemeriksaan Aniwaves (tanpa bypass)                      */
/* ------------------------------------------------------------------ */
test('aniwaves: tidak ada adapter yang memanggil endpoint terlarang', () => {
    assert.ok(!fs.existsSync(path.join(root, 'server/sources/aniwaves.js')), 'adapter aniwaves belum ditambahkan');
    const doc = read('docs/ANIWAVES.md');
    assert.match(doc, /ajax\/episode\/list/);
    assert.match(doc, /vrf/);
    assert.match(doc, /Disallow: \/ajax/);
    assert.match(doc, /tidak\s+diimplementasikan/i);
    assert.ok(fs.existsSync(path.join(root, 'server/scripts/probe-aniwaves.js')), 'skrip pemeriksaan tetap ada');
    const probe = read('server/scripts/probe-aniwaves.js');
    assert.match(probe, /KazanimeBot\/1\.0/);
    assert.doesNotMatch(probe, /ajax\/(sources|server\/list|episode\/list)/, 'probe tidak memanggil endpoint terlarang');
});
