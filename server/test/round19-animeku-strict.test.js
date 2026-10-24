/**
 * Kazanime — round19-animeku-strict.test.js
 * Putaran 19 (24 Okt 2026).
 *
 * Permintaan pengguna: *"perkuat lagi untuk yang di animeku"* — setelah penguatan putaran 18
 * (popup yang sama tidak muncul lagi), pengguna meminta lapisan tambahan **khusus AnimeKu**.
 *
 * Yang dikunci tes ini:
 *  1. **Pola iklan tetap satu daftar** (70 host / 13 pola) untuk AnimeKu & Oploverz — yang
 *     diperkuat adalah kebijakan & perilaku, BUKAN daftar polanya.
 *  2. AnimeKu memakai sandbox lebih ketat (`strictPolicy`: tanpa `allow-forms`/`allow-downloads`),
 *     Oploverz tetap `policy` dasar.
 *  3. AnimeKu dilewati pada pembajakan **pertama** (`strictMaxTakeovers: 1`).
 *  4. Tanda AnimeKu **diingat antar-halaman** (localStorage `kz:adrepeat`, 6 jam) — dan dilepas
 *     otomatis bila server terbukti sehat 20 detik atau pengguna menekan "Coba lagi".
 *  5. Popup yang mencuri fokus (blur → focus saat pemutar memuat) dihitung sebagai popup untuk
 *     AnimeKu, dengan penyaring supaya pindah tab/aplikasi tidak menghukum server.
 *  6. Tombol AnimeKu **tetap ada & tetap bisa diklik** (permintaan putaran 16) dan sandbox tidak
 *     pernah dilepas.
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
const watchCss = read('css/watch.css');
const { AD_HOSTS, AD_URL_PATTERNS } = await import('../../js/services/adblock.js');

/** Isi blok `frameGuard: Object.freeze({ … })`. */
const frameGuard = configJs.match(/frameGuard: Object\.freeze\(\{([\s\S]*?)\n    \}\),/)?.[1] || '';
/** Isi blok `adTakeover: Object.freeze({ … })`. */
const adTakeover = configJs.match(/adTakeover: Object\.freeze\(\{([\s\S]*?)\n    \}\),/)?.[1] || '';
/** Isi blok `popupWatch: Object.freeze({ … })`. */
const popupWatch = configJs.match(/popupWatch: Object\.freeze\(\{([\s\S]*?)\n    \}\),/)?.[1] || '';

/* ------------------------------------------------------------------ */
/* 1 · Pola iklan tetap SATU daftar                                    */
/* ------------------------------------------------------------------ */
test('pola iklan tetap satu daftar untuk AnimeKu & Oploverz (tidak dilebarkan)', () => {
    assert.equal(AD_HOSTS.length, 70);
    assert.equal(AD_URL_PATTERNS.length, 13);
    // Sisi server mencerminkan daftar yang sama.
    const serverLib = read('server/lib/adblock.js');
    for (const host of ['popads.net', 'propellerads.com', 'adsterra.com', 'monetag.com']) {
        assert.ok(serverLib.includes(`'${host}'`), `${host} ada di sisi server`);
    }
});

/* ------------------------------------------------------------------ */
/* 2 · Konfigurasi ketat khusus AnimeKu                                */
/* ------------------------------------------------------------------ */
test('config: sandbox lebih ketat untuk AnimeKu', () => {
    assert.match(frameGuard, /subIndoSources: Object\.freeze\(\['animeku', 'oploverz'\]\)/);
    assert.match(frameGuard, /strictSources: Object\.freeze\(\['animeku'\]\)/);
    const base = frameGuard.match(/policy: '([^']+)'/)?.[1] || '';
    const strict = frameGuard.match(/strictPolicy: '([^']+)'/)?.[1] || '';
    assert.ok(base.includes('allow-forms'), 'kebijakan dasar (Oploverz) tidak berubah');
    assert.ok(strict.includes('allow-scripts') && strict.includes('allow-same-origin'), 'pemutar AnimeKu tetap bisa berjalan');
    assert.ok(!strict.includes('allow-forms'), 'formulir tersembunyi tidak bisa dipakai membuka tab');
    assert.ok(!strict.includes('allow-downloads'), 'unduhan otomatis diblokir');
    assert.ok(!strict.includes('allow-popups'), 'popup tetap dilarang');
    assert.ok(!strict.includes('allow-top-navigation'), 'navigasi tab atas tetap dilarang');
});

test('config: AnimeKu dilewati pada pembajakan pertama & diingat antar-halaman', () => {
    assert.match(adTakeover, /strictSources: Object\.freeze\(\['animeku'\]\)/);
    assert.match(adTakeover, /strictMaxTakeovers: 1/);
    assert.match(adTakeover, /strictRemountShield: true/);
    assert.match(adTakeover, /persistSources: Object\.freeze\(\['animeku'\]\)/);
    assert.match(adTakeover, /persistMs: 21600000/);
    assert.match(adTakeover, /healthyClearMs: 20000/);
    assert.match(configJs, /adRepeatBlock: 'kz:adrepeat'/);
});

test('config: pengawas popup dibatasi & punya penyaring', () => {
    assert.match(popupWatch, /enabled: true/);
    assert.match(popupWatch, /sources: Object\.freeze\(\['animeku'\]\)/);
    assert.match(popupWatch, /maxEvents: 2/);
    assert.match(popupWatch, /windowMs: 120000/);
    assert.match(popupWatch, /startWindowMs: 45000/);
    assert.match(popupWatch, /minBlurMs: 350/);
    assert.match(popupWatch, /maxBlurMs: 60000/);
});

/* ------------------------------------------------------------------ */
/* 3 · Player: kebijakan ketat & batas khusus                          */
/* ------------------------------------------------------------------ */
test('player: sandbox ketat hanya dipasang untuk AnimeKu', () => {
    assert.match(playerCode, /function applyStrictFramePolicy\(iframe\) \{/);
    assert.match(playerCode, /iframe\.sandbox\.value = PLAYER\.frameGuard\.strictPolicy \|\| PLAYER\.frameGuard\.policy;/);
    assert.match(playerCode, /iframe\.dataset\.adStrict = 'on';/);
    assert.match(playerCode, /function isStrictAdServer\(server\) \{/);
    // Dipasang SETELAH kebijakan dasar, dan hanya bila iframe memang ber-sandbox.
    assert.match(playerCode, /if \(guarded\) applyFramePolicy\(iframe\);/);
    assert.match(playerCode, /if \(guarded && isStrictAdServer\(server\)\) applyStrictFramePolicy\(iframe\);/);
    // Oploverz tidak terkena kebijakan ketat.
    assert.doesNotMatch(frameGuard, /strictSources: Object\.freeze\(\['animeku', 'oploverz'\]\)/);
});

test('player: batas pembajakan berbeda untuk AnimeKu (1, bukan 2)', () => {
    assert.match(playerCode, /const adTakeoverLimit = \(server\) => \(isStrictAdServer\(server\)/);
    assert.match(playerCode, /PLAYER\.adTakeover\?\.strictMaxTakeovers \|\| 1/);
    assert.match(playerCode, /PLAYER\.adTakeover\?\.maxTakeovers \|\| 2/);
    // noteFrameReload memakai batas per server.
    const fn = playerCode.slice(playerCode.indexOf('function noteFrameReload('));
    assert.match(fn.slice(0, 1400), /const limit = adTakeoverLimit\(active\);/);
    // AnimeKu yang sudah ditandai langsung dipindahkan pada pembajakan pertama.
    assert.match(fn.slice(0, 1400), /if \(!autoBlocked\(active\) && count < limit\) \{/);
});

test('player: lapisan anti-iklan dipasang ulang setelah pembajakan (situs ketat)', () => {
    const fn = playerCode.slice(playerCode.indexOf('function noteFrameReload('));
    assert.match(fn.slice(0, 1600), /if \(PLAYER\.adTakeover\?\.strictRemountShield !== false && isStrictAdServer\(active\)\) mountAdShield\(my\);/);
    // Dipasang SEBELUM pemeriksaan batas → berlaku juga saat tidak ada server lain (bar pemulihan).
    const body = fn.slice(0, 1600);
    assert.ok(body.indexOf('mountAdShield(my)') < body.indexOf('if (!autoBlocked(active) && count < limit)'), 'perisai dipasang sebelum pemeriksaan batas');
});

/* ------------------------------------------------------------------ */
/* 4 · Ingatan antar-halaman                                           */
/* ------------------------------------------------------------------ */
test('player: tanda AnimeKu diingat antar-halaman dengan TTL & batas', () => {
    assert.match(playerCode, /const AD_REPEAT_LIMIT = 10;/);
    assert.match(playerCode, /function readAdRepeatBlock\(\) \{/);
    assert.match(playerCode, /function rememberAdRepeatSite\(site\) \{/);
    assert.match(playerCode, /function forgetAdRepeatSite\(site\) \{/);
    assert.match(playerCode, /const adBlockedSites = new Set\(readAdRepeatSites\(\)\);/);
    // Hanya situs di persistSources yang disimpan, entri kedaluwarsa dibuang.
    const readFn = playerCode.slice(playerCode.indexOf('function readAdRepeatBlock()'));
    const body = readFn.slice(0, 900);
    assert.match(body, /PLAYER\.adTakeover\?\.persistSources \|\| \[\]\)\.includes\(site\)/);
    assert.match(body, /if \(!Number\.isFinite\(at\) \|\| at <= now\) continue;/);
    const rememberFn = playerCode.slice(playerCode.indexOf('function rememberAdRepeatSite(site)'));
    assert.match(rememberFn.slice(0, 700), /Date\.now\(\) \+ \(PLAYER\.adTakeover\?\.persistMs \|\| 21600000\)/);
    assert.match(rememberFn.slice(0, 900), /AD_REPEAT_LIMIT/);
});

test('player: "autoBlocked" menyatukan tanda sesi & antar-halaman', () => {
    const fn = playerCode.slice(playerCode.indexOf('function autoBlocked(server)'));
    assert.match(fn.slice(0, 500), /return adBlocked\.has\(server\.id\) \|\| adBlockedSites\.has\(siteOf\(server\)\);/);
    // Semua pemilihan otomatis memakai autoBlocked.
    assert.match(playerCode, /const usable = list\.filter\(\(s\) => !autoBlocked\(s\)\);/);
    assert.match(playerCode, /const list = available\(\)\.filter\(\(s\) => !autoBlocked\(s\)\);/);
    assert.match(playerCode, /const keepCurrent = previous\?\.available && !autoBlocked\(previous\) \? previous : null;/);
    // Pembajakan pada AnimeKu menyimpan tanda situs.
    const block = playerCode.slice(playerCode.indexOf('function blockActiveServer('));
    assert.match(block.slice(0, 1100), /rememberAdRepeatSite\(siteOf\(active\)\);/);
});

test('player: tanda dilepas saat sehat / saat pengguna minta coba lagi', () => {
    const healthy = playerCode.slice(playerCode.indexOf('function armHealthyClear(server)'));
    assert.match(healthy.slice(0, 1200), /adBlocked\.delete\(server\.id\);/);
    assert.match(healthy.slice(0, 1200), /adBlockedSites\.delete\(siteOf\(server\)\);/);
    assert.match(healthy.slice(0, 1200), /forgetAdRepeatSite\(siteOf\(server\)\);/);
    assert.match(healthy.slice(0, 900), /PLAYER\.adTakeover\?\.healthyClearMs \|\| 20000/);
    // retry() = tindakan eksplisit pengguna → ingatan antar-halaman ikut dihapus.
    const retry = playerCode.slice(playerCode.indexOf('function retry()'));
    assert.match(retry.slice(0, 500), /for \(const site of \[\.\.\.adBlockedSites\]\) forgetAdRepeatSite\(site\);/);
    assert.match(retry.slice(0, 600), /adBlockedSites\.clear\(\);/);
});

/* ------------------------------------------------------------------ */
/* 5 · Pengawas popup (blur → focus)                                   */
/* ------------------------------------------------------------------ */
test('player: popup yang mencuri fokus dihitung untuk AnimeKu', () => {
    assert.match(playerCode, /function notePopupSignal\(\) \{/);
    const fn = playerCode.slice(playerCode.indexOf('const onWindowBlur'));
    const body = fn.slice(0, 1600);
    // Pindah tab/aplikasi tidak dihitung.
    assert.match(body, /document\.visibilityState !== 'visible'\) return;/);
    // Tab yang dibuka sendiri (Pemutar Eksternal) tidak dihitung sebagai popup.
    assert.match(playerCode, /if \(ownTabAt && Date\.now\(\) - ownTabAt < 6000\) return;/);
    assert.match(playerCode, /noteOwnTabOpen: \(\) => \{ ownTabAt = Date\.now\(\); \}/);
    assert.match(watchJs, /player\.noteOwnTabOpen\(\);/);
    // Blur sekejap / terlalu lama diabaikan.
    const focusFn = playerCode.slice(playerCode.indexOf('const onWindowFocus'));
    assert.match(focusFn.slice(0, 700), /duration < \(watch\.minBlurMs \|\| 350\) \|\| duration > \(watch\.maxBlurMs \|\| 60000\)/);
    // Hanya saat pemutar memuat/baru mulai, hanya situs di daftar, dan butuh `maxEvents`.
    const signal = playerCode.slice(playerCode.indexOf('function notePopupSignal()'));
    assert.match(signal.slice(0, 1600), /\(watch\.sources \|\| \[\]\)\.includes\(siteOf\(active\)\)/);
    assert.match(signal.slice(0, 1600), /Date\.now\(\) - playStartedAt > \(watch\.startWindowMs \|\| 45000\)/);
    assert.match(signal.slice(0, 1600), /if \(list\.length < \(watch\.maxEvents \|\| 2\)\) return;/);
    assert.match(signal.slice(0, 1800), /blockActiveServer\(active, \{ count: list\.length, popup: true \}\);/);
});

/* ------------------------------------------------------------------ */
/* 6 · UI & pengaman yang tidak boleh berubah                          */
/* ------------------------------------------------------------------ */
test('UI: tanda "iklan" di tombol, toast popup & peringatan ingatan', () => {
    assert.match(playerCode, /const repeatBadge = autoBlocked\(s\) && !offline/);
    assert.match(playerCode, /server-badge--adblock/);
    assert.match(watchCss, /\.server-badge--adblock\{/);
    // Tombol tetap ada dan tetap bisa diklik (putaran 16).
    assert.doesNotMatch(playerCode, /hidden = autoBlocked|disabled = autoBlocked/);
    // Pesan halaman nonton.
    assert.match(watchJs, /Popup iklan terbuka dari \$\{server\?\.name/);
    assert.match(watchJs, /type === 'remembered'/);
    assert.match(watchJs, /dilewati otomatis karena iklannya berulang di perangkat ini/);
});

test('pengaman putaran 15/16 tidak berubah', () => {
    // Tidak ada jalur melepas sandbox / mengizinkan popup.
    assert.doesNotMatch(playerCode, /removeAttribute\(['"]sandbox['"]\)/);
    assert.doesNotMatch(playerCode, /allow-popups|allow-top-navigation|allow-modals/);
    assert.doesNotMatch(playerCode, /releaseFrameGuard|mountFrameHint|hostRefusesSandbox/);
    // Tombol "Matikan blokir" hanya untuk server luar.
    assert.match(playerCode, /if \(!server \|\| !isExternalServer\(server\)\) return;/);
    // Server Sub Indo selalu memakai blokir.
    assert.match(playerCode, /if \(!isExternalServer\(server\)\) return true;/);
    // Petunjuk panel server menjelaskan perilaku baru.
    assert.match(watchHtml, /iklan yang sama muncul lagi setelah ditutup/);
});
