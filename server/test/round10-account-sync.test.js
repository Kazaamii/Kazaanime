/**
 * Kazanime — round10-account-sync.test.js
 * Putaran 10 (24 Okt 2026).
 *
 * Permintaan pengguna:
 *  1. "kadang pengguna tidak ditemukan tolong perbaiki lagi" → akun lokal harus tahan
 *     huruf besar/kecil, spasi, data lama, dan data korup; ditambah jalur SERVER akun.
 *  2. "beberapa foto profil tidak terdeteksi hanya icon bawaan" → setiap avatar preset
 *     punya gambar yang benar-benar ada (URL Kitsu terverifikasi atau ilustrasi lokal).
 *  3. "tombol Cadangkan/Pulihkan akun" → berkas .json + kode sinkron.
 *  4. "cari solusi agar ada server akun … alternative agar tetap terpakai" → backend
 *     /api/accounts opsional (file/redis/memory), tetap 503 yang jelas bila mati.
 *  5. "posisi judul anime sebaiknya pindah keatas" → judul sebelum player.
 *  6. "kategori yg muncul hanya 2 anilist dan kitsu … tambah kan juga" → tab AnimeKu &
 *     Oploverz + hitungan per sumber.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../app.js';
import { createAccountStore, createFileAdapter } from '../lib/account-store.js';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/* ------------------------------------------------------------------ */
/* Backend: server akun opsional                                       */
/* ------------------------------------------------------------------ */
async function withApp(opts, fn) {
    const app = createApp({ log: false, rateLimitPerMinute: 0, budgetMs: 5000, ...opts });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await fn(base);
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
}

const call = async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* bukan JSON */ }
    return { res, json };
};

const jsonPost = (url, body, token) => call(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
});

test('akun server: nonaktif → /status jujur & endpoint tulis 503 dengan alasan', async () => {
    // Adapter null = ACCOUNT_STORE kosong (keadaan bawaan produksi saat ini).
    const store = createAccountStore({ adapter: null, reason: 'Server akun nonaktif. Set ACCOUNT_STORE=file.' });
    await withApp({ accountStore: store }, async (base) => {
        const status = await call(`${base}/api/accounts/status`);
        assert.equal(status.res.status, 200);
        assert.equal(status.json.ok, true);
        assert.equal(status.json.data.enabled, false);
        assert.match(status.json.data.reason, /ACCOUNT_STORE/);
        assert.equal(status.res.headers.get('cache-control'), 'no-store');

        const reg = await jsonPost(`${base}/api/accounts/register`, { username: 'rully', password: 'rahasia1' });
        assert.equal(reg.res.status, 503);
        assert.equal(reg.json.ok, false);
        assert.match(reg.json.error, /ACCOUNT_STORE|nonaktif/);
    });
});

test('akun server: daftar, masuk, token HMAC, dan password tidak pernah dikembalikan', async () => {
    const store = createAccountStore({ adapter: null, reason: '' });
    // Adapter palsu di memori (tanpa menyentuh disk/Vercel).
    const mem = new Map();
    const adapter = {
        provider: 'memory', persistent: false,
        async get(name) { return mem.get(String(name).toLowerCase()) || null; },
        async put(record) { mem.set(String(record.username).toLowerCase(), record); return record; },
        async count() { return mem.size; },
    };
    const withAdapter = createAccountStore({ adapter, reason: '' });

    await withApp({ accountStore: withAdapter }, async (base) => {
        const reg = await jsonPost(`${base}/api/accounts/register`, { username: 'Rully', password: 'rahasia1', avatar: { id: 1, img: 'x' } });
        assert.equal(reg.res.status, 200, JSON.stringify(reg.json));
        assert.equal(reg.json.data.user.username, 'Rully');
        assert.ok(reg.json.data.token.includes('.'), 'token harus payload.mac');
        assert.equal(JSON.stringify(reg.json).includes('rahasia1'), false, 'password tidak boleh dikirim balik');
        assert.equal('hash' in reg.json.data.user || 'salt' in reg.json.data.user, false);
        const token = reg.json.data.token;

        const dup = await jsonPost(`${base}/api/accounts/register`, { username: 'rully', password: 'rahasia2' });
        assert.equal(dup.res.status, 409, 'username server tidak boleh dobel (tanpa beda huruf)');

        const me = await call(`${base}/api/accounts/me`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(me.res.status, 200);
        assert.equal(me.json.data.user.username, 'Rully');

        const wrong = await jsonPost(`${base}/api/accounts/login`, { username: 'RULLY', password: 'salah' });
        assert.equal(wrong.res.status, 401);
        // Username tidak ada & password salah → pesan SERAGAM (tidak membocorkan akun server).
        const missing = await jsonPost(`${base}/api/accounts/login`, { username: 'tidakada', password: 'rahasia1' });
        assert.equal(missing.res.status, 401);
        assert.equal(missing.json.error, wrong.json.error);

        const ok = await jsonPost(`${base}/api/accounts/login`, { username: '  rully ', password: 'rahasia1' });
        assert.equal(ok.res.status, 200, 'login harus toleran spasi & huruf besar');
        assert.equal(ok.json.data.user.username, 'Rully');

        // Token palsu/ubah 1 karakter → 401.
        const forged = await call(`${base}/api/accounts/me`, { headers: { Authorization: `Bearer ${token.slice(0, -2)}xx` } });
        assert.equal(forged.res.status, 401);
    });

    assert.equal(mem.size, 1);
    assert.equal(store.enabled, false);
});

test('akun server: sync menggabungkan bookmark tanpa duplikat + avatar terbaru menang', async () => {
    const mem = new Map();
    const adapter = {
        provider: 'memory', persistent: true,
        async get(name) { return mem.get(String(name).toLowerCase()) || null; },
        async put(record) { mem.set(String(record.username).toLowerCase(), record); return record; },
        async count() { return mem.size; },
    };
    const store = createAccountStore({ adapter, reason: '' });

    await withApp({ accountStore: store }, async (base) => {
        const reg = await jsonPost(`${base}/api/accounts/register`, {
            username: 'rully', password: 'rahasia1',
            bookmarks: [{ title: 'Frieren', ids: { anilist: 1 }, addedAt: 10 }],
        });
        const token = reg.json.data.token;

        const synced = await jsonPost(`${base}/api/accounts/sync`, {
            bookmarks: [
                { title: 'Frieren', ids: { anilist: 1 }, addedAt: 10 },
                { title: 'Dandadan', ids: { anilist: 2 }, addedAt: 20 },
            ],
            avatar: { id: 3, name: 'Zero Two' },
            updatedAt: Date.now(),
        }, token);
        assert.equal(synced.res.status, 200, JSON.stringify(synced.json));
        const titles = synced.json.data.user.bookmarks.map((b) => b.title).sort();
        assert.deepEqual(titles, ['Dandadan', 'Frieren'], 'bookmark harus union, bukan duplikat');
        assert.equal(synced.json.data.user.avatar.id, 3);

        const stale = await jsonPost(`${base}/api/accounts/sync`, {
            avatar: { id: 9, name: 'Lama' },
            updatedAt: 1,
        }, token);
        assert.equal(stale.json.data.user.avatar.id, 3, 'avatar dari klien dengan stempel lama tidak boleh menimpa');

        const noToken = await jsonPost(`${base}/api/accounts/sync`, { bookmarks: [] });
        assert.equal(noToken.res.status, 401);
    });
});

test('akun server: adapter file menulis JSON atomik & bertahan setelah store dibuat ulang', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kazanime-accounts-'));
    try {
        const first = createFileAdapter(dir);
        await first.put({ username: 'Rully', salt: 's', hash: 'h', updatedAt: 1 });
        const file = path.join(dir, 'accounts.json');
        assert.ok(fs.existsSync(file));
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(parsed.rully.username, 'Rully', 'kunci disimpan lowercase');
        assert.equal(fs.existsSync(`${file}.tmp`), false, 'tidak boleh menyisakan berkas sementara');

        const second = createFileAdapter(dir); // simulasi proses server restart
        const record = await second.get('  rully ');
        assert.equal(record.username, 'Rully');
        assert.equal(await second.count(), 1);

        // Tulis kedua tidak menghapus akun pertama (bukan menimpa seluruh berkas).
        await second.put({ username: 'Sinta', salt: 's', hash: 'h', updatedAt: 2 });
        assert.equal(await second.count(), 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ------------------------------------------------------------------ */
/* Frontend: kontrak file                                             */
/* ------------------------------------------------------------------ */
const config = read('js/config.js');
const authJs = read('js/services/auth.js');
const accountBackup = read('js/services/account-backup.js');
const accountSync = read('js/services/account-sync.js');
const accountApi = read('js/api/accounts.js');
const accountModal = read('js/ui/account-modal.js');
const navbarJs = read('js/ui/navbar.js');
const layoutJs = read('js/ui/layout.js');
const domJs = read('js/ui/dom.js');
const searchJs = read('js/search.js');
const searchHtml = read('search.html');
const routesJs = read('js/routes.js');
const watchHtml = read('watch.html');

test('akun lokal: pencarian nama tidak peka huruf/spasi, cadangan otomatis, dan data korup dipulihkan', () => {
    assert.match(authJs, /function findKey\(users, name\)/, 'harus ada pencarian nama terpusat');
    assert.match(authJs, /toLowerCase\(\)/, 'pencarian harus lowercase');
    assert.match(authJs, /usersBackup/, 'harus menulis cadangan otomatis');
    assert.match(authJs, /CORRUPT_KEY/, 'data korup harus disimpan, bukan dibuang');
    assert.match(authJs, /visibilitychange/, 'sinkron antar-tab juga saat tab kembali terlihat');
    assert.match(authJs, /export function importUsers/, 'impor cadangan');
    assert.match(authJs, /record\.remote/, 'akun cermin server diterima saat impor');
});

test('cadangkan/pulihkan akun: berkas + kode sinkron, dibatasi ukuran', () => {
    assert.match(accountBackup, /KZ1-/, 'kode sinkron teks');
    assert.match(accountBackup, /KZ1Z-/, 'kode sinkron terkompresi');
    assert.match(accountBackup, /deflate-raw/, 'kompresi bawaan peramban');
    assert.match(accountBackup, /const MAX_USERS = 50;/, 'batas jumlah akun');
    assert.match(accountBackup, /restoreBundle/, 'fungsi pemulihan');
    assert.match(accountModal, /accountDownloadBtn/, 'tombol unduh berkas');
    assert.match(accountModal, /accountRestoreFile/, 'input berkas pemulihan');
    assert.match(accountModal, /accountSyncCode|accountCodeOutput/, 'kotak kode sinkron');
    // Permintaan: konfirmasi sebelum menimpa akun yang sudah ada.
    assert.match(accountModal, /window\.confirm\(/, 'harus ada konfirmasi sebelum menimpa');
    assert.match(navbarJs, /data-action="backup"/);
    assert.match(navbarJs, /data-action="restore"/);
    assert.match(navbarJs, /data-action="sync"/);
    assert.match(layoutJs, /onBackup: handleBackup/);
    assert.match(layoutJs, /onRestore: handleRestore/);
    assert.match(layoutJs, /onSync: handleSync/);
    // Tombol sinkron hanya tampil bila server akun benar-benar aktif.
    assert.match(navbarJs, /export function setNavSyncAvailable/);
    assert.match(layoutJs, /setNavSyncAvailable\(Boolean\(status\.enabled\)\)/);
});

test('server akun: klien memakai token Bearer, status aman, dan tidak memblokir fitur lokal', () => {
    assert.match(accountApi, /\/api\/accounts/);
    assert.match(accountApi, /Authorization: `Bearer \$\{token\}`/);
    assert.match(accountApi, /accountServerStatus/, 'status tidak boleh melempar error');
    assert.match(accountSync, /lokal dulu|localPayload/i);
    assert.match(accountSync, /registerRemote|loginRemote/);
    assert.match(layoutJs, /accountSync\.loginRemote/, 'login lokal gagal → coba server');
    // Token disimpan di kunci khusus (bukan menumpang data akun).
    assert.match(config, /accountToken: 'kazanime-account-token'/);
});

test('avatar: setiap preset punya gambar yang ada; URL Kitsu tidak lagi disusun otomatis', () => {
    const block = config.slice(config.indexOf('export const AVATARS'), config.indexOf(']);', config.indexOf('export const AVATARS')));
    const entries = [...block.matchAll(/\{ id: (\d+),\s*name: '([^']+)',\s*img: ([^,}]+)(?:,\s*card: ([^}]+))?/g)];
    assert.equal(entries.length, 25, 'harus ada 25 avatar preset');
    assert.doesNotMatch(block, /characters\/images\/\$\{id\}/, 'jangan menyusun URL Kitsu');
    const localFiles = [];
    for (const [, id, name, imgRaw, cardRaw] of entries) {
        const img = imgRaw.trim();
        const isKitsu = img.startsWith("'") && img.includes('media.kitsu.app/character/');
        assert.ok(isKitsu || img.includes('LOCAL_AVATAR'),
            `avatar ${id} (${name}) harus foto Kitsu ber-hash atau ilustrasi lokal`);
        // URL Kitsu WAJIB ber-hash (`/image/large-<hash>.jpeg`) → hasil verifikasi API.
        if (img.includes('media.kitsu.app')) {
            assert.match(img, /\/image\/large-[0-9a-f]{32}\.jpeg/, `avatar ${id} (${name}) memakai URL tanpa hash`);
        } else {
            const match = img.match(/LOCAL_AVATAR\('([^']+)'\)/);
            assert.ok(match, `avatar ${id} lokal harus menunjuk berkas`);
            localFiles.push(match[1]);
            assert.ok(cardRaw, `avatar lokal ${id} harus punya kartu SVG cadangan`);
        }
    }
    assert.equal(localFiles.length, 7, 'tujuh karakter tanpa data Kitsu memakai ilustrasi lokal');
    for (const file of localFiles) {
        const full = path.join(root, 'assets/avatars', file);
        assert.ok(fs.existsSync(full), `${file} harus ada di assets/avatars`);
        assert.ok(fs.statSync(full).size > 4096, `${file} tidak boleh kosong`);
    }
});

test('avatar: rantai fallback foto → kartu → emoji dipakai di navbar & modal', () => {
    assert.match(domJs, /export function avatarFallbackChain/);
    assert.match(domJs, /split\('\|'\)/, 'rantai data-fallback');
    assert.match(navbarJs, /avatarFallbackChain/);
    assert.match(read('js/ui/auth-modal.js'), /data-fallback="\$\{avatarFallbackChain\(a\)\}"/);
    assert.match(read('js/ui/auth-modal.js'), /AVATAR_UPLOAD\.maxDataUrlBytes/, 'kompresi ulang bila terlalu besar');
    assert.match(config, /maxBytes: 12 \* 1024 \* 1024/, 'foto ponsel 12 MB diterima');
});

test('pencarian: tab AnimeKu & Oploverz + hitungan per sumber', () => {
    assert.match(routesJs, /SEARCH_SOURCES = Object\.freeze\(\['all', 'backend:animeku', 'backend:oploverz', 'kitsu', 'anilist'\]\)/);
    assert.match(searchHtml, /data-source="backend:animeku"/);
    assert.match(searchHtml, /data-source="backend:oploverz"/);
    assert.match(searchHtml, /data-count="backend:animeku"/);
    assert.match(searchHtml, /data-count="backend:oploverz"/);
    assert.match(searchJs, /isSiteTab/);
    assert.match(searchJs, /siteOfTab/);
    assert.match(searchJs, /state\.siteItems\.filter/, 'hitungan tab situs dihitung dari hasil');
    assert.match(searchJs, /filtersEl\.hidden = mode === 'search' && isSiteTab\(state\.source\)/, 'filter katalog disembunyikan di tab situs');
    assert.match(searchJs, /judul siap tonton/, 'subjudul tab situs menjelaskan isinya');
    assert.match(searchJs, /Mencari dari AniList, Kitsu, AnimeKu & Oploverz/);
    // Hasil situs tidak boleh ikut paginasi katalog.
    assert.match(searchJs, /if \(isSiteTab\(state\.source\)\) return false;/);
    assert.match(read('css/search.css'), /\.src-dot--animeku\{/);
    assert.match(read('css/search.css'), /\.src-dot--oploverz\{/);
});

test('halaman tonton: judul berada di ATAS player', () => {
    const title = watchHtml.indexOf('id="watchTitle"');
    const player = watchHtml.indexOf('id="playerWrapper"');
    assert.ok(title > 0 && player > 0);
    assert.ok(title < player, 'judul harus dirender sebelum player');
    assert.match(watchHtml, /class="watch-title-row watch-title-row--top"/);
    assert.match(read('css/watch.css'), /\.watch-title-row--top\{/);
    // Bookmark tetap di baris judul (tes lama memakai id ini).
    const row = watchHtml.slice(title, watchHtml.indexOf('</div>', watchHtml.indexOf('id="watchBookmarkBtn"')));
    assert.match(row, /id="watchBookmarkBtn"/);
});
