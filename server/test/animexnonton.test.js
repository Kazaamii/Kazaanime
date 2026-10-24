/**
 * Kazanime — animexnonton.test.js
 * Putaran 22 (24 Okt 2026).
 *
 * Permintaan pengguna: *"Opsi A — peta sumber Oploverz … saya ingin kamu memeriksa source
 * yang anime dipake oleh aplikasi tersebut dan jika memungkinkan untuk di terapkan maka
 * terapkan juga"*.
 *
 * APK `Sumber APK.zip` (Miku Moe 3.6) memakai tiga sumber anime:
 *   1. Anime X Nonton  → `https://api.wincamp.web.id/animexnonton` (POST, tanda tangan AnxGuard)
 *   2. Animeku         → `https://apps.animekita.org/api/v1.2.5` (403 Apache — mati)
 *   3. Pencarinafkah   → `https://pencarinafkah.xyz/vA6//api` (200 tapi 0 byte — mati)
 * Hanya (1) yang mungkin diterapkan, dan hanya lewat snapshot tangkapan perangkat sendiri
 * (mode `capture`), karena string kanonik + IV AES-GCM AnxGuard belum direkonstruksi.
 *
 * Yang dikunci tes ini:
 *  - mode `off` (default) benar-benar tidak mendaftarkan adapter — situs tidak berubah;
 *  - mode `capture` membaca snapshot dengan benar (latest, search, genres, detail, episode);
 *  - mode `live` menolak dengan pesan jelas selama template kanonik belum ada, dan TIDAK
 *    pernah mengirim request ke server pihak lain;
 *  - mode tak dikenal diperlakukan sebagai `off` (fail closed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
    createAnimeXnonton, ID, MODES, NAME, POLICY,
} from '../sources/animexnonton.js';
import {
    ANX, deriveKeys, encryptBody, liveReady, resolveCert, signCanonical,
} from '../lib/anx-signer.js';
import { fixture } from './helpers.js';

const ROOT = process.cwd();
const CAPTURE = path.join(ROOT, 'server', 'test', 'fixtures', 'animexnonton.capture.json');

/** Adapter capture dengan berkas snapshot contoh. */
const captureAdapter = (extra = {}) => createAnimeXnonton({
    network: null,
    createClient: null,
    sourceConfig: { mode: 'capture', captureFile: CAPTURE },
    ...extra,
});

/** Tulis snapshot sementara (untuk kasus rusak/kosong). */
function tempCapture(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anx-'));
    const file = path.join(dir, 'capture.json');
    fs.writeFileSync(file, contents);
    return file;
}

test('animexnonton: mode off (default) tidak mendaftarkan adapter sama sekali', async () => {
    assert.equal(createAnimeXnonton({ sourceConfig: {} }), null);
    assert.equal(createAnimeXnonton({}), null);
    assert.equal(createAnimeXnonton({ sourceConfig: { mode: 'off', captureFile: CAPTURE } }), null);

    // Registry produksi: id boleh ada di SOURCES, tetapi tanpa mode adapter tidak muncul.
    const { createDefaultRegistry, FACTORIES } = await import('../sources/index.js');
    const { SOURCES } = await import('../config.js');
    assert.equal(typeof FACTORIES[ID], 'function', 'factory harus terdaftar agar bisa dipakai');
    assert.ok(SOURCES[ID], 'konfigurasi sumber harus ada');
    assert.equal(SOURCES[ID].mode, 'off', 'default harus off');
    const registry = createDefaultRegistry();
    const ids = registry.health().sources.map((source) => source.id);
    assert.equal(ids.includes(ID), false, 'adapter off tidak boleh muncul di /api/health');
    for (const kept of ['animexin', 'anoboy', 'animeku', 'oploverz', 'hianime']) {
        assert.ok(ids.includes(kept), `${kept} tidak boleh ikut hilang`);
    }
});

test('animexnonton: mode tak dikenal diperlakukan off (fail closed)', () => {
    assert.equal(createAnimeXnonton({ sourceConfig: { mode: 'on' } }), null);
    assert.equal(createAnimeXnonton({ sourceConfig: { mode: 'LIVE-ish' } }), null);
    assert.deepEqual([...MODES], ['off', 'capture', 'live']);
});

test('animexnonton: metadata adapter & kebijakan', () => {
    const adapter = captureAdapter();
    assert.equal(adapter.id, 'animexnonton');
    assert.equal(adapter.name, NAME);
    assert.equal(adapter.mode, 'capture');
    assert.equal(adapter.supportsBrowse, false, 'snapshot tidak punya paginasi/jelajah');
    assert.equal(adapter.usable, true);
    assert.equal(POLICY.tos.verdict, 'unknown');
    assert.equal(POLICY.robots, false, 'API JSON, bukan crawling HTML');
});

test('animexnonton: latest membaca snapshot (judul, slug, tahun, rating, episode)', async () => {
    const items = await captureAdapter().latest();
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((a) => a.slug), [
        'animexnonton~1001', 'animexnonton~1002', 'animexnonton~1003',
    ]);
    const [onePiece, frieren] = items;
    assert.equal(onePiece.title, 'CONTOH — One Piece');
    assert.equal(onePiece.source, ID);
    assert.equal(onePiece.country, 'JP');
    assert.equal(onePiece.year, 1999);
    assert.equal(onePiece.score, 8.7);
    assert.equal(onePiece.status, 'ONGOING');
    assert.equal(onePiece.latestEpisode, 1122);
    assert.deepEqual([...onePiece.genres], ['Action', 'Adventure', 'Fantasy']);
    assert.equal(frieren.status, 'COMPLETED');
    assert.equal(frieren.score, 9.1);
    // API tidak punya halaman web publik → url null, bukan URL karangan.
    assert.equal(onePiece.url, null);
});

test('animexnonton: search menyaring snapshot, detail & episode dari snapshot', async () => {
    const adapter = captureAdapter();
    const hits = await adapter.search('frieren');
    assert.deepEqual(hits.map((a) => a.slug), ['animexnonton~1002']);
    assert.deepEqual(await adapter.search('tidak-ada'), []);

    const detail = await adapter.getAnime({ id: '1001' });
    assert.equal(detail.title, 'CONTOH — One Piece');
    assert.deepEqual(detail.episodeList.map((e) => e.number), [1, 2]);

    const episode = await adapter.getEpisode({ id: '1001' }, 1, { anime: detail });
    assert.equal(episode.episode, 1);
    assert.equal(episode.servers.length, 1);
    assert.equal(episode.servers[0].kind, 'hls');
    assert.equal(episode.servers[0].url, 'https://example.com/embed/one-piece/1');

    await assert.rejects(() => adapter.getEpisode({ id: '1001' }, 99), (err) => err.kind === 'not_found');
    await assert.rejects(() => adapter.getAnime({ id: '9999' }), (err) => err.kind === 'not_found');
});

test('animexnonton: genres dari snapshot', async () => {
    const { genres } = await captureAdapter().genres();
    assert.deepEqual(genres.map((g) => g.label), ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Supernatural']);
    assert.equal(genres[0].id, 'action');
});

test('animexnonton: ref hanya id angka, judul cadangan jelas', () => {
    const adapter = captureAdapter();
    assert.deepEqual(adapter.parseRef(['1001']), { id: '1001' });
    assert.equal(adapter.parseRef(['one-piece']), null);
    assert.equal(adapter.parseRef(['1001', 'x']), null);
    assert.match(adapter.titleHint({ id: '1001' }), /#1001/);
});

test('animexnonton: capture tanpa berkas / berkas rusak → error config yang jelas', async () => {
    const noFile = createAnimeXnonton({ sourceConfig: { mode: 'capture', captureFile: '' } });
    await assert.rejects(() => noFile.latest(), (err) => err.kind === 'config' && /ANX_CAPTURE_FILE/.test(err.message));

    const broken = createAnimeXnonton({ sourceConfig: { mode: 'capture', captureFile: tempCapture('{ bukan json') } });
    await assert.rejects(() => broken.latest(), (err) => err.kind === 'config' && /tidak terbaca/.test(err.message));

    const missing = createAnimeXnonton({ sourceConfig: { mode: 'capture', captureFile: '/tmp/tidak-ada-anx.json' } });
    await assert.rejects(() => missing.latest(), (err) => err.kind === 'config');
});

test('animexnonton: mode live menolak tanpa template kanonik (tanpa menyentuh jaringan)', async () => {
    let calls = 0;
    const createClient = () => ({ request: async () => { calls += 1; return { status: 200, text: '{}', headers: new Headers() }; } });
    const adapter = createAnimeXnonton({
        network: {}, createClient, sourceConfig: { mode: 'live' },
    });
    assert.equal(adapter.mode, 'live');
    assert.equal(adapter.usable, false, 'live tanpa template belum bisa dipakai');

    await assert.rejects(
        () => adapter.latest(),
        (err) => err.kind === 'config' && /ANX_CANONICAL_TEMPLATE/.test(err.message),
    );
    await assert.rejects(() => adapter.search('one piece'), (err) => err.kind === 'config');
    assert.equal(calls, 0, 'tidak ada request yang dikirim ke server pihak lain');

    // Detail & episode tidak pernah dikarang di mode live.
    await assert.rejects(() => adapter.getAnime({ id: '1001' }), (err) => err.kind === 'config' && /snapshot/.test(err.message));
    await assert.rejects(() => adapter.getEpisode({ id: '1001' }, 1), (err) => err.kind === 'config');
});

test('animexnonton: mode live dengan template memakai client repo (network diteruskan)', async () => {
    const seen = [];
    const createClient = (network, opts) => {
        seen.push({ network, opts });
        return {
            request: async (url, init) => {
                seen.push({ url, init });
                return {
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    text: JSON.stringify({ status: 'success', posts: [{ cid: 7, channelName: 'Uji', countAnime: '3' }] }),
                };
            },
        };
    };
    const network = { circuit: 'net-uji' };
    const adapter = createAnimeXnonton({
        network,
        createClient,
        sourceConfig: { mode: 'live' },
    });
    // Template dipasang lewat env agar liveReady() bernilai true.
    const before = process.env.ANX_CANONICAL_TEMPLATE;
    process.env.ANX_CANONICAL_TEMPLATE = 'POST\\n{path}\\n{bodyHash}\\n{ts}\\n{nonce}';
    try {
        const built = createAnimeXnonton({ network, createClient, sourceConfig: { mode: 'live' } });
        assert.equal(built.usable, true);
        const items = await built.latest();
        assert.deepEqual(items.map((a) => a.slug), ['animexnonton~7']);
    } finally {
        if (before === undefined) delete process.env.ANX_CANONICAL_TEMPLATE;
        else process.env.ANX_CANONICAL_TEMPLATE = before;
    }
    assert.equal(seen[0].network, network, 'createClient harus menerima network milik repo, bukan null');
    assert.deepEqual(seen[0].opts.allowedHosts, ['api.wincamp.web.id']);
    const request = seen.find((entry) => entry.url);
    assert.match(request.url, /^https:\/\/api\.wincamp\.web\.id\/animexnonton\/new_api\/get_posts\/$/);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.headers['X-Anx-Ver'], '25');
    assert.equal(request.init.headers['X-Anx-Cert'], ANX.fallbackCert, 'cert-lock dari konstanta build, bukan fetch ke pastebin');
    assert.match(request.init.body, /^anx=/);
    assert.ok(request.init.headers['X-Anx-Sig']);
});

test('anx-signer: turunan kunci & enkripsi deterministik sesuai kontrak APK', () => {
    assert.equal(ANX.ver, '25');
    assert.equal(ANX.masterHex.length, 64);
    const a = deriveKeys();
    const b = deriveKeys();
    assert.deepEqual(a.masterKey, b.masterKey);
    assert.deepEqual(a.sigKey, b.sigKey);
    assert.notDeepEqual(a.masterKey, a.sigKey, 'label master & sig harus menghasilkan kunci berbeda');

    const { body, iv } = encryptBody(a.masterKey, 'page=1&isAPKvalid=25', 1700000000000);
    assert.match(body, /^anx=[A-Za-z0-9+/=]+$/);
    assert.equal(iv.length, 12);

    const sig = signCanonical(a.sigKey, 'kanonik');
    assert.match(sig, /^[0-9a-f]{64}$/);

    // resolveCert: hanya hex yang sah; selain itu jatuh ke konstanta build.
    assert.equal(resolveCert(), ANX.fallbackCert);
    assert.equal(resolveCert(''), ANX.fallbackCert);
    assert.equal(resolveCert('bukan-hex'), ANX.fallbackCert);
    assert.equal(resolveCert('96B4414E8477168C'), '96B4414E8477168C');

    assert.equal(liveReady(''), false);
    assert.equal(liveReady('POST {path}'), false);
    assert.equal(liveReady('POST\n{path}\n{bodyHash}\n{ts}'), true);
});

test('animexnonton: snapshot contoh di repo aman (semua judul berawalan CONTOH)', () => {
    const snap = JSON.parse(fixture('animexnonton.capture.json'));
    assert.ok(snap.posts.length >= 3);
    for (const post of snap.posts) {
        assert.match(post.channelName, /^CONTOH — /, 'fixture tidak boleh memakai judul asli');
    }
    assert.match(snap._note, /CONTOH/);
});
