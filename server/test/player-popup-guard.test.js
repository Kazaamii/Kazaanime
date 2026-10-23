import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Proteksi pop-up player (24 Okt 2026, permintaan adblock "bila memungkinkan").
 *
 * Iframe embed dipasang dengan atribut sandbox TANPA allow-popups /
 * allow-top-navigation, jadi skrip iklan di dalam player tidak bisa membuka tab
 * baru atau membajak tab Kazanime. Pengguna bisa melepas proteksi lewat tombol
 * di bawah player (preferensi disimpan), karena sebagian embed menolak sandbox.
 */
const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const configJs = read('js/config.js');
const playerJs = read('js/ui/player.js');
const watchHtml = read('watch.html');
const watchJs = read('js/watch.js');

test('config: sandbox default memblokir pop-up & navigasi tab', () => {
    const sandbox = /sandbox: '([^']*)'/.exec(configJs)?.[1] || '';
    assert.match(sandbox, /allow-scripts/, 'skrip player tetap boleh jalan');
    assert.match(sandbox, /allow-same-origin/, 'player tetap bisa memakai storage/cookie-nya');
    assert.doesNotMatch(sandbox, /allow-popups/, 'pop-up harus diblokir');
    assert.doesNotMatch(sandbox, /allow-top-navigation/, 'iframe tidak boleh mengalihkan tab Kazanime');
    assert.match(configJs, /popupGuard: 'kz:popup-guard'/);
});

test('player: sandbox hanya dipasang saat proteksi aktif + atribut status', () => {
    assert.match(playerJs, /function popupGuardDisabled\(\)/);
    assert.match(playerJs, /window\.localStorage\.getItem\(STORAGE_KEYS\.popupGuard\) === 'off'/);
    assert.match(playerJs, /if \(!popupGuardDisabled\(\) && PLAYER\.sandbox\) iframe\.setAttribute\('sandbox', PLAYER\.sandbox\)/);
    assert.match(playerJs, /iframe\.dataset\.popupGuard = popupGuardDisabled\(\) \? 'off' : 'on'/);
    assert.match(playerJs, /popupGuard: \(\) => !popupGuardDisabled\(\)/);
    assert.match(playerJs, /setPopupGuard\(enabled\)/);
    assert.match(playerJs, /emit\('guard', \{ enabled: Boolean\(enabled\) \}\)/);
});

test('watch: tombol status proteksi pop-up tersedia & tersambung ke player', () => {
    assert.match(watchHtml, /id="btnPopupGuard" aria-pressed="true"/);
    assert.match(watchHtml, /id="btnPopupGuardText">Pop-up diblokir</);
    assert.match(watchJs, /popupGuard: \$\('#btnPopupGuard'\)/);
    assert.match(watchJs, /player\.setPopupGuard\(!player\.popupGuard\(\)\)/);
    assert.match(watchJs, /player\.on\('guard', \(\{ enabled \}\) => renderPopupGuard\(enabled\)\)/);
    assert.match(configJs, /Server `kind: 'hls' \| 'video'` memakai <video> sendiri — tanpa iframe, tanpa pop-up\./);
});
