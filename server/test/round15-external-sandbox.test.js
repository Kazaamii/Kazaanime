/**
 * Kazanime — round15-external-sandbox.test.js
 * Putaran 15 (24 Okt 2026).
 *
 * Permintaan pengguna: *"oke dah ketemu kesalahan dimana server Yang sub English tidak boleh ada
 * sandbox saya sarankan untuk semua server selain dari anime ku dan oploverz ada tombol matikan
 * fitur block nya khusus server luar seperti anilist dan kitsu. perbaiki. lagi"*.
 *
 * Aturan yang dijaga:
 *  1. **Sandbox hanya untuk AnimeKu & Oploverz.** Server luar — AniList/Kitsu (MegaPlay, Vidnest,
 *     TryEmbed), ReAnime, AniZone — dimuat TANPA sandbox supaya embed Sub English bisa berjalan.
 *  2. **Tombol "Matikan blokir" hanya untuk server luar.** Tombol tidak pernah muncul untuk
 *     AnimeKu/Oploverz; pilihannya diingat per server (`kz:adblock-off`).
 *  3. **Tidak ada sisa tawaran pelepas untuk server Sub Indo** (aturan putaran 13 tetap).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const playerJs = read('js/ui/player.js');
const playerCode = stripComments(playerJs);
const configJs = read('js/config.js');
const watchHtml = read('watch.html');
const watchJs = read('js/watch.js');
const watchCss = read('css/watch.css');
const adGuideJs = read('js/ui/ad-guide.js');
const iconsJs = read('js/ui/icons.js');

/* ------------------------------------------------------------------ */
/* 1 · Konfigurasi kelompok server                                     */
/* ------------------------------------------------------------------ */
test('config: sandbox hanya untuk sumber Sub Indo (AnimeKu & Oploverz)', () => {
    const block = configJs.match(/frameGuard: Object\.freeze\(\{([\s\S]*?)\n    \}\),/)?.[1] || '';
    assert.ok(block, 'blok frameGuard ada');
    const list = block.match(/subIndoSources: Object\.freeze\(\[([^\]]*)\]\)/)?.[1] || '';
    assert.match(list, /'animeku'/, 'AnimeKu termasuk server ber-sandbox');
    assert.match(list, /'oploverz'/, 'Oploverz termasuk server ber-sandbox');
    assert.equal((list.match(/'/g) || []).length / 2, 2, 'tepat dua sumber: AnimeKu & Oploverz');
    // Server luar (AniList/Kitsu, ReAnime, AniZone) tidak boleh masuk daftar ber-sandbox.
    for (const luar of ['anilist', 'kitsu', 'megaplay', 'vidnest', 'tryembed', 'reanime', 'anizone']) {
        assert.ok(!list.includes(`'${luar}'`), `${luar} tidak boleh ber-sandbox`);
    }
});

test('config: kebijakan server luar (tanpa sandbox, lapisan anti-iklan tetap, batas ingatan)', () => {
    assert.match(configJs, /externalGuard: Object\.freeze\(\{/);
    const block = configJs.match(/externalGuard: Object\.freeze\(\{([\s\S]*?)\}\),/)?.[1] || '';
    assert.match(block, /sandbox: false/, 'server luar tanpa sandbox');
    assert.match(block, /shieldDefault: true/, 'lapisan anti-iklan tetap dipasang');
    assert.match(block, /maxServers: 40/, 'ingatan pilihan dibatasi');
    assert.match(configJs, /adBlockOff: 'kz:adblock-off'/);
});

/* ------------------------------------------------------------------ */
/* 2 · Kode player                                                     */
/* ------------------------------------------------------------------ */
test('player: sandbox dipasang hanya untuk server Sub Indo, server luar diberi tanda off', () => {
    assert.match(playerCode, /function isSubIndoServer\(server\)/);
    assert.match(playerCode, /PLAYER\.frameGuard\.subIndoSources/);
    assert.match(playerCode, /const guarded = isSubIndoServer\(server\) \|\| PLAYER\.externalGuard\?\.sandbox === true;/);
    assert.match(playerCode, /if \(guarded\) applyFramePolicy\(iframe\);/);
    assert.match(playerCode, /else iframe\.dataset\.frameGuard = 'off';/);
    // Tidak ada jalur yang melepas sandbox setelah dipasang (aturan putaran 13 tetap).
    assert.doesNotMatch(playerCode, /removeAttribute\('sandbox'\)/);
    // Server Sub Indo tidak pernah jatuh ke cabang "tanpa sandbox".
    const start = playerCode.indexOf('iframe.referrerPolicy = PLAYER.referrerPolicy;');
    const playBlock = playerCode.slice(start, playerCode.indexOf('syncAdBlockToggle();', start));
    assert.ok(playBlock.includes('isSubIndoServer(server)'), 'keputusan sandbox memakai sumber server');
    assert.ok(!playBlock.includes('sandbox.value'), 'server luar tidak pernah mendapat atribut sandbox');
});

test('player: tombol "Matikan blokir" tampil untuk server luar DAN Sub Indo (putaran 24)', () => {
    assert.match(playerCode, /function isExternalServer\(server\)/);
    assert.match(playerCode, /function isFrameServer\(server\)/);
    assert.match(playerCode, /function syncAdBlockToggle\(\)/);
    // Server HLS/native dikecualikan (tidak memakai iframe/lapisan anti-iklan).
    const frame = playerCode.slice(playerCode.indexOf('function isFrameServer'), playerCode.indexOf('function isFrameServer') + 300);
    assert.match(frame, /kind !== 'hls'/);
    assert.match(frame, /kind !== 'video'/);
    // Putaran 24: tombol memakai isFrameServer() sehingga AnimeKu/Animeloverz ikut punya tombol.
    const sync = playerCode.slice(playerCode.indexOf('function syncAdBlockToggle'), playerCode.indexOf('function syncAdBlockToggle') + 700);
    assert.match(sync, /const show = isFrameServer\(server\)/);
    assert.match(sync, /const subIndo = isSubIndoServer\(server\);/);
    // Tombol disembunyikan saat tidak ada server aktif / server belum punya URL.
    assert.match(playerCode, /adBlockBtn\.hidden = !show;/);
    assert.match(playerCode, /adBlockBtn\.setAttribute\('aria-pressed', off \? 'false' : 'true'\)/);
    assert.match(playerCode, /const off = !adBlockEnabled\(server\);/);
});

test('player: mematikan blokir melepas lapisan anti-iklan server itu & disimpan per server', () => {
    assert.match(playerCode, /function isAdBlockOff\(serverId\)/);
    assert.match(playerCode, /function writeAdBlockOff\(serverId, off\)/);
    assert.match(playerCode, /function adBlockEnabled\(server\)/);
    assert.match(playerCode, /STORAGE_KEYS\.adBlockOff/);
    // Server HLS/native selalu aktif. Putaran 24: Sub Indo & server luar mengikuti pilihan
    // pengguna, dengan default dari config masing-masing.
    const enabledFn = playerCode.slice(playerCode.indexOf('function adBlockEnabled'), playerCode.indexOf('function adBlockEnabled') + 900);
    assert.match(enabledFn, /if \(!isFrameServer\(server\)\) return true;/);
    assert.match(enabledFn, /if \(isSubIndoServer\(server\)\) return PLAYER\.subIndoGuard\?\.shieldDefault !== false;/);
    assert.match(enabledFn, /PLAYER\.externalGuard\?\.shieldDefault/);
    // mountAdShield menghormati pilihan pengguna.
    const mount = playerCode.slice(playerCode.indexOf('function mountAdShield'), playerCode.indexOf('function mountAdShield') + 700);
    assert.match(mount, /adBlockEnabled\(current\(\)\)/);
    // Handler tombol: tulis pilihan, lepas/pasang lapisan, perbarui tombol.
    const handler = playerCode.slice(playerCode.indexOf("adBlockBtn?.addEventListener"), playerCode.indexOf("adBlockBtn?.addEventListener") + 900);
    assert.match(handler, /writeAdBlockOff\(server\.id, off\)/);
    assert.match(handler, /removeAdShield\(\)/);
    assert.match(handler, /mountAdShield\(token\)/);
    assert.match(handler, /if \(!isFrameServer\(server\)\) return;/, 'tombol berlaku untuk semua server iframe');
    // Putaran 24: pesan untuk Sub Indo menegaskan sandbox tetap aktif (tab baru tetap diblokir).
    assert.match(handler, /Sandbox tetap aktif, jadi iklan tetap tidak bisa membuka tab baru/);
});

/* ------------------------------------------------------------------ */
/* 3 · Halaman nonton                                                  */
/* ------------------------------------------------------------------ */
test('watch: tombol #btnAdBlockToggle ada di baris kontrol, tersembunyi sampai server aktif', () => {
    const idx = watchHtml.indexOf('id="btnAdBlockToggle"');
    assert.ok(idx > -1, 'tombol ada di watch.html');
    const button = watchHtml.slice(watchHtml.lastIndexOf('<button', idx), watchHtml.indexOf('</button>', idx));
    assert.match(button, /class="player-ctrl-btn player-ctrl-btn--adblock"/);
    assert.ok(/\shidden\b/.test(button), 'disembunyikan secara default');
    assert.match(button, /aria-pressed="true"/);
    assert.match(button, /data-icon="shield-off"/);
    assert.match(button, /data-toggle-label>Matikan blokir</);
    // Urutan: setelah Server Lain, sebelum Layar Penuh (pola putaran 12 tidak berubah).
    assert.ok(idx > watchHtml.indexOf('id="btnNextServer"'));
    assert.ok(idx < watchHtml.indexOf('id="btnFullscreen"'));
    // Player menerima elemennya.
    assert.match(watchJs, /adBlockBtn: \$\('#btnAdBlockToggle'\)/);
});

test('watch: petunjuk server menjelaskan aturan sandbox yang baru', () => {
    const hint = watchHtml.slice(watchHtml.indexOf('class="server-hint"'), watchHtml.indexOf('</p>', watchHtml.indexOf('class="server-hint"')));
    assert.match(hint, /Sub Indo \(AnimeKu &amp; Animeloverz\)/);
    assert.match(hint, /tanpa sandbox/);
    assert.match(hint, /Matikan blokir/);
    assert.match(watchCss, /\.player-ctrl-btn--adblock\{/);
    assert.match(watchCss, /\.player-ctrl-btn--adblock:hover/);
    assert.match(iconsJs, /'shield-off':/);
});

test('ad guide: menjelaskan sandbox Sub Indo & tombol untuk server luar', () => {
    assert.match(adGuideJs, /Penahan pop-up/);
    assert.match(adGuideJs, /Penahan pop-up untuk server Sub Indo/);
    assert.match(adGuideJs, /Matikan blokir/);
    assert.match(adGuideJs, /tanpa sandbox/);
    assert.doesNotMatch(adGuideJs, /Mode Aman/);
});

/* ------------------------------------------------------------------ */
/* 4 · Tidak ada regresi pengaman Sub Indo                             */
/* ------------------------------------------------------------------ */
test('player: tombol Sub Indo tidak melepas sandbox (putaran 24 tetap penuh)', () => {
    // Putaran 24 membalik aturan tampil (tombol juga untuk Sub Indo), TAPI sandbox tetap
    // dipasang: penentu sandbox masih isSubIndoServer(), bukan tombol blokir.
    assert.match(playerCode, /const guarded = isSubIndoServer\(server\) \|\| PLAYER\.externalGuard\?\.sandbox === true;/);
    assert.doesNotMatch(playerCode, /adBlockEnabled\(server\)[^;]*\)\s*\?\s*applyFramePolicy/);
    const ext = playerCode.slice(playerCode.indexOf('function isExternalServer'), playerCode.indexOf('function isExternalServer') + 400);
    assert.match(ext, /!isSubIndoServer\(server\)/);
    // Tidak ada lagi tombol/tautan pelepas sandbox gaya putaran 12–13.
    assert.doesNotMatch(playerCode, /releaseFrameGuard|mountFrameHint|frameHint|data-frame-action/);
    assert.doesNotMatch(watchHtml, /playerFrameHint|frame-action|btnSafeMode/);
    assert.doesNotMatch(watchCss, /player-frame-hint/);
    // Lapisan anti-iklan global (PLAYER.adShield) tetap ada.
    assert.match(configJs, /adShield: true,/);
});
