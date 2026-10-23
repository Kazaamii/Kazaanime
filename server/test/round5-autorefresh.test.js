import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isRetryableError, withAutoRetry } from '../../js/api/retry.js';
import { mapLimit } from '../lib/concurrency.js';

/**
 * Ronde 5 (24 Okt 2026) — permintaan pengguna:
 * "tambahkan auto refresh nya untuk animeloverz dan animeku agar tidak gagal memuat".
 *
 * Yang dijaga:
 *  - percobaan ulang otomatis hanya untuk kegagalan sementara (timeout/jaringan/5xx/
 *    circuit). 403/429/challenge/robots TIDAK pernah diulang (tidak menerobos situs);
 *  - panel AnimeKu & Oploverz di beranda memakai percobaan ulang itu, punya tombol
 *    "Muat ulang", cadangan localStorage, dan muat ulang otomatis saat jaringan
 *    kembali / tab aktif lagi / data basi;
 *  - halaman Jelajah ikut memakai percobaan ulang yang sama.
 */
const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const homeHtml = read('index.html');
const homeJs = read('js/home.js');
const katalogJs = read('js/katalog.js');

const err = (kind, extra = {}) => Object.assign(new Error(kind), { kind, ...extra });

test('retry: hanya kegagalan sementara yang diulang', () => {
    assert.equal(isRetryableError(err('timeout')), true);
    assert.equal(isRetryableError(err('network')), true);
    assert.equal(isRetryableError(err('circuit')), true);
    assert.equal(isRetryableError(err('http', { status: 500 })), true);
    assert.equal(isRetryableError(err('http', { status: 503 })), true);

    // Tidak boleh diulang: bukan kegagalan sementara, atau justru pembatasan situs.
    assert.equal(isRetryableError(err('http', { status: 403 })), false, '403 = akses ditolak, tidak diulang');
    assert.equal(isRetryableError(err('http', { status: 429 })), false, '429 = rate limit, tunggu Retry-After');
    assert.equal(isRetryableError(err('http', { status: 404 })), false);
    assert.equal(isRetryableError(err('abort')), false);
    assert.equal(isRetryableError(err('blocked')), false);
    assert.equal(isRetryableError(err('disabled')), false);
    assert.equal(isRetryableError(null), false);
});

test('retry: percobaan kedua berhasil, percobaan ketiga tidak dipakai', async () => {
    let calls = 0;
    const retries = [];
    const value = await withAutoRetry(
        async () => {
            calls += 1;
            if (calls === 1) throw err('timeout');
            return 'ok';
        },
        { onRetry: (attempt) => retries.push(attempt), sleep: async () => {} },
    );
    assert.equal(value, 'ok');
    assert.equal(calls, 2);
    assert.deepEqual(retries, [2]);
});

test('retry: menyerah setelah percobaan habis, tanpa menelan error asli', async () => {
    let calls = 0;
    await assert.rejects(
        withAutoRetry(async () => {
            calls += 1;
            throw err('network');
        }, { sleep: async () => {} }),
        /network/,
    );
    assert.equal(calls, 2, 'dua percobaan total (bawaan)');
});

test('retry: error non-sementara langsung dilempar tanpa percobaan kedua', async () => {
    let calls = 0;
    await assert.rejects(
        withAutoRetry(async () => {
            calls += 1;
            throw err('http', { status: 403 });
        }, { sleep: async () => {} }),
        /403|http/,
    );
    assert.equal(calls, 1);
});

test('retry: jumlah percobaan bisa diatur dan jeda bertambah', async () => {
    const waits = [];
    let calls = 0;
    await assert.rejects(
        withAutoRetry(async () => {
            calls += 1;
            throw err('timeout');
        }, { attempts: 3, delay: 100, sleep: async (ms) => { waits.push(ms); } }),
        /timeout/,
    );
    assert.equal(calls, 3);
    assert.deepEqual(waits, [100, 200]);
});

test('beranda: tombol "Muat ulang" untuk bagian Donghua situs', () => {
    assert.match(homeHtml, /id="donghuaRefresh"[^>]*aria-label="Muat ulang donghua AnimeKu &amp; Oploverz"/);
    assert.match(homeHtml, /id="donghuaRefresh"[\s\S]{0,400}data-icon="refresh-cw"/);
    assert.match(homeJs, /const donghuaRefreshBtn = \$\('#donghuaRefresh'\)/);
    assert.match(homeJs, /async function refreshDonghuaSites\(\)/);
    assert.match(homeJs, /donghuaRefreshBtn\?\.addEventListener\('click'/);
});

test('beranda: panel AnimeKu & Oploverz memakai percobaan ulang otomatis', () => {
    assert.match(homeJs, /import \{ withAutoRetry \} from '\.\/api\/retry\.js'/, 'memakai modul retry bersama');
    assert.match(homeJs, /getSourceBrowse\(id, \{ filter: 'donghua', refresh: refresh \|\| attempt > 1 \}\)/,
        'percobaan kedua melewati circuit breaker yang baru terbuka');
    assert.match(homeJs, /attempts: retry \? 2 : 1/);
    assert.match(homeJs, /error: res\.error \|\| null/, 'kegagalan sebagian backend tetap dilaporkan sebagai gagal');
});

test('beranda: hasil terakhir dipakai bila situs benar-benar tidak bisa dihubungi', () => {
    assert.match(homeJs, /const DONGHUA_CACHE_KEY = 'kz:donghua-last'/);
    assert.match(homeJs, /function readDonghuaCache\(\)/);
    assert.match(homeJs, /function writeDonghuaCache\(panels\)/);
    assert.match(homeJs, /writeDonghuaCache\(panels\);/);
    assert.match(homeJs, /const cached = readDonghuaCache\(\);/);
    assert.match(homeJs, /Menampilkan data tersimpan/);
});

test('beranda: muat ulang otomatis saat jaringan kembali / tab aktif / data basi', () => {
    assert.match(homeJs, /function autoRefreshSources\(\{ ignoreGap = false \} = \{\}\)/);
    assert.match(homeJs, /function sectionNeedsRefresh\(state, lastOkAt, entriesOf, now = Date\.now\(\)\)/);
    assert.match(homeJs, /const AUTO_REFRESH_STALE_MS = 15 \* 60 \* 1000/);
    assert.match(homeJs, /const AUTO_REFRESH_TICK_MS = 5 \* 60 \* 1000/);
    assert.match(homeJs, /setInterval\(\(\) => autoRefreshSources\(\), AUTO_REFRESH_TICK_MS\)/);
    assert.match(homeJs, /window\.addEventListener\('online'/);
    assert.match(homeJs, /document\.addEventListener\('visibilitychange'/);
    // Setelah gagal: jeda bertahap, berhenti setelah tiga percobaan.
    assert.match(homeJs, /const AUTO_RETRY_PLAN_MS = \[15000, 45000, 120000\]/);
    assert.match(homeJs, /function scheduleAutoRefresh\(\)/);
    assert.match(homeJs, /scheduleAutoRefresh\(\);/);
    // Muat ulang latar tidak mengosongkan panel yang sudah terisi.
    assert.match(homeJs, /async function loadDonghuaSites\(options = \{\}\)/);
    assert.match(homeJs, /async function loadSubIndoSection\(\{ refresh = false, retry = true, quiet = false \} = \{\}\)/);
    assert.match(homeJs, /void loadDonghuaSites\(\{ refresh: true, quiet: Boolean\(donghuaState\) \}\)/);
    assert.match(homeJs, /void loadSubIndoSection\(\{ refresh: true, quiet: Boolean\(subIndoState\) \}\)/);
    // Donghua tetap dimuat sesuai posisi layar, bukan di awal halaman.
    assert.match(homeJs, /whenVisible\(\$\('#donghua'\), loadDonghuaSites\)/);
});

test('mapLimit: hasil tetap urut dan konkurensi dibatasi', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50], 'urutan hasil sama dengan urutan input');
    assert.ok(peak <= 2, `konkurensi tidak melebihi batas (puncak ${peak})`);
    assert.deepEqual(await mapLimit([], 3, async (n) => n), []);
});

test('donghua: pencarian situs dijalankan paralel berbatas, bukan berurutan', () => {
    const animeku = read('server', 'sources', 'animeku.js');
    const oploverz = read('server', 'sources', 'oploverz.js');
    for (const [name, src] of [['animeku', animeku], ['oploverz', oploverz]]) {
        assert.match(src, /import \{ mapLimit \} from '\.\.\/lib\/concurrency\.js'/, `${name}: memakai helper konkurensi`);
        assert.match(src, /mapLimit\(queries, DONGHUA_CONCURRENCY/, `${name}: kueri diparalelkan berbatas`);
        assert.match(src, /const DONGHUA_CONCURRENCY = 3;/, `${name}: maksimal 3 kueri bersamaan`);
        assert.match(src, /if \(!items\.length && firstError\) throw firstError;/, `${name}: error hanya dilempar bila kosong total`);
    }
    // Pacing per host ~1 dtk/permintaan: lima kueri membuat respons melewati batas waktu klien.
    assert.match(animeku, /const DONGHUA_QUERIES = 3;/);
});

test('Jelajah: bagian katalog juga mencoba ulang otomatis', () => {
    assert.match(katalogJs, /import \{ withAutoRetry \} from '\.\/api\/retry\.js'/);
    assert.match(katalogJs, /await withAutoRetry\(\(attempt\) => getSourceBrowse\(state\.source, \{/);
    assert.match(katalogJs, /refresh: refresh \|\| attempt > 1/);
    assert.match(katalogJs, /Jaringan lambat — mencoba sekali lagi…/);
});
