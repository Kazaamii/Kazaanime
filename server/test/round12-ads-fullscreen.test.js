/**
 * Kazanime — round12-ads-fullscreen.test.js
 * Putaran 12 (24 Okt 2026).
 *
 * Permintaan pengguna:
 *   "iklan masih ada terbukti tidak bekerja lalu untuk logika eps tidak konsisten Saat eps 1
 *    dia ada pilihan sub indo namun saat pindah ke eps lain kadang hanya sub inggris tolong
 *    di perbaiki hapus saja mode aman dan block iklan nya dengan cara melarang new tab
 *    block nya sekilaa langsung menutup lalu saat full screen dia tidak rotate tolong
 *    perbaiki lalu untuk mode full screen nya harus benar standar player."
 *
 * Yang dijaga tes ini:
 *  1. Mode Aman DIHAPUS — tidak ada tombol/state/penyimpanan Safe Mode, tetapi panduan
 *     iklan (penjelasan) tetap ada.
 *  2. Penahan pop-up SELALU AKTIF: iframe dipasang sandbox yang melarang tab baru
 *     (`allow-popups`/`allow-popups-to-escape-sandbox`/`allow-top-navigation*` tidak ada).
 *  3. Tidak ada regresi pemutaran: host yang menolak sandbox diingat per host, sandbox
 *     dilepas otomatis setelah `releaseAfterMs`, dan tautan pelepas manual tersedia —
 *     tidak pernah ada layar penolakan permanen.
 *  4. Layar penuh standar pemutar: permintaan fullscreen pada wadah pemutar, kunci
 *     orientasi lanskap (berputar di ponsel), tombol keluar, dan status tombol yang sinkron.
 *  5. Sub Indo konsisten antar-episode: daftar situs padanan disimpan per sesi dan sumber
 *     Sub Indo yang gagal dicoba ulang (backend & frontend).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const playerJs = read('js/ui/player.js');
const watchJs = read('js/watch.js');
const watchHtml = read('watch.html');
const watchCss = read('css/watch.css');
const adGuideJs = read('js/ui/ad-guide.js');
const configJs = read('js/config.js');
const streamsJs = read('js/api/streams.js');
const iconsJs = read('js/ui/icons.js');

/* ------------------------------------------------------------------ */
/* 1 · Mode Aman dihapus, penahan pop-up selalu aktif                  */
/* ------------------------------------------------------------------ */
test('config: penahan pop-up selalu aktif dan melarang tab baru', () => {
    assert.match(configJs, /frameGuard: Object\.freeze\(\{/);
    const guard = configJs.match(/frameGuard: Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] || '';
    assert.ok(guard, 'konfigurasi frameGuard ada');
    const policy = guard.match(/policy:\s*'([^']*)'/)?.[1] || '';
    assert.ok(policy, 'policy sandbox ada');
    for (const token of ['allow-scripts', 'allow-same-origin', 'allow-forms']) {
        assert.ok(policy.includes(token), `embed tetap bisa berjalan: ${token}`);
    }
    assert.ok(policy.includes('allow-presentation'), 'mode presentasi (Chromecast/AirPlay) tetap jalan');
    for (const forbidden of ['allow-popups', 'allow-top-navigation', 'allow-modals']) {
        assert.ok(!policy.includes(forbidden), `tab baru/top-navigation dilarang: ${forbidden}`);
    }
    assert.match(guard, /releaseAfterMs:\s*\d+/);
    assert.match(guard, /hintAfterMs:\s*\d+/);
    assert.match(guard, /memoryLimit:\s*\d+/);
    // Lepas otomatis HARUS lebih cepat dari batas muat player, kalau tidak embed mati lebih dulu.
    assert.match(playerJs, /Math\.min\(PLAYER\.frameGuard\.releaseAfterMs, PLAYER\.loadTimeout\)/);
    // Tidak ada lagi sandbox opsional / Safe Mode di konfigurasi.
    assert.doesNotMatch(configJs, /PLAYER\.safeFrame\s*=/);
    assert.doesNotMatch(configJs, /safeFrame:\s*Object\.freeze/);
    assert.doesNotMatch(configJs, /^\s*sandbox:\s*'/m);
});

test('config: host yang menolak sandbox diingat, kunci lama Safe Mode dibersihkan', () => {
    assert.match(configJs, /noSandboxHosts:\s*'kz:no-sandbox'/);
    assert.match(playerJs, /PLAYER\.frameGuard\?\.memoryLimit/);
    // Penanda putaran 11 dibuang supaya pengguna lama tidak membawa setelan mati.
    const drop = playerJs.match(/function dropLegacyGuardFlag\(\)\{?([\s\S]*?)\n\}/)?.[1] || '';
    assert.ok(drop, 'dropLegacyGuardFlag ada');
    assert.match(drop, /STORAGE_KEYS\.popupGuard/);
    assert.match(drop, /legacySafeFrame/);
});

test('player: sandbox dipasang otomatis tanpa tombol mode', () => {
    assert.match(playerJs, /iframe\.sandbox\.value = PLAYER\.frameGuard\.policy/);
    assert.match(playerJs, /iframe\.dataset\.frameGuard = guarded \? 'on' : 'off'/);
    assert.match(playerJs, /const guarded = !hostRefusesSandbox\(urlOf\(server\)\)/);
    // Tidak ada lagi tombol/status Safe Mode di halaman nonton.
    assert.doesNotMatch(watchHtml, /btnSafeMode/);
    assert.doesNotMatch(watchJs, /safeFrame|SafeMode|syncSafeModeButton/);
    // Panduan iklan (penjelasan cara kerja + AdGuard DNS) tetap ada.
    assert.match(watchHtml, /id="btnAdGuide"/);
    assert.match(watchJs, /openAdGuide\(\)/);
    assert.match(adGuideJs, /Penahan pop-up/);
    assert.doesNotMatch(adGuideJs, /Mode Aman/);
});

test('player: iklan tidak bisa membuka tab baru dan pemutar tetap bisa pulih', () => {
    // Pelepas per host: setelah gagal dimuat beberapa kali, host diingat tanpa sandbox.
    assert.match(playerJs, /function rememberNoSandboxHost\(host\)/);
    assert.match(playerJs, /function releaseFrameGuard\(reason\)/);
    assert.match(playerJs, /rememberNoSandboxHost\(hostOf\(urlOf\(active\)\)\)/);
    assert.match(playerJs, /frame\.dataset\.frameGuard = 'off'/);
    // Tautan pelepas manual (bukan layar penolakan permanen).
    assert.match(playerJs, /function mountFrameHint\(/);
    assert.match(playerJs, /data-frame-action="release"/);
    assert.match(playerJs, /bar\.id = 'playerFrameHint'/);
    assert.match(watchCss, /\.player-frame-hint\{/);
    assert.match(playerJs, /releaseFrameGuard\('manual'\)/);
    // Batas waktu pemutar: server TIDAK dibuang, sandbox dilepas lalu URL sama dimuat ulang.
    assert.match(playerJs, /if \(iframe\.dataset\.frameGuard === 'on'\) \{\s*\n\s*releaseFrameGuard\('timeout'\);\s*\n\s*return;/);
    // Bukti pengguna: iklan memindahkan pemutar → bilah pemulihan, bukan halaman JSON mati.
    assert.match(playerJs, /function mountAdRecovery\(/);
    assert.match(playerJs, /function noteFrameReload\(my\)/);
    assert.match(watchCss, /\.player-ad-recovery/);
});

/* ------------------------------------------------------------------ */
/* 2 · Layar penuh standar pemutar (berputar di ponsel)                */
/* ------------------------------------------------------------------ */
test('watch: tombol Layar Penuh ada di antara Server Lain dan Pemutar Eksternal', () => {
    const start = watchHtml.indexOf('id="btnNextServer"');
    const fs = watchHtml.indexOf('id="btnFullscreen"');
    const ext = watchHtml.indexOf('id="btnExternalPlayer"');
    assert.ok(start > -1 && fs > start && ext > fs, 'urutan tombol: server lain → layar penuh → eksternal');
    const button = watchHtml.slice(watchHtml.lastIndexOf('<button', fs), watchHtml.indexOf('</button>', fs));
    assert.match(button, /class="player-ctrl-btn player-ctrl-btn--fullscreen"/);
    assert.match(button, /data-icon="maximize"/);
    assert.match(button, /aria-pressed="false"/);
    assert.match(button, /lanskap|landscape|berputar/i, 'judul menjelaskan rotasi lanskap');
    assert.match(iconsJs, /'maximize':/);
    assert.match(iconsJs, /'minimize':/);
});

test('player: layar penuh memakai API standar + kunci orientasi lanskap', () => {
    assert.match(playerJs, /fullscreen: Object\.freeze|PLAYER\.fullscreen/);
    assert.match(configJs, /fullscreen: Object\.freeze\(\{/);
    assert.match(configJs, /orientation:\s*'landscape'/);
    assert.match(playerJs, /async function toggleFullscreen\(\)/);
    assert.match(playerJs, /target\.requestFullscreen\?\.bind\(target\)/);
    assert.match(playerJs, /await request\(\{ navigationUI: 'hide' \}\)/);
    assert.match(playerJs, /target\.webkitRequestFullscreen\?\.bind\(target\)/);
    assert.match(playerJs, /video\?\.webkitEnterFullscreen/, 'fallback iOS memakai fullscreen video');
    assert.match(playerJs, /function lockLandscape\(\)/);
    assert.match(playerJs, /orientation\.lock\(PLAYER\.fullscreen\?\.orientation \|\| 'landscape'\)/);
    assert.match(playerJs, /function unlockOrientation\(\)/);
    assert.match(playerJs, /const fullscreenTarget = \(\) => stage\.closest\('\.streaming-player-wrapper'\) \|\| stage/);
    assert.match(playerJs, /document\.addEventListener\(name/, 'status mengikuti Esc/fullscreenchange');
    assert.match(playerJs, /function syncFullscreenUi\(\)/);
    assert.match(playerJs, /playerFsExit/);
    assert.match(playerJs, /emit\('fullscreen', \{ on: active \}\)/);
    assert.match(playerJs, /isFullscreen: \(\) => Boolean\(fullscreenEl\(\)\)/);
});

test('watch: tombol layar penuh tersinkron + tersedia di CSS dan mobile', () => {
    const ui = watchJs.match(/function syncFullscreenButton\([\s\S]*?\n\}/)?.[0] || '';
    assert.ok(ui, 'syncFullscreenButton ada');
    assert.match(ui, /aria-pressed/);
    assert.match(ui, /is-on/);
    assert.match(watchJs, /player\.on\('fullscreen'/);
    assert.match(watchJs, /player\.toggleFullscreen\(\)/);
    assert.match(watchJs, /function syncFullscreenButton\(on = player\.isFullscreen\(\)\)/);
    assert.match(watchJs, /syncFullscreenButton\(false\);/);

    assert.match(watchCss, /\.streaming-player-wrapper:fullscreen/);
    assert.match(watchCss, /html\.player-fullscreen/);
    assert.match(watchCss, /\.player-fs-exit/);
    // Wadah kosong tidak boleh menyisakan bingkai hitam besar di layar penuh.
    assert.match(watchCss, /object-fit:\s*contain/);
    // Peramban yang menolak kunci orientasi (iOS) tetap "berputar": panggung diputar 90°.
    assert.match(playerJs, /function rotateFallback\(target, active, locked\)/);
    assert.match(playerJs, /target\.classList\.toggle\('is-fs-rotated', Boolean\(active && !locked && portrait\)\)/);
    assert.match(playerJs, /const locked = await lockLandscape\(\)/);
    assert.match(watchCss, /\.streaming-player-wrapper\.is-fs-rotated>#playerStage\{[^}]*rotate\(90deg\)/);
});

/* ------------------------------------------------------------------ */
/* 3 · Sub Indo konsisten antar-episode                                */
/* ------------------------------------------------------------------ */
test('streams: daftar situs padanan disimpan per sesi (tidak hilang saat ganti episode)', () => {
    assert.match(streamsJs, /const MATCH_TTL_MS = 30 \* 60 \* 1000;/);
    assert.match(streamsJs, /const MATCH_STORAGE_KEY = 'kz:matches:v1';/);
    assert.match(streamsJs, /function readMatchCache\(key\)/);
    assert.match(streamsJs, /function writeMatchCache\(key, list\)/);
    assert.match(streamsJs, /export function cachedBackendMatches\(anime, \{ titles \} = \{\}\)/);
    // Pencarian gagal semua (throttle/offline) tetapi padanan sudah pernah ada → pakai cache.
    assert.match(streamsJs, /if \(!ok\.length\) \{[\s\S]{0,250}?if \(cached\) return cached\.list;/);
    assert.match(streamsJs, /if \(out\.length\) writeMatchCache\(matchCacheKey\(titles\)/);
});

test('streams: sumber Sub Indo yang gagal dicoba ulang, bukan langsung hilang', () => {
    assert.match(streamsJs, /const wait = \(ms, signal\) => new Promise/);
    // Sumber asal (AnimeKu/Animeloverz) yang gagal sekali dicoba lagi setelah jeda.
    assert.match(streamsJs, /if \(subIndoRank\(own\) < SUB_INDO_SOURCES\.length && !signal\?\.aborted\) \{[\s\S]{0,200}?await wait\(700, signal\)/);
    // Sumber padanan Sub Indo juga dicoba ulang sekali.
    assert.match(streamsJs, /const subIndoFailed = settled/);
    assert.match(streamsJs, /await wait\(700, signal\)/);
    assert.match(streamsJs, /const retried = await Promise\.allSettled\(/);
    // Frontend diberi tahu situs Sub Indo mana yang masih gagal (untuk mencoba lagi).
    assert.match(streamsJs, /failedSubIndo/);
    assert.match(streamsJs, /\.map\(\(target\) => siteOfSource\(target\)\)/);
});

test('watch: frontend mencoba ulang Sub Indo sekali per episode', () => {
    assert.match(watchJs, /let subIndoSeen = false;/);
    assert.match(watchJs, /let subIndoRetryFor = null;/);
    assert.match(watchJs, /subIndoRetryFor = null;/, 'status dicoba-ulang direset per episode');
    assert.match(watchJs, /const hasSubIndo = res\.servers\.some\(\(server\) => server\.lang === 'id'\)/);
    assert.match(watchJs, /const lostSubIndo = !hasSubIndo && \(res\.failedSubIndo\?\.length \|\| subIndoSeen\)/);
    assert.match(watchJs, /const willRetry = lostSubIndo && subIndoRetryFor !== n && !res\.disabled/);
    assert.match(watchJs, /\}, 1600\);/);
    assert.match(watchJs, /else if \(!willRetry\) scrapeFinished\(n\)/);
});

test('watch: server Sub Indo tetap dua tombol berlabel situs', () => {
    assert.match(watchJs, /SUB_INDO_SOURCES/);
    assert.doesNotMatch(watchJs, /popupGuard|setPopupGuard/);
});
