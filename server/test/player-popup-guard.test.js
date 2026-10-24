import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Iklan host streaming & tombol pop-up — putaran 8 (24 Okt 2026).
 *
 * Riwayat: putaran 3 menjadikan sandbox iframe sebagai opt-in lewat tombol
 * "Pop-up diizinkan / Pop-up diblokir". Pengguna melaporkan tombol itu **tidak bekerja**:
 * player hanya menampilkan "Opss! Sandboxed our player is not allowed. Remove sandbox to
 * use it." sehingga video tidak muncul.
 *
 * Perbaikan putaran 8:
 *   1. **sandbox DIHAPUS TOTAL** — tidak ada atribut sandbox, tidak ada tombol mode;
 *   2. sisa pilihan lama di localStorage dibersihkan supaya pengguna tidak terkunci;
 *   3. **lapisan anti-iklan** menahan klik pertama di atas iframe (popunder tidak terjadi);
 *   4. tombol **Pemutar Eksternal** membuka embed di tab baru (noopener, noreferrer).
 *
 * Batas jujur: tanpa sandbox, tab baru dari klik SETELAH lapisan dilepas tidak bisa dicegah
 * browser-level dari halaman induk — karena itu pemutar eksternal disediakan.
 */
const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const configJs = read('js/config.js');
const playerJs = read('js/ui/player.js');
const watchHtml = read('watch.html');
const watchJs = read('js/watch.js');
const watchCss = read('css/watch.css');
const iconsJs = read('js/ui/icons.js');

test('config: sandbox dihapus, lapisan anti-iklan & label situs tersedia', () => {
    assert.doesNotMatch(configJs, /^\s*sandbox:\s*'/m, 'tidak ada lagi atribut sandbox di config');
    assert.match(configJs, /adShield: true,/);
    assert.match(configJs, /siteLabels: Object\.freeze\(\{ animeku: 'AnimeKu', oploverz: 'Animeloverz' \}\)/);
});

test('player: tidak pernah memasang sandbox pada iframe', () => {
    assert.doesNotMatch(playerJs, /setAttribute\('sandbox'/);
    assert.doesNotMatch(playerJs, /PLAYER\.sandbox/);
    assert.doesNotMatch(playerJs, /sandboxFor|sandboxRefused|popupGuardEnabled|setPopupGuard/);
    assert.match(playerJs, /iframe\.dataset\.popupGuard = 'off';/);
});

test('player: sisa pilihan sandbox lama dibersihkan dari perangkat', () => {
    assert.match(playerJs, /function dropLegacyGuardFlag\(\)/);
    assert.match(playerJs, /window\.localStorage\?\.removeItem\(STORAGE_KEYS\.popupGuard\)/);
    assert.match(playerJs, /dropLegacyGuardFlag\(\);/);
});

test('player: lapisan anti-iklan dipasang setelah embed dimuat dan lepas sekali klik', () => {
    assert.match(playerJs, /const AD_SHIELD_ID = 'playerAdShield';/);
    assert.match(playerJs, /function mountAdShield\(my\)/);
    assert.match(playerJs, /if \(!PLAYER\.adShield \|\| my !== token\) return;/);
    assert.match(playerJs, /mountAdShield\(my\);\s*\n\s*emit\('loaded'/, 'dipasang saat server selesai dimuat');
    assert.match(playerJs, /shield\.addEventListener\('click', \(event\) => \{[\s\S]{0,200}removeAdShield\(\);/);
    assert.match(playerJs, /function removeAdShield\(\)/);
    assert.match(playerJs, /removeAdShield\(\);/, 'dibersihkan saat ganti server/episode');
    assert.match(iconsJs, /'shield-check':/, 'ikon perisai tersedia');
    assert.match(watchCss, /\.player-ad-shield\{position:absolute;inset:0;z-index:3/);
    // Klik pertama ditahan: lapisan menutup iframe, jadi tidak diteruskan ke embed.
    assert.match(watchCss, /\.player-ad-shield\{[^}]*cursor:pointer/);
});

test('player: pemutar eksternal memakai URL server yang sedang diputar', () => {
    assert.match(playerJs, /externalUrl\(\) \{/);
    assert.match(playerJs, /const url = active\.kind === 'hls' \|\| active\.kind === 'video'/);
    assert.match(playerJs, /return \/\^https\?:\\\/\\\/\/i\.test\(String\(url \|\| ''\)\) \? url : null;/);
    assert.match(playerJs, /currentServerName: \(\) => current\(\)\?\.name \|\| ''/);
});

test('watch: tombol pemutar eksternal menggantikan tombol pop-up', () => {
    assert.doesNotMatch(watchHtml, /id="btnPopupGuard"/);
    assert.doesNotMatch(watchHtml, /Pop-up diblokir|Pop-up diizinkan/);
    assert.match(watchHtml, /<button type="button" class="player-ctrl-btn player-ctrl-btn--external" id="btnExternalPlayer"/);
    // Putaran 9: label panjang tetap ada (desktop) + label pendek "Eksternal" untuk ponsel.
    assert.match(watchHtml, /data-icon="external-link"><\/span><span class="ctrl-ext-long">Pemutar Eksternal<\/span>/);
    assert.match(watchHtml, /<span class="ctrl-ext-short">Eksternal<\/span>/);

    assert.match(watchJs, /externalPlayer: \$\('#btnExternalPlayer'\)/);
    assert.match(watchJs, /function openExternalPlayer\(\)/);
    assert.match(watchJs, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/);
    assert.match(watchJs, /els\.externalPlayer\?\.addEventListener\('click', openExternalPlayer\)/);
    assert.doesNotMatch(watchJs, /popupGuard|setPopupGuard/);
});

test('player: subtitle default tetap dinyalakan eksplisit untuk Chrome', () => {
    assert.match(playerJs, /track\.setAttribute\('default', ''\)/);
    assert.match(playerJs, /const showDefaultSubtitle = \(\) => \{/);
    assert.match(playerJs, /target\.mode = 'showing'/);
    assert.match(playerJs, /v\.addEventListener\('loadedmetadata', showDefaultSubtitle\)/);
    // iPad (WebKit) + ManagedMediaSource + subtitle → hls.js supaya <track> tampil.
    assert.match(playerJs, /const preferMseForSubtitles = appleWebKit && hasMse && subs\.length > 0;/);
    assert.match(playerJs, /const native = \(appleWebKit && !preferMseForSubtitles\) \|\| \(canNative && !hasMse\);/);
    assert.match(playerJs, /if \(canNative\) \{\s*\n\s*v\.dataset\.mode = 'native-proxy';/, 'tanpa MSE → fallback native, bukan gagal');
});
