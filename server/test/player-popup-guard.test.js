import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Proteksi pop-up player — putaran 3 (24 Okt 2026).
 *
 * Riwayat: sandbox iframe dinyalakan untuk menahan iklan ("bila memungkinkan"), tetapi banyak
 * embed menolak berjalan di dalam sandbox dan hanya menampilkan
 * "Opss! Sandboxed our player is not allowed. Remove sandbox to use it." — video dan subtitle
 * tidak muncul sama sekali. Perbaikannya:
 *   1. mode sandbox DEFAULT MATI (hanya aktif bila pengguna menyalakannya);
 *   2. host yang menolak sandbox dikecualikan otomatis (sandboxFor/sandboxRefused);
 *   3. iframe ber-sandbox yang gagal dimuat dicoba ulang tanpa sandbox, bukan langsung dialihkan
 *      ke layar "streaming tidak tersedia";
 *   4. tombol di bawah player tetap ada untuk menyalakan/mematikan mode ketat.
 */
const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const configJs = read('js/config.js');
const playerJs = read('js/ui/player.js');
const watchHtml = read('watch.html');
const watchJs = read('js/watch.js');

test('config: nilai sandbox (mode ketat) tetap tanpa pop-up & navigasi tab', () => {
    const sandbox = /sandbox: '([^']*)'/.exec(configJs)?.[1] || '';
    assert.match(sandbox, /allow-scripts/, 'skrip player tetap boleh jalan');
    assert.match(sandbox, /allow-same-origin/, 'player tetap bisa memakai storage/cookie-nya');
    assert.doesNotMatch(sandbox, /allow-popups/, 'pop-up harus diblokir saat mode ketat aktif');
    assert.doesNotMatch(sandbox, /allow-top-navigation/, 'iframe tidak boleh mengalihkan tab Kazanime');
    assert.match(configJs, /popupGuard: 'kz:popup-guard'/);
    // Default mati: kunci penyimpanan hanya bernilai 'on' untuk mode ketat.
    assert.match(configJs, /'on' = pengguna menyalakan mode blokir pop-up\/sandbox \(default mati/);
    assert.match(configJs, /24 Okt 2026 \(putaran 3\): mode ini DEFAULT MATI/);
});

test('player: sandbox hanya dipasang lewat sandboxFor(), default mati', () => {
    assert.match(playerJs, /function popupGuardEnabled\(\)/);
    assert.match(playerJs, /window\.localStorage\.getItem\(STORAGE_KEYS\.popupGuard\) === 'on'/);
    assert.match(playerJs, /const sandboxRefused = new Set\(\);/);
    assert.match(playerJs, /function sandboxFor\(server\) \{/);
    assert.match(playerJs, /const sandboxed = sandboxFor\(server\);/);
    assert.match(playerJs, /if \(sandboxed\) iframe\.setAttribute\('sandbox', PLAYER\.sandbox\);/);
    assert.match(playerJs, /iframe\.dataset\.popupGuard = sandboxed \? 'on' : 'off';/);
    assert.match(playerJs, /popupGuard: \(\) => popupGuardEnabled\(\)/);
    assert.match(playerJs, /setPopupGuard\(enabled\)/);
    assert.match(playerJs, /emit\('guard', \{ enabled: Boolean\(enabled\) \}\)/);
    // Tidak ada lagi jalur lama yang memasang sandbox secara default.
    assert.doesNotMatch(playerJs, /popupGuardDisabled/);
});

test('player: embed yang menolak sandbox dicoba ulang tanpa sandbox', () => {
    // Saat iframe ber-sandbox gagal dimuat: host dicatat lalu server yang sama dimuat ulang.
    assert.match(playerJs, /if \(sandboxed\) \{[\s\S]{0,400}sandboxRefused\.add\(host\);/);
    assert.match(playerJs, /Mode blokir pop-up dimatikan untuk player ini/);
    assert.match(playerJs, /play\(server\);\s*\n\s*return;/, 'server yang sama dicoba lagi tanpa sandbox');
});

test('player: subtitle default dinyalakan eksplisit untuk Chrome', () => {
    assert.match(playerJs, /track\.setAttribute\('default', ''\)/);
    assert.match(playerJs, /const showDefaultSubtitle = \(\) => \{/);
    assert.match(playerJs, /target\.mode = 'showing'/);
    assert.match(playerJs, /v\.addEventListener\('loadedmetadata', showDefaultSubtitle\)/);
    // iPad (WebKit) + ManagedMediaSource + subtitle → hls.js supaya <track> tampil.
    assert.match(playerJs, /const preferMseForSubtitles = appleWebKit && hasMse && subs\.length > 0;/);
    assert.match(playerJs, /const native = \(appleWebKit && !preferMseForSubtitles\) \|\| \(canNative && !hasMse\);/);
    assert.match(playerJs, /if \(canNative\) \{\s*\n\s*v\.dataset\.mode = 'native-proxy';/, 'tanpa MSE → fallback native, bukan gagal');
});

test('watch: tombol mode pop-up default "diizinkan" & tersambung ke player', () => {
    assert.match(watchHtml, /id="btnPopupGuard" aria-pressed="false"/);
    assert.match(watchHtml, /id="btnPopupGuardText">Pop-up diizinkan</);
    assert.match(watchJs, /popupGuard: \$\('#btnPopupGuard'\)/);
    assert.match(watchJs, /player\.setPopupGuard\(!player\.popupGuard\(\)\)/);
    assert.match(watchJs, /player\.on\('guard', \(\{ enabled \}\) => renderPopupGuard\(enabled\)\)/);
    assert.match(watchJs, /Mode ketat: pop-up & tab baru dari player diblokir/);
    assert.match(configJs, /Server `kind: 'hls' \| 'video'` memakai <video> sendiri — tanpa iframe, tanpa pop-up\./);
});
