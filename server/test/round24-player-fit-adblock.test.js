/**
 * Kazanime — round24-player-fit-adblock.test.js
 * Putaran 24 (25 Okt 2026).
 *
 * Permintaan pengguna: *"di animeku kepotong tolong perbaiki dan sediakan tombol blokir di
 * animeku dan animeloverz juga"*.
 *
 * Dua hal yang dikunci tes ini:
 *
 * A. **Player tidak boleh "kepotong" lagi.**
 *    Laporan bergambar menunjukkan kotak player tidak 16:9 (lebar ± 70% halaman tetapi tinggi
 *    mengikuti lebar halaman). Penyebabnya cara lama: `padding-top:56.25%` dihitung dari lebar
 *    wadah INDUK, bukan lebar elemen player. Sekarang:
 *      - `aspect-ratio:16/9` (memakai lebar elemen sendiri) + `padding-top:0`,
 *      - `padding-top:56.25%` tetap ada sebagai cadangan peramban tua (`@supports not`),
 *      - `min-width:100%` / `grid-column:1/-1` / `flex:1 0 auto` mencegah player dipersempit,
 *      - `overflow:hidden` + `max-width/max-height:100%` pada stage & iframe supaya isi pemutar
 *        tidak meluber keluar kotak.
 *
 * B. **Tombol blokir untuk AnimeKu & Animeloverz** (membalik aturan tampil putaran 15, TANPA
 *    melepas pengaman putaran 13/15/19):
 *      - tombol tampil untuk semua server iframe (`isFrameServer`), termasuk Sub Indo,
 *      - pilihan disimpan per server (`kz:adblock-off`), bawaan menyala,
 *      - sandbox Sub Indo tetap dipasang (`applyFramePolicy`/`applyStrictFramePolicy`),
 *      - tidak ada `allow-popups` / `allow-top-navigation` / `removeAttribute('sandbox')`.
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
const watchCss = read('css/watch.css');
const adGuideJs = read('js/ui/ad-guide.js');

/* ------------------------------------------------------------------ */
/* A · Tata letak player: selalu 16:9 dan selebar halaman              */
/* ------------------------------------------------------------------ */
test('css: kotak player memakai lebar elemen sendiri (aspect-ratio 16:9)', () => {
    const base = watchCss.match(/\n\.streaming-player-wrapper\{([^}]*)\}/)?.[1] || '';
    assert.ok(base, 'aturan dasar .streaming-player-wrapper ada');
    // Pencegah player dipersempit wadah (dulu tampak 70% lebar halaman).
    assert.match(base, /width:100%/);
    assert.match(base, /min-width:100%/);
    assert.match(base, /grid-column:1\/-1/);
    assert.match(base, /flex:1 0 auto/);
    // Isi player tidak boleh meluber keluar kotak.
    assert.match(base, /overflow:hidden/);
    // Cadangan lama tetap ada untuk peramban tanpa aspect-ratio.
    assert.match(base, /padding-top:56\.25%/);

    // Dengan dukungan aspect-ratio, padding-top dimatikan supaya tinggi = 16:9 lebar sendiri.
    const support = watchCss.match(/@supports \(aspect-ratio:16\/9\)\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.ok(support, 'blok @supports aspect-ratio ada');
    assert.match(support, /\.streaming-player-wrapper\{padding-top:0;aspect-ratio:16\/9;height:auto\}/);
});

test('css: stage & iframe mengisi kotak player tanpa meluber', () => {
    const rule = watchCss.match(/\.streaming-player-wrapper iframe,\.streaming-player-wrapper>div\{([^}]*)\}/)?.[1] || '';
    assert.ok(rule, 'aturan stage/iframe ada');
    assert.match(rule, /position:absolute/);
    assert.match(rule, /width:100%/);
    assert.match(rule, /height:100%/);
    assert.match(rule, /max-width:100%/);
    assert.match(rule, /max-height:100%/);
    assert.match(watchCss, /\.streaming-player-wrapper>#playerStage\{overflow:hidden\}/);
    // Layar penuh tetap mengisi viewport (aspect-ratio tidak boleh mengunci tingginya).
    const fs = watchCss.match(/\.streaming-player-wrapper:fullscreen,\n\.streaming-player-wrapper:-webkit-full-screen\{([^}]*)\}/)?.[1] || '';
    assert.ok(fs, 'aturan layar penuh ada');
    assert.match(fs, /aspect-ratio:auto/);
    assert.match(fs, /height:100vh/);
});

test('watch: aset halaman memakai versi di URL supaya CSS lama tidak dipakai peramban', () => {
    assert.match(watchHtml, /href="css\/watch\.css\?v=\d{8}[a-z]?"/);
    assert.match(watchHtml, /href="css\/base\.css\?v=\d{8}[a-z]?"/);
    assert.match(watchHtml, /href="css\/components\.css\?v=\d{8}[a-z]?"/);
    assert.match(watchHtml, /src="js\/watch\.js\?v=\d{8}[a-z]?"/);
});

/* ------------------------------------------------------------------ */
/* B · Tombol blokir untuk AnimeKu & Animeloverz                       */
/* ------------------------------------------------------------------ */
test('config: lapisan blokir Sub Indo punya default sendiri (tetap menyala)', () => {
    const block = configJs.match(/subIndoGuard: Object\.freeze\(\{([\s\S]*?)\}\),/)?.[1] || '';
    assert.ok(block, 'blok subIndoGuard ada');
    assert.match(block, /shieldDefault: true/);
    // Sandbox AnimeKu/Oploverz tidak berubah (tanpa allow-popups / allow-top-navigation).
    const frame = configJs.match(/frameGuard: Object\.freeze\(\{([\s\S]*?)\n    \}\),/)?.[1] || '';
    assert.match(frame, /subIndoSources: Object\.freeze\(\['animeku', 'oploverz'\]\)/);
    assert.match(frame, /strictSources: Object\.freeze\(\['animeku'\]\)/);
    // Komentar menyebut allow-popups (dokumentasi), jadi yang diperiksa hanya nilainya.
    const frameCode = stripComments(frame);
    assert.doesNotMatch(frameCode, /allow-popups|allow-top-navigation/);
    const strict = frameCode.match(/strictPolicy: '([^']+)'/)?.[1] || '';
    assert.ok(strict.includes('allow-scripts') && strict.includes('allow-same-origin'));
    assert.ok(!strict.includes('allow-forms') && !strict.includes('allow-downloads'));
});

test('player: tombol blokir tampil untuk semua server iframe (termasuk AnimeKu/Animeloverz)', () => {
    assert.match(playerCode, /function isFrameServer\(server\) \{/);
    assert.match(playerCode, /return Boolean\(server\) && server\.kind !== 'hls' && server\.kind !== 'video';/);
    assert.match(playerCode, /function isExternalServer\(server\) \{\n    if \(!isFrameServer\(server\)\) return false;\n    return !isSubIndoServer\(server\);\n\}/);

    const sync = playerCode.slice(playerCode.indexOf('function syncAdBlockToggle'), playerCode.indexOf('function syncAdBlockToggle') + 1400);
    assert.match(sync, /const show = isFrameServer\(server\) && Boolean\(server\.url\)/);
    assert.match(sync, /const subIndo = isSubIndoServer\(server\);/);
    // Petunjuk berbeda: Sub Indo menegaskan sandbox tetap aktif.
    assert.match(sync, /tetap memakai sandbox; tombol ini hanya mematikan lapisan blokir iklan Kazanime/);
});

test('player: pilihan blokir diingat per server, bawaan menyala untuk Sub Indo', () => {
    const fn = playerCode.slice(playerCode.indexOf('function adBlockEnabled'), playerCode.indexOf('function adBlockEnabled') + 900);
    assert.match(fn, /if \(!isFrameServer\(server\)\) return true;/);
    assert.match(fn, /const saved = readAdBlockOff\(\);/);
    assert.match(fn, /if \(isSubIndoServer\(server\)\) return PLAYER\.subIndoGuard\?\.shieldDefault !== false;/);
    assert.match(fn, /return PLAYER\.externalGuard\?\.shieldDefault !== false;/);
    // Pilihan tetap disimpan per id server (bukan per situs) supaya tiap server bisa beda.
    assert.match(playerCode, /function writeAdBlockOff\(serverId, off\)/);
    assert.match(playerCode, /storage\.set\(STORAGE_KEYS\.adBlockOff, all\);/);
});

test('player: klik tombol hanya mengubah lapisan anti-iklan, sandbox tetap dipasang', () => {
    const handler = playerCode.slice(playerCode.indexOf("adBlockBtn?.addEventListener"), playerCode.indexOf("adBlockBtn?.addEventListener") + 1200);
    assert.match(handler, /if \(!isFrameServer\(server\)\) return;/);
    assert.match(handler, /writeAdBlockOff\(server\.id, off\)/);
    assert.match(handler, /if \(off\) removeAdShield\(\);/);
    assert.match(handler, /else if \(state === 'playing'\) mountAdShield\(token\);/);
    assert.match(handler, /Sandbox tetap aktif, jadi iklan tetap tidak bisa membuka tab baru/);

    // Pemutus sandbox tetap isSubIndoServer()/externalGuard — bukan tombol blokir.
    assert.match(playerCode, /const guarded = isSubIndoServer\(server\) \|\| PLAYER\.externalGuard\?\.sandbox === true;/);
    assert.match(playerCode, /if \(guarded\) applyFramePolicy\(iframe\);/);
    assert.doesNotMatch(playerCode, /removeAttribute\(['"]sandbox['"]\)/);
    assert.doesNotMatch(playerCode, /allow-popups|allow-top-navigation|allow-modals/);
});

test('player: lapisan anti-iklan hanya dipasang bila blokir untuk server itu menyala', () => {
    const mount = playerCode.slice(playerCode.indexOf('function mountAdShield'), playerCode.indexOf('function mountAdShield') + 900);
    assert.match(mount, /if \(!PLAYER\.adShield \|\| my !== token\) return;/);
    assert.match(mount, /if \(!adBlockEnabled\(current\(\)\)\) return;/);
});

/* ------------------------------------------------------------------ */
/* C · Halaman nonton & panduan                                        */
/* ------------------------------------------------------------------ */
test('watch: tombol blokir menjelaskan cakupannya (AnimeKu, Animeloverz, server luar)', () => {
    const idx = watchHtml.indexOf('id="btnAdBlockToggle"');
    const button = watchHtml.slice(watchHtml.lastIndexOf('<button', idx), watchHtml.indexOf('</button>', idx));
    assert.match(button, /Matikan lapisan blokir iklan Kazanime/);
    assert.match(button, /AnimeKu/);
    assert.match(button, /Animeloverz/);
    assert.ok(/\shidden\b/.test(button), 'tetap disembunyikan sampai ada server aktif');

    const hint = watchHtml.slice(watchHtml.indexOf('class="server-hint"'), watchHtml.indexOf('</p>', watchHtml.indexOf('class="server-hint"')));
    assert.match(hint, /Sub Indo \(AnimeKu &amp; Animeloverz\)/);
    assert.match(hint, /tombol <strong>Matikan blokir<\/strong> di bawah pemutar tersedia untuk mereka juga/);
    assert.match(hint, /sandbox tetap aktif sehingga iklan tetap tidak bisa membuka tab baru/);
});

test('panduan iklan: menyebut tombol blokir untuk AnimeKu & Animeloverz', () => {
    assert.match(adGuideJs, /Tombol “Matikan blokir” untuk AnimeKu, Animeloverz, dan server luar/);
    assert.match(adGuideJs, /sandbox tetap aktif \(tab baru tetap diblokir\)/);
    assert.match(adGuideJs, /Penahan pop-up untuk server Sub Indo/);
    assert.doesNotMatch(adGuideJs, /Mode Aman/);
});

test('tidak ada regresi pengaman iklan putaran 11/19', () => {
    assert.match(configJs, /adShield: true,/);
    assert.match(configJs, /adRepeatBlock: 'kz:adrepeat'/);
    assert.match(playerCode, /const AD_REPEAT_LIMIT = 10;/);
    assert.match(playerCode, /function autoBlocked\(server\)/);
    // Daftar pola iklan tidak ikut berubah.
    assert.match(read('js/services/adblock.js'), /export const AD_HOSTS/);
});
