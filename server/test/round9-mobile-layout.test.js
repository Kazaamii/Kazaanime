/**
 * Kazanime — round9-mobile-layout.test.js
 * Putaran 9 (24 Okt 2026) — tata letak ponsel/Android.
 *
 * Permintaan pengguna:
 *  1. "untuk akun malah seperti gif di atas" → menu profil di Android melayang menutupi
 *     konten, terpotong, dan navbar ikut tergeser.
 *  2. "posisi server jangan di bawah harusnya kesamping berjejer di bawah player"
 *     → panel Server Streaming pindah ke bawah player, tombolnya berjejer.
 *  3. "keterangan tamat rating dsb ... di atasnya sinopsis" → chip info tetap di atas
 *     sinopsis, tidak lagi terpisah oleh daftar episode.
 *  4. "urutanya Server dlu dibawahnya baru eps" → server sebelum daftar episode.
 *  5. Tombol di bawah player tidak boleh saling menimpa (dulu "Pemutar Eksternal"
 *     menimpa "Berikutnya" dan "Server Lain" terpotong).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const watchHtml = read('watch.html');
const watchCss = read('css/watch.css');
const componentsCss = read('css/components.css');
const baseCss = read('css/base.css');
const navbarJs = read('js/ui/navbar.js');

/** Kembalikan potongan HTML di antara dua penanda (untuk memeriksa urutan blok). */
const between = (html, start, end) => html.slice(html.indexOf(start), html.indexOf(end));

test('menu akun: akar bug overflow navbar diperbaiki tanpa kotak gulir', () => {
    // overflow-x:hidden membuat overflow-y otomatis jadi auto → navbar bisa digeser
    // dan menu terpotong. overflow-x:clip tidak pernah membuat kotak gulir.
    assert.match(componentsCss, /\.navbar-inner\{height:60px;overflow-x:hidden;overflow-x:clip\}/);
    const mobile = between(componentsCss, '@media(max-width:768px){', '@media(max-width:480px){');
    assert.match(mobile, /\.profile-dropdown\{position:fixed;top:calc\(var\(--nav-h\) \+ 6px\);left:12px;right:12px/);
    assert.match(mobile, /max-height:calc\(100vh - var\(--nav-h\) - 24px\)/);
    assert.match(mobile, /overflow-y:auto;overscroll-behavior:contain/);
    assert.match(mobile, /\.dropdown-item\{font-size:14px/);
    assert.match(mobile, /text-size-adjust:100%/);
    // Teks tidak boleh "membesar sendiri" (font boosting Chrome Android).
    assert.match(baseCss, /body\{[^}]*text-size-adjust:100%/);
});

test('menu akun: tombol trigger tetap bisa dibuka & menu ditutup saat halaman digulir', () => {
    assert.match(navbarJs, /\$\('#profileTrigger', navEl\)\.addEventListener\('click'/);
    assert.match(navbarJs, /window\.addEventListener\('scroll', \(\) => \{/);
    assert.match(navbarJs, /\.profile-wrapper\.open'\)\) closeProfile\(\)/);
    // Penjaga 300 ms: penyusutan address bar Chrome tidak boleh langsung menutup menu.
    assert.match(navbarJs, /if \(Date\.now\(\) - profileOpenedAt < 300\) return;/);
    assert.match(navbarJs, /\{ passive: true \}/);
});

test('server streaming: panel berada di bawah player, bukan di sidebar', () => {
    // Satu panel server saja (tidak boleh dobel).
    assert.equal((watchHtml.match(/id="serverButtons"/g) || []).length, 1);
    assert.equal((watchHtml.match(/class="server-selector server-bar"/g) || []).length, 1);

    const afterControls = watchHtml.indexOf('id="localSubtitleTools"');
    const serverBar = watchHtml.indexOf('class="server-selector server-bar"');
    const mainCol = watchHtml.indexOf('<!-- KOLOM UTAMA -->');
    assert.ok(afterControls > 0 && serverBar > afterControls, 'panel server harus SETELAH player + tombol');
    assert.ok(serverBar < mainCol, 'panel server harus SEBELUM kolom judul/sinopsis');

    // Sidebar kini hanya berisi daftar episode.
    const sidebar = between(watchHtml, '<aside class="streaming-sidebar"', '</aside>');
    assert.match(sidebar, /id="episodeGrid"/);
    assert.doesNotMatch(sidebar, /server-selector|serverButtons/);
});

test('server streaming: tombol berjejer ke samping di ponsel (2 kolom)', () => {
    const mobile = between(watchCss, '@media(max-width:768px){', '@media(max-width:600px){');
    assert.match(mobile, /\.server-buttons\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    assert.match(mobile, /\.server-btn\{width:100%;min-width:0;justify-content:center/);
    // Desktop: panel selebar dua kolom di atas grid detail.
    assert.match(watchCss, /\.server-bar\{grid-column:1\/-1;/);
});

test('urutan ponsel: server dulu, lalu judul + chip info, lalu episode, sinopsis terakhir', () => {
    const mobile = between(watchCss, '@media(max-width:768px){', '@media(max-width:600px){');
    // Sidebar (episode) sebelum info/download/platform, dan panel server tidak ikut di sidebar.
    assert.match(mobile, /\.streaming-sidebar\{order:1;/);
    assert.match(mobile, /\.watch-info,\.download-section,\.platforms-section\{order:2\}/);
    assert.match(mobile, /\.server-bar\{margin-bottom:16px\}/);
    // Chip info (streaming-meta) tetap di atas sinopsis: ada di .streaming-main sebelum .watch-info.
    const main = between(watchHtml, '<div class="streaming-main">', '</div>\n\n            <!-- SIDEBAR -->');
    assert.ok(main.indexOf('id="watchMeta"') > 0);
    assert.ok(main.indexOf('id="watchMeta"') < main.indexOf('id="watchInfo"'));
});

test('tombol bawah player tidak saling menimpa di ponsel', () => {
    const small = watchCss.slice(watchCss.indexOf('@media(max-width:600px){'));
    assert.match(small, /\.player-controls\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    assert.match(small, /\.player-controls>\.player-ctrl-btn\{width:100%;min-width:0;padding:9px 10px/);
    assert.match(small, /white-space:nowrap/);
    // Urutan DOM (dipakai juga oleh pembaca layar): Sebelumnya → Berikutnya → Server Lain → Eksternal.
    const ids = ['btnPrevEp', 'btnNextEp', 'btnNextServer', 'btnExternalPlayer'].map((id) => watchHtml.indexOf(`id="${id}"`));
    assert.ok(ids.every((pos, i) => pos > 0 && (i === 0 || pos > ids[i - 1])), `urutan tombol salah: ${ids.join(', ')}`);
    // Label panjang diganti label pendek supaya tidak meluber.
    assert.match(small, /\.ctrl-ext-long\{display:none\}/);
    assert.match(small, /\.ctrl-ext-short\{display:inline\}/);
    assert.match(watchCss, /\.ctrl-ext-short\{display:none\}/);
    assert.match(watchHtml, /<span class="ctrl-ext-long">Pemutar Eksternal<\/span><span class="ctrl-ext-short">Eksternal<\/span>/);
});
