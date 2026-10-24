/**
 * Kazanime — round13-no-release.test.js
 * Putaran 13 (24 Okt 2026).
 *
 * Permintaan pengguna: *"cek lagi saya sudah merge ya baru coba kamu optimal kan hapus tawaran buka
 * tombol mode aman saat ada di layar stream itu membuat iklan keluar lagi optimisasi lagi"*.
 *
 * Konteks: putaran 12 menaruh tautan **"Video tidak muncul? Muat ulang tanpa pengaman"** di bawah
 * pemutar. Sekali diklik, sandbox dilepas dan host-nya diingat sampai tab ditutup → semua episode
 * berikutnya dimuat TANPA penahan pop-up, sehingga iklan bisa membuka tab baru lagi.
 *
 * Yang dijaga tes ini:
 *  1. Tidak ada tawaran melepas pengaman dalam bentuk apa pun (tombol, tautan, host memory).
 *  2. Sisa data lama (`kz:safe-frame`, `kz:no-sandbox`) dibersihkan saat halaman dibuka sehingga
 *     pengguna yang pernah mengklik tautan itu tidak kembali tanpa perlindungan.
 *  3. Daftar blokir iklan diperluas (host + pola baru) dan tetap konservatif: URL pemutar sah
 *     (Blogger, host embed AnimeKu/Animeloverz) TIDAK ikut diblokir.
 *  4. Daftar di klien (`js/services/adblock.js`) tidak menyimpang dari server
 *     (`server/lib/adblock.js`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { AD_HOSTS, AD_URL_PATTERNS, inspectAdUrl } from '../lib/adblock.js';
import {
    AD_HOSTS as CLIENT_HOSTS,
    AD_URL_PATTERNS as CLIENT_PATTERNS,
    demoteAdRisk,
    inspectAdUrl as clientInspect,
} from '../../js/services/adblock.js';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
/** Kode tanpa komentar — catatan sejarah ("…dihapus") tidak boleh dianggap fitur. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const playerJs = read('js/ui/player.js');
const playerCode = stripComments(playerJs);
const watchJs = read('js/watch.js');
const watchHtml = read('watch.html');
const watchCss = read('css/watch.css');
const configJs = read('js/config.js');

/* ------------------------------------------------------------------ */
/* 1 · Tidak ada tawaran melepas penahan pop-up                       */
/* ------------------------------------------------------------------ */
test('player: tidak ada tautan, tombol, atau fungsi pelepas sandbox', () => {
    for (const forbidden of [
        /releaseFrameGuard/,
        /mountFrameHint/,
        /removeFrameHint/,
        /frameHint/,
        /hintTimer/,
        /guardTimer/,
        /data-frame-action/,
        /Muat ulang tanpa pengaman/,
    ]) {
        assert.doesNotMatch(playerCode, forbidden, `sisa tawaran pelepas: ${forbidden}`);
    }
    assert.doesNotMatch(watchHtml, /playerFrameHint|frame-action/);
    assert.doesNotMatch(watchCss, /player-frame-hint/);
    assert.doesNotMatch(watchJs, /frameHint|releaseFrameGuard/);
});

test('player: sandbox dipasang untuk SETIAP iframe dan tidak pernah dilepas', () => {
    assert.match(playerJs, /function applyFramePolicy\(iframe\) \{/);
    assert.match(playerCode, /iframe\.sandbox\.value = PLAYER\.frameGuard\.policy;/);
    assert.doesNotMatch(playerCode, /removeAttribute\('sandbox'\)/);
    assert.doesNotMatch(playerCode, /hostRefusesSandbox|rememberNoSandboxHost/);
    // Kebijakan tetap tanpa pop-up / top-navigation.
    const policy = configJs.match(/frameGuard: Object\.freeze\(\{[\s\S]{0,600}?policy: '([^']+)'/)?.[1] || '';
    assert.ok(policy.length > 0, 'policy sandbox ada');
    assert.ok(!policy.includes('allow-popups'));
    assert.ok(!policy.includes('allow-top-navigation'));
});

test('player: embed yang menolak sandbox → server berikutnya, pengaman tetap aktif', () => {
    // Jalur timeout iframe: satu-satunya tindakan adalah pindah server (fail), tanpa melepas apa pun.
    const start = playerCode.indexOf('timer = setTimeout(() => {');
    const timeout = playerCode.slice(start, playerCode.indexOf('fail(server, \'timeout\');', start) + 60);
    assert.ok(timeout.length > 60, 'blok timeout iframe ada');
    assert.match(timeout, /fail\(server, 'timeout'\)/);
    assert.doesNotMatch(timeout, /removeAttribute\(|applyFramePolicy|play\(server\)/);
    // Tidak ada timer pelepasan yang tersisa di jalur pemutaran.
    assert.doesNotMatch(playerCode, /releaseAfterMs|PLAYER\.frameGuard\.hintAfterMs/);
});

/* ------------------------------------------------------------------ */
/* 2 · Sisa data lama dibersihkan                                     */
/* ------------------------------------------------------------------ */
test('config: kunci lama hanya dikenali untuk dibersihkan', () => {
    assert.match(configJs, /legacyNoSandbox: 'kz:no-sandbox'/);
    assert.match(configJs, /legacySafeFrame: 'kz:safe-frame'/);
    assert.doesNotMatch(configJs, /noSandboxHosts:/, 'daftar host tanpa sandbox tidak dipakai lagi');
    assert.doesNotMatch(configJs, /releaseAfterMs|hintAfterMs|memoryLimit/);
});

test('player: pembersihan kunci lama berjalan saat modul dimuat', () => {
    const drop = playerJs.slice(playerJs.indexOf('function dropLegacyGuardFlag'), playerJs.indexOf('dropLegacyGuardFlag();'));
    assert.match(drop, /STORAGE_KEYS\.popupGuard/);
    assert.match(drop, /STORAGE_KEYS\.legacySafeFrame/);
    assert.match(drop, /STORAGE_KEYS\.legacyNoSandbox/);
    // localStorage DAN sessionStorage dibersihkan (putaran 12 menyimpan daftar di sessionStorage).
    assert.match(drop, /localStorage\?\.removeItem\(STORAGE_KEYS\.legacyNoSandbox\)/);
    assert.match(drop, /sessionStorage\?\.removeItem\(STORAGE_KEYS\.legacyNoSandbox\)/);
    assert.match(playerJs, /\ndropLegacyGuardFlag\(\);/);
});

/* ------------------------------------------------------------------ */
/* 3 · Daftar blokir diperluas, pemutar sah tidak ikut diblokir       */
/* ------------------------------------------------------------------ */
test('adblock: host jaringan iklan video/popunder baru ikut diblokir', () => {
    for (const host of ['aniview.com', 'adskeeper.com', 'magsrv.com', 'profitableratecpm.com', 'popin.cc']) {
        assert.ok(AD_HOSTS.includes(host), `host ${host} ada di daftar`);
        assert.equal(inspectAdUrl(`https://cdn.${host}/frame.js`).blocked, true, `subdomain ${host} diblokir`);
    }
    assert.ok(AD_HOSTS.length >= 68, 'daftar host bertambah');
});

test('adblock: pola jalur iklan baru diblokir', () => {
    for (const url of [
        'https://x.example/adserver/page',
        'https://x.example/adsrv/1',
        'https://x.example/smartlink/abc',
        'https://x.example/direct-link?id=9',
        'https://x.example/popup/2',
        'https://x.example/newtab',
    ]) {
        assert.equal(inspectAdUrl(url).blocked, true, `harus diblokir: ${url}`);
    }
    assert.ok(AD_URL_PATTERNS.length >= 13);
});

test('adblock: URL pemutar sungguhan tidak ikut diblokir', () => {
    for (const url of [
        // Server Sungguhan dari AnimeKu/Oploverz (dicek 24 Okt 2026).
        'https://puterin.biz/e/JG33kQgedJ',
        'https://putarin.xyz/e/EzzptfvfRd',
        'https://www.blogger.com/video.g?token=AD6v5dzExampleToken',
        'https://play.xtwap.top/cepat2.php?url=abc%2Bdef',
        'https://embed.test/player/1',
    ]) {
        assert.equal(inspectAdUrl(url).blocked, false, `tidak boleh diblokir: ${url}`);
    }
});

test('adblock: daftar klien sama dengan daftar server (tidak menyimpang)', () => {
    assert.deepEqual([...CLIENT_HOSTS], [...AD_HOSTS], 'host klien = host server');
    assert.equal(CLIENT_PATTERNS.length, AD_URL_PATTERNS.length, 'jumlah pola sama');
    for (const url of [
        'https://cdn.magsrv.com/a.js',
        'https://x.example/adserver/page',
        'https://puterin.biz/e/JG33kQgedJ',
    ]) {
        assert.equal(clientInspect(url).blocked, inspectAdUrl(url).blocked, `putusan sama untuk ${url}`);
    }
});

/* ------------------------------------------------------------------ */
/* 4 · Server berisiko tidak pernah tampil paling depan                */
/* ------------------------------------------------------------------ */
test('watch: server berisiko ditaruh paling belakang (pemutaran otomatis memakai yang bersih)', () => {
    assert.match(watchJs, /import \{ filterAdServers, checkHosts, adHostMatch, demoteAdRisk \}/);
    assert.match(watchJs, /demoteAdRisk\(flagged, \(server\) => Boolean\(server\.adRisk\)\)/);
    assert.match(watchJs, /adHostMatch\(host\)/, 'host daftar blokir lokal langsung ditandai, tanpa menunggu DoH');
});

test('demoteAdRisk: urutan stabil, berisiko di belakang, tetap bisa dipilih', () => {
    const list = [
        { id: 'a', url: 'https://ads.example/1', adRisk: true },
        { id: 'b', url: 'https://puterin.biz/e/1' },
        { id: 'c', url: 'https://cdn.popads.net/x', adRisk: true },
        { id: 'd', url: 'https://ok.test/e/2' },
    ];
    const out = demoteAdRisk(list, (server) => Boolean(server.adRisk));
    assert.deepEqual(out.map((s) => s.id), ['b', 'd', 'a', 'c'], 'server bersih dulu, lalu berisiko (urutan asli)');
    assert.equal(out.length, list.length, 'tidak ada server yang dibuang');
    // Semua berisiko → urutan tidak diubah (tidak ada pilihan lain).
    const allRisk = list.filter((s) => s.adRisk);
    assert.deepEqual(demoteAdRisk(allRisk, (s) => Boolean(s.adRisk)).map((s) => s.id), ['a', 'c']);
    // Tanpa server berisiko → tidak ada perubahan.
    const clean = list.filter((s) => !s.adRisk);
    assert.deepEqual(demoteAdRisk(clean, (s) => Boolean(s.adRisk)).map((s) => s.id), ['b', 'd']);
});
