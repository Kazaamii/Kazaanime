/**
 * Kazanime — round18-adblock-repeat.test.js
 * Putaran 18 (24 Okt 2026).
 *
 * Permintaan pengguna: *"Perbaiki Bagian Untuk Block ads yg Animeku dan Oploverz … sedikit
 * perkuat agar popup yg sama tidak muncul"* → penjelasan pengguna: **"(a) muncul setelah ditutup"**.
 *
 * Artinya: popup iklan yang sama kembali lagi setelah ditutup. Untuk server Sub Indo (AnimeKu &
 * Oploverz) yang sudah ber-sandbox, penyebab paling mungkin adalah pemutar memuat ULANG embed yang
 * sama (mis. tombol "Pulihkan pemutar") sehingga skrip iklan menembakkan popup yang sama lagi.
 *
 * Aturan putaran 18 (pola iklan TIDAK diubah — 70 host / 13 pola tetap sama):
 *  1. Pembajakan dihitung PER SERVER dalam jendela waktu (`PLAYER.adTakeover.repeatWindowMs`).
 *  2. Saat batas tercapai: server ditandai `adBlocked`, bilah pemulihan dilepas, pindah server lain.
 *  3. Server bertanda TIDAK dipilih otomatis lagi selama sesi (bisa dipilih manual).
 *  4. Tombol "Pulihkan pemutar" tidak memuat ulang embed yang sudah membajak — pindah server.
 *  5. Sandbox Sub Indo tidak berubah (tidak ada `removeAttribute('sandbox')`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const playerCode = stripComments(read('js/ui/player.js'));
const configJs = read('js/config.js');
const watchJs = stripComments(read('js/watch.js'));
const watchHtml = read('watch.html');
const { AD_HOSTS, AD_URL_PATTERNS } = await import('../../js/services/adblock.js');

/* ------------------------------------------------------------------ */
/* 1 · Pola iklan tetap sama                                           */
/* ------------------------------------------------------------------ */
test('pola iklan tidak berubah (sesuai permintaan: "cukup pola yang sama")', () => {
    assert.equal(AD_HOSTS.length, 70, 'daftar host tidak ditambah/dikurangi');
    assert.equal(AD_URL_PATTERNS.length, 13, 'daftar pola URL tidak ditambah/dikurangi');
    // Cermin server tetap sama isinya.
    const serverLib = read('server/lib/adblock.js');
    for (const host of ['popads.net', 'propellerads.com', 'adsterra.com', 'monetag.com']) {
        assert.ok(serverLib.includes(`'${host}'`), `${host} masih ada di sisi server`);
    }
});

/* ------------------------------------------------------------------ */
/* 2 · Konfigurasi penguatan                                           */
/* ------------------------------------------------------------------ */
test('config: jendela "popup yang sama" & tanda server berulang', () => {
    const block = configJs.match(/adTakeover: Object\.freeze\(\{([\s\S]*?)\n    \}\),/)?.[1] || '';
    assert.ok(block, 'blok adTakeover ada');
    assert.match(block, /repeatWindowMs: 120000/);
    assert.match(block, /blockRepeatServer: true/);
    assert.match(block, /maxTakeovers: 2/);
    assert.match(block, /ignoreWithinMs: 1200/);
});

/* ------------------------------------------------------------------ */
/* 3 · Player: hitung per server & jangan ulangi                       */
/* ------------------------------------------------------------------ */
test('player: pembajakan dihitung per server dalam jendela waktu', () => {
    assert.match(playerCode, /const adBlocked = new Set\(\);/);
    assert.match(playerCode, /const adTakeovers = new Map\(\);/);
    assert.match(playerCode, /const adRepeatWindow = \(\) => PLAYER\.adTakeover\?\.repeatWindowMs \|\| 120000;/);
    assert.match(playerCode, /function noteAdTakeover\(serverId\) \{/);
    assert.match(playerCode, /const list = \(adTakeovers\.get\(serverId\) \|\| \[\]\)\.filter\(\(at\) => now - at < adRepeatWindow\(\)\);/);
    // Dibatasi supaya memori tidak tumbuh (8 entri terakhir per server).
    assert.match(playerCode, /adTakeovers\.set\(serverId, list\.slice\(-8\)\);/);
});

test('player: batas tercapai → server ditandai, pindah server lain', () => {
    const fn = playerCode.slice(playerCode.indexOf('function noteFrameReload('));
    const body = fn.slice(0, fn.indexOf('function notifyRemembered('));
    assert.match(body, /const count = noteAdTakeover\(active\.id\);/);
    assert.match(body, /if \(!autoBlocked\(active\) && count < limit\) \{/, 'pembajakan pertama: tampilkan bilah pemulihan');
    assert.match(body, /blockActiveServer\(active, \{ count \}\);/);
    // Inti penandaan ada di blokActiveServer (dipakai juga jalur popup putaran 19).
    const block = playerCode.slice(playerCode.indexOf('function blockActiveServer('));
    const blockBody = block.slice(0, block.indexOf('function notePopupSignal('));
    assert.match(blockBody, /removeAdRecovery\(\);/);
    assert.match(blockBody, /failed\.add\(active\.id\);/);
    assert.match(blockBody, /adBlocked\.add\(active\.id\);/);
    assert.match(blockBody, /emit\('adblock', \{ type: 'skipped', server: active, count, repeat: true, popup \}\);/);
    assert.match(blockBody, /const next = available\(\)\.find\(\(item\) => item\.id !== active\.id && !failed\.has\(item\.id\) && !autoBlocked\(item\)\);/);
    assert.match(blockBody, /if \(next\) \{\s*play\(next\);/);
});

test('player: server bertanda tidak dipilih otomatis (manual tetap boleh)', () => {
    // pickAuto melewati server bertanda (sesi & antar-halaman — putaran 19).
    const pick = playerCode.slice(playerCode.indexOf('function pickAuto('));
    assert.match(pick.slice(0, 400), /const usable = list\.filter\(\(s\) => !autoBlocked\(s\)\);/);
    // load() & setServers() memakai pickAuto.
    assert.match(playerCode, /const first = keepCurrent \|\| pickAuto\(available\(\)\) \|\| available\(\)\[0\];/);
    assert.match(playerCode, /const next = pickAuto\(available\(\), \{ skipFailed: true \}\);/);
    // nextCandidate() (fallback otomatis) menyaring server bertanda.
    const next = playerCode.slice(playerCode.indexOf('function nextCandidate('));
    assert.match(next.slice(0, 400), /const list = available\(\)\.filter\(\(s\) => !autoBlocked\(s\)\);/);
    // Tombol "Server Lain" (tindakan manual) tetap memakai seluruh daftar.
    assert.match(playerCode, /nextServer\(\) \{\s*const list = available\(\);/);
});

test('player: "Pulihkan pemutar" tidak memuat ulang embed yang sudah membajak', () => {
    const restore = playerCode.slice(playerCode.indexOf("if (action === 'restore')"));
    const body = restore.slice(0, restore.indexOf("} else if (action === 'next')"));
    assert.match(body, /if \(adRepeatSeen\(active\.id\) \|\| autoBlocked\(active\)\) \{/);
    assert.match(body, /adBlocked\.add\(active\.id\);/);
    assert.match(body, /emit\('adblock', \{ type: 'recover', server: active, next: clean \|\| null \}\);/);
    assert.match(body, /if \(clean\) \{\s*play\(clean\);\s*return;/);
});

test('player: retry eksplisit membersihkan ingatan popup', () => {
    const retry = playerCode.slice(playerCode.indexOf('function retry()'));
    assert.match(retry.slice(0, 300), /adBlocked\.clear\(\);/);
    assert.match(retry.slice(0, 300), /adTakeovers\.clear\(\);/);
});

/* ------------------------------------------------------------------ */
/* 4 · Pengaman tidak berubah                                          */
/* ------------------------------------------------------------------ */
test('sandbox Sub Indo tetap utuh (tidak ada pelepasan)', () => {
    assert.match(playerCode, /if \(isSubIndoServer\(server\)\) applyFramePolicy\(iframe\);|const guarded = isSubIndoServer\(server\)/);
    assert.doesNotMatch(playerCode, /removeAttribute\(['"]sandbox['"]\)/);
    assert.doesNotMatch(playerCode, /allow-popups/);
    // Server bertanda tetap ber-sandbox — penandaan hanya soal pemilihan otomatis.
    const guard = configJs.match(/frameGuard: Object\.freeze\(\{([\s\S]*?)\n    \}\),/)?.[1] || '';
    assert.match(guard, /subIndoSources: Object\.freeze\(\['animeku', 'oploverz'\]\)/);
});

/* ------------------------------------------------------------------ */
/* 5 · UI                                                              */
/* ------------------------------------------------------------------ */
test('watch.js: pesan jelas untuk popup berulang & peralihan server', () => {
    const handler = watchJs.slice(watchJs.indexOf("player.on('adblock'"));
    const body = handler.slice(0, 1200);
    assert.match(body, /Iklan yang sama muncul lagi di/);
    assert.match(body, /tidak dicoba otomatis lagi/);
    assert.match(body, /type === 'recover'/);
    assert.match(body, /Beralih ke \$\{next\.name\} supaya popup yang sama tidak terulang/);
    assert.match(watchHtml, /Bila iklan yang sama muncul lagi setelah ditutup, server itu dilewati otomatis/);
});
