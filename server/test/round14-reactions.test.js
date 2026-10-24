/**
 * Uji putaran 14 (24 Okt 2026): tombol "Suka" + hitungan live ("Jejak"), dan
 * pembersihan baris "Cek pilihan subtitle" di halaman nonton.
 *
 * Permintaan pengguna:
 *   "Untuk judul sudah benar dalam posisi. tapi ada kalimat Cek Pilihan Subtitle nya
 *    Tolong pindah kan ditempat yang benar baik nya dihapus/di pindahkan optimalkan juga
 *    untu tampilan desktop agar bagus lalu tambahkan tombol Like/Count Live Untuk Jejak
 *    jika memungkinkan dan optimalisasi lagi."
 *
 * Cakupan:
 *   1. Router /api/reactions (GET hitungan, GET status, POST suka/batal, validasi).
 *   2. Penyimpanan (satu suka per pengunjung, batas key, mode nonaktif).
 *   3. Statis: HTML halaman nonton punya tombol suka + chip episode, tanpa baris
 *      "Cek pilihan subtitle"; CSS punya aturan desktop & ponsel untuk tombol suka.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.js';
import { createReactionStore, createMemoryAdapter, normalizeKey, normalizeVisitor, MAX_VISITORS_PER_KEY } from '../lib/reaction-store.js';
import { MAX_KEYS_PER_REQUEST, readKeys } from '../routes/reactions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Buang komentar supaya pernyataan "tidak ada teks X" tidak tertipu komentar. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const VISITOR = 'visitor-uji-0001';
const VISITOR_2 = 'visitor-uji-0002';

/** Aplikasi + server sementara dengan penyimpanan memori (tidak menyentuh disk). */
async function withApp(fn, { store } = {}) {
    const reactionStore = store || createReactionStore({ adapter: createMemoryAdapter(), mode: 'memory' });
    const app = createApp({
        registry: { network: null },
        log: false,
        rateLimitPerMinute: 0,
        budgetMs: 3000,
        reactionStore,
    });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await fn(base, reactionStore);
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
}

const post = (base, key, body) =>
    fetch(`${base}/api/reactions/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });

/* ------------------------------------------------------------------ */
/* 1. Penyimpanan                                                      */
/* ------------------------------------------------------------------ */
test('putaran 14: normalizeKey/normalizeVisitor menolak input berbahaya', () => {
    assert.equal(normalizeKey('animeku~judul-satu~ep3'), 'animeku~judul-satu~ep3');
    assert.equal(normalizeKey('  AnimeKu~Judul~Ep3 '), 'animeku~judul~ep3');
    for (const bad of ['', '../etc/passwd', 'a b', '-awal', 'x'.repeat(130), 'kunci/dengan/slash']) {
        assert.equal(normalizeKey(bad), null, `key harus ditolak: ${bad}`);
    }
    assert.equal(normalizeVisitor(VISITOR), VISITOR);
    for (const bad of ['', 'pendek', 'huruf besar', 'tanda!seru', 'x'.repeat(70)]) {
        assert.equal(normalizeVisitor(bad), null, `visitor harus ditolak: ${bad}`);
    }
});

test('putaran 14: satu pengunjung hanya dihitung sekali per episode', async () => {
    const store = createReactionStore({ adapter: createMemoryAdapter(), mode: 'memory' });
    const key = 'animeku~uji~ep1';
    assert.deepEqual(await store.setLike(key, VISITOR, true), { count: 1, liked: true });
    // Klik berulang / refresh tidak menambah hitungan.
    assert.deepEqual(await store.setLike(key, VISITOR, true), { count: 1, liked: true });
    assert.deepEqual(await store.setLike(key, VISITOR_2, true), { count: 2, liked: true });
    // Batal suka.
    assert.deepEqual(await store.setLike(key, VISITOR, false), { count: 1, liked: false });
    // Batal dua kali tetap aman.
    assert.deepEqual(await store.setLike(key, VISITOR, false), { count: 1, liked: false });
    assert.deepEqual(await store.counts([key, 'animeku~uji~ep2']), { [key]: 1, 'animeku~uji~ep2': 0 });
});

test('putaran 14: penyimpanan nonaktif tetap menjawab tanpa melempar galat', async () => {
    const store = createReactionStore({ adapter: null, mode: 'off', reason: 'uji' });
    assert.equal(store.enabled, false);
    assert.equal(store.provider, 'none');
    assert.deepEqual(await store.counts(['a~ep1']), { 'a~ep1': 0 });
    const result = await store.setLike('a~ep1', VISITOR, true);
    assert.equal(result.count, 0);
    assert.equal(result.disabled, true);
    const status = await store.status();
    assert.equal(status.enabled, false);
    assert.equal(status.mode, 'off');
    assert.equal(status.reason, 'uji');
});

test('putaran 14: batas pengunjung per key dijaga', async () => {
    assert.ok(MAX_VISITORS_PER_KEY >= 1000);
    const adapter = createMemoryAdapter();
    const key = 'a~ep1';
    for (let i = 0; i < 20; i += 1) await adapter.like(key, `visitor-${String(i).padStart(4, '0')}`);
    const { count } = await adapter.counts([key]).then((c) => ({ count: c[key] }));
    assert.equal(count, 20);
});

/* ------------------------------------------------------------------ */
/* 2. Router                                                           */
/* ------------------------------------------------------------------ */
test('putaran 14: GET /api/reactions mengembalikan hitungan live tanpa cache', async () => {
    await withApp(async (base, store) => {
        await store.setLike('animeku~uji~ep1', VISITOR, true);
        await store.setLike('animeku~uji~ep1', VISITOR_2, true);
        await store.setLike('animeku~uji~ep2', VISITOR, true);

        const res = await fetch(`${base}/api/reactions?keys=animeku~uji~ep1,animeku~uji~ep2,animeku~uji~ep9`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.source, 'reactions');
        assert.deepEqual(body.data.counts, {
            'animeku~uji~ep1': 2,
            'animeku~uji~ep2': 1,
            'animeku~uji~ep9': 0,
        });
        assert.equal(body.data.enabled, true);
        assert.equal(body.data.provider, 'memory');
    });
});

test('putaran 14: GET /api/reactions/status melaporkan mode penyimpanan', async () => {
    await withApp(async (base) => {
        const body = await (await fetch(`${base}/api/reactions/status`)).json();
        assert.equal(body.ok, true);
        assert.equal(body.data.enabled, true);
        assert.equal(body.data.mode, 'memory');
        assert.equal(body.data.persistent, false);
    });
});

test('putaran 14: POST suka idempoten dan bisa dibatalkan', async () => {
    await withApp(async (base, store) => {
        const first = await post(base, 'animeku~uji~ep3', { liked: true, visitor: VISITOR });
        assert.equal(first.status, 200);
        assert.deepEqual((await first.json()).data, { key: 'animeku~uji~ep3', count: 1, liked: true, enabled: true });

        const again = await post(base, 'animeku~uji~ep3', { liked: true, visitor: VISITOR });
        assert.equal((await again.json()).data.count, 1, 'klik kedua tidak menambah hitungan');

        const other = await post(base, 'animeku~uji~ep3', { liked: true, visitor: VISITOR_2 });
        assert.equal((await other.json()).data.count, 2);

        const undo = await post(base, 'animeku~uji~ep3', { liked: false, visitor: VISITOR });
        assert.deepEqual((await undo.json()).data, { key: 'animeku~uji~ep3', count: 1, liked: false, enabled: true });
        assert.deepEqual(await store.counts(['animeku~uji~ep3']), { 'animeku~uji~ep3': 1 });
    });
});

test('putaran 14: input tidak valid ditolak 400 (key, visitor, liked)', async () => {
    await withApp(async (base) => {
        assert.equal((await fetch(`${base}/api/reactions?keys=`)).status, 400);
        assert.equal((await fetch(`${base}/api/reactions?keys=../etc/passwd`)).status, 400);
        assert.equal((await fetch(`${base}/api/reactions/status`)).status, 200);
        assert.equal((await post(base, 'animeku~uji~ep4', { liked: true, visitor: 'pendek' })).status, 400);
        assert.equal((await post(base, 'animeku~uji~ep4', { liked: 'ya', visitor: VISITOR })).status, 400);
        assert.equal((await post(base, 'animeku~uji~ep4', { visitor: VISITOR })).status, 400);
        assert.equal((await post(base, 'animeku~uji~ep4', { liked: true })).status, 400);
    });
});

test('putaran 14: maksimal 20 key per permintaan', async () => {
    assert.equal(MAX_KEYS_PER_REQUEST, 20);
    const keys = Array.from({ length: 20 }, (_, i) => `a~ep${i + 1}`);
    assert.equal(readKeys(keys.join(',')).length, 20);
    assert.throws(() => readKeys([...keys, 'a~ep21'].join(',')), /Maksimal 20 key/);
    assert.equal(readKeys('a~ep1,a~ep1,a~ep2').length, 2, 'key ganda dibuang');
    await withApp(async (base) => {
        const tooMany = await fetch(`${base}/api/reactions?keys=${[...keys, 'a~ep21'].join(',')}`);
        assert.equal(tooMany.status, 400);
    });
});

test('putaran 14: saat penyimpanan dimatikan API tetap 200 dengan enabled:false', async () => {
    const store = createReactionStore({ adapter: null, mode: 'off', reason: 'REACTION_STORE=off' });
    await withApp(async (base) => {
        const list = await (await fetch(`${base}/api/reactions?keys=a~ep1`)).json();
        assert.equal(list.ok, true);
        assert.equal(list.data.enabled, false);
        assert.deepEqual(list.data.counts, { 'a~ep1': 0 });

        const liked = await (await post(base, 'a~ep1', { liked: true, visitor: VISITOR })).json();
        assert.equal(liked.data.count, 0);
        assert.equal(liked.data.enabled, false);
    }, { store });
});

/* ------------------------------------------------------------------ */
/* 3. Statis (HTML/CSS/JS halaman nonton)                              */
/* ------------------------------------------------------------------ */
test('putaran 14: baris "Cek pilihan subtitle" hilang dari halaman nonton', () => {
    const html = stripComments(read('watch.html'));
    const script = stripComments(read('js/watch.js'));
    assert.ok(!/Cek pilihan subtitle/i.test(html), 'watch.html tidak boleh memuat "Cek pilihan subtitle"');
    assert.ok(!/Cek pilihan subtitle/i.test(script), 'js/watch.js tidak boleh merender "Cek pilihan subtitle"');
    assert.ok(!/Episode \d+ • Cek/i.test(script));
});

test('putaran 14: nomor episode tampil sebagai chip di dekat judul', () => {
    const html = read('watch.html');
    assert.match(html, /class="watch-title-row watch-title-row--top"/, 'posisi judul (putaran 10) tidak berubah');
    assert.match(html, /id="watchEpisodeLabel"[\s\S]{0,200}class="watch-ep-chip"/);
    const script = read('js/watch.js');
    assert.match(script, /watch-ep-chip/);
    assert.match(script, /renderEpisodeLabel/);
});

test('putaran 14: tombol suka + hitungan ada di baris aksi judul', () => {
    const html = stripComments(read('watch.html'));
    assert.match(html, /class="watch-title-actions"/);
    assert.match(html, /id="watchLikeBtn"[\s\S]{0,400}id="watchLikeCount"/);
    assert.match(html, /id="watchLikeBtn"[^>]*aria-pressed="false"/);
    assert.match(html, /id="watchBookmarkBtn"/, 'tombol bookmark tetap ada');

    const script = stripComments(read('js/watch.js'));
    assert.match(script, /services\/reactions\.js/);
    assert.match(script, /refreshLikes/);
    assert.match(script, /setReaction\(/);
    assert.match(script, /startLikePolling/);
    assert.match(script, /setInterval\(/, 'hitungan diperbarui berkala (live)');
});

test('putaran 14: layanan suka memakai kunci episode yang stabil + jejak lokal', () => {
    const script = read('js/services/reactions.js');
    assert.match(script, /export function episodeKey/);
    assert.match(script, /export async function getReactionCounts/);
    assert.match(script, /export async function setReaction/);
    assert.match(script, /\/api\/reactions/);
    const config = read('js/config.js');
    assert.match(config, /visitor:\s*'kz:visitor'/);
    assert.match(config, /likes:\s*'kz:likes'/);
});

test('putaran 14: CSS mengatur tombol suka dan tampilan desktop', () => {
    const css = read('css/watch.css');
    assert.match(css, /\.watch-title-actions\s*\{/);
    assert.match(css, /\.watch-like-btn\s*\{/);
    assert.match(css, /\.watch-like-btn\.is-on\s*\{/);
    assert.match(css, /\.like-count\s*\{/);
    assert.match(css, /\.watch-ep-chip\s*\{/);
    assert.match(css, /@media\(min-width:1025px\)/, 'ada polesan khusus desktop');
    // Ponsel: label "Suka" disembunyikan, angka tetap terlihat.
    const mobile = css.slice(css.indexOf('@media(max-width:768px)'));
    assert.match(mobile, /\.watch-like-btn \.like-label\{[^}]*clip:rect\(0,0,0,0\)/);
    assert.match(mobile, /\.watch-like-btn \.like-count\{[^}]*min-width/);
    assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length, 'kurung kurawal CSS seimbang');
});
