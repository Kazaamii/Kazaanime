/**
 * Kazanime — round17-dead-servers.test.js
 * Putaran 17 (24 Okt 2026).
 *
 * Permintaan pengguna: *"server 1 dan 3 nampaknya sudah mati jika benar hapus saja tidak akan
 * berguna juga"*.
 *
 * Bukti (produksi, 24 Okt 2026):
 *   GET /api/stream/servers?anilist=203490&ep=15&title=…
 *     → ok:true, servers:[], status:{ reanime:'blocked', anizone:'blocked' }
 *     → errors: "… mengirim CAPTCHA atau challenge keamanan (HTTP 403); akses dihentikan tanpa
 *       percobaan ulang." (judul lain juga sama)
 * Dua tombol itu (Server 1 = AniZone "Multi Sub", Server 3 = ReAnime "Sub Eng") hanya bisa muncul
 * sebagai tempat kosong 🔒 karena backend tidak pernah mendapat server. Tanpa melewati Cloudflare
 * (tidak diizinkan), tombolnya tidak akan pernah bisa diputar → dihapus.
 *
 * Aturan yang dijaga:
 *  1. Daftar server statis = MegaPlay, Vidnest, TryEmbed (ketiganya berbasis id AniList).
 *  2. Tidak ada slot penyedia (`provider`) / status "mencari…" lagi di daftar server.
 *  3. Halaman nonton tidak lagi memanggil /api/stream/servers (tidak ada `loadProviders`).
 *  4. Backend provider tetap ada untuk pemakaian API manual — bukan jalur UI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// js/api/http.js memasang listener `online` saat modul dimuat → stub minimal.
globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const { STREAMING_SERVERS } = await import('../../js/config.js');
const { listStreamServers } = await import('../../js/api/streams.js');
const configJs = read('js/config.js');
const watchJs = stripComments(read('js/watch.js'));
const streamsJs = stripComments(read('js/api/streams.js'));
const indexJs = read('js/api/index.js');
const watchHtml = read('watch.html');
const adGuideJs = read('js/ui/ad-guide.js');

test('daftar server statis hanya MegaPlay, Vidnest, TryEmbed', () => {
    assert.deepEqual(STREAMING_SERVERS.map((s) => s.id), ['megaplay-anilist', 'vidnest-anilist', 'tryembed-anilist']);
    assert.deepEqual(STREAMING_SERVERS.map((s) => s.lang), ['en', 'en', 'en']);
    for (const id of ['anizone', 'reanime']) {
        assert.equal(STREAMING_SERVERS.some((s) => s.id === id), false, `${id} harus sudah dihapus`);
    }
    for (const server of STREAMING_SERVERS) {
        assert.equal(server.provider, undefined, 'tidak ada slot penyedia');
        assert.equal(typeof server.url, 'function', 'URL dibangun lokal dari id AniList');
        assert.equal(server.needs, 'anilist');
        assert.equal(server.enabled, true);
    }
    // Konfigurasi tidak lagi menyebut host penyedia yang mati.
    assert.doesNotMatch(configJs, /id: 'anizone'/);
    assert.doesNotMatch(configJs, /id: 'reanime'/);
});

test('listStreamServers: tiga server siap pakai, tanpa slot "mencari…"', () => {
    const list = listStreamServers({ title: 'ONE PIECE', ids: { anilist: 21 } }, 1);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((s) => s.available), [true, true, true]);
    assert.deepEqual(list.map((s) => s.url), [
        'https://megaplay.buzz/stream/ani/21/1/sub',
        'https://vidnest.fun/anime/21/1/sub',
        'https://tryembed.us.cc/embed/anime/21/1/sub',
    ]);
    assert.ok(list.every((s) => !s.pending), 'tidak ada server "mencari…"');
    assert.ok(list.every((s) => s.provider === undefined));
    assert.deepEqual(list.map((s) => s.source), ['static', 'static', 'static']);
    assert.equal(list[0].name, 'MegaPlay - AniList');
});

test('listStreamServers: tanpa id AniList tetap tiga tombol, terkunci dengan alasan jelas', () => {
    const list = listStreamServers({ title: 'Tanpa ID', ids: {} }, 1);
    assert.equal(list.length, 3);
    assert.ok(list.every((s) => s.available === false));
    assert.ok(list.every((s) => s.url === null));
    assert.ok(list.every((s) => /belum tersedia untuk anime ini/.test(s.reason)));
});

test('halaman nonton tidak lagi meminta /api/stream/servers', () => {
    assert.doesNotMatch(watchJs, /getStreamServers/);
    assert.doesNotMatch(watchJs, /loadProviders/);
    assert.doesNotMatch(watchJs, /providerResult|providerCtrl|providerKey/);
    assert.doesNotMatch(watchJs, /withProviderServers/);
    assert.doesNotMatch(indexJs, /withProviderServers/);
    assert.match(indexJs, /export \{ listStreamServers, getEpisodeExtras, SUB_INDO_SOURCES \} from '\.\/streams\.js';/);
    // Slot penyedia di streams.js ikut dihapus, tetapi klien API backend boleh tetap ada
    // untuk pemakaian manual (docs menyebutnya jelas).
    assert.doesNotMatch(streamsJs, /export function withProviderServers/);
    assert.doesNotMatch(streamsJs, /pending: true/);
});

test('backend provider tetap ada (API manual) meski UI tidak memakainya', () => {
    const route = read('server/routes/stream.js');
    assert.match(route, /router\.get\('\/servers'/);
    const providersIndex = read('server/providers/index.js');
    assert.match(providersIndex, /reanime|anizone/);
    // Status blokir Cloudflare dicatat agar tidak ada yang "memperbaiki" dengan mencoba ulang.
    assert.match(read('server/providers/reanime.js'), /Challenge Cloudflare dihentikan tanpa retry/);
});

test('UI tidak lagi menjanjikan server Multi Sub / Multi-Sub CC yang sudah tidak ada', () => {
    assert.doesNotMatch(watchHtml, /Server <strong>Multi Sub<\/strong>/);
    assert.match(watchHtml, /MegaPlay, Vidnest, TryEmbed/);
    assert.doesNotMatch(adGuideJs, /ReAnime, dan AniZone/);
    assert.match(adGuideJs, /MegaPlay, Vidnest, TryEmbed/);
});

test('pemutar HLS/native tidak ikut terhapus (dipakai sumber lain)', () => {
    const playerJs = read('js/ui/player.js');
    assert.match(playerJs, /kind === 'hls'/);
    assert.match(playerJs, /function playVideo\(server, my, overlay\)/);
    assert.match(read('js/api/sources.js'), /\['hls', 'video'\]\.includes\(x\?\.kind\)/);
});
