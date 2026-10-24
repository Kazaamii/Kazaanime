/**
 * Kazanime — round20-sources-donghua.test.js
 * Putaran 20 (24 Okt 2026).
 *
 * Dua permintaan pengguna:
 *  1. *"setau saya Animeloverz dan Animeku mengandung donghua apa benar jika iya tolong
 *     bantu tambahkan donghua dari sana"* — benar: keduanya punya donghua, dan bagian
 *     Donghua di beranda + katalog harus tetap bersumber dari AnimeKu & Oploverz
 *     (bukan hanya metadata AniList).
 *  2. *"kuramanime dan anichin hapus saja karna memang tidak bekerja dibeberapa test"* —
 *     adapter, konfigurasi, fixture, dan test keduanya dihapus, BUKAN sekadar dimatikan.
 *
 * Yang dikunci tes ini:
 *  - Anichin & Kuramanime tidak ada lagi di FACTORIES, SOURCES, daftar default, maupun
 *    sebagai file adapter/test.
 *  - Sumber yang masih dipakai tidak ikut hilang (animexin, anoboy, hianime, animeku, oploverz).
 *  - Donghua AnimeKu & Oploverz tetap punya `browseDonghua` + benih judul, sehingga panel
 *    tetap terisi walau metadata AniList (negara CN) mati.
 *  - Beranda tetap merender dua panel Donghua dan katalog tetap menautkan keduanya.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

const { FACTORIES } = await import('../sources/index.js');
const { SOURCES } = await import('../config.js');
const { DONGHUA_SEEDS: ANIMEKU_SEEDS, createAnimeku } = await import('../sources/animeku.js');
const { DONGHUA_SEEDS: OPLOVERZ_SEEDS, createOploverz } = await import('../sources/oploverz.js');

test('putaran 20: adapter & test Anichin/Kuramanime benar-benar dihapus', () => {
    for (const gone of ['anichin', 'kuramanime']) {
        assert.equal(FACTORIES[gone], undefined, `${gone} masih terdaftar di FACTORIES`);
        assert.equal(Object.hasOwn(SOURCES, gone), false, `${gone} masih punya konfigurasi SOURCES`);
        assert.equal(SOURCES.enabled.includes(gone), false, `${gone} masih aktif secara default`);
        assert.equal(exists(`server/sources/${gone}.js`), false, `file adapter ${gone}.js masih ada`);
        assert.equal(exists(`server/test/${gone}.test.js`), false, `file test ${gone}.test.js masih ada`);
    }
    const fixtures = fs.readdirSync(path.join(root, 'server/test/fixtures'));
    assert.deepEqual(
        fixtures.filter((name) => /anichin|kuramanime/i.test(name)),
        [],
        'fixture Anichin/Kuramanime harus ikut dihapus',
    );
});

test('putaran 20: sumber yang bekerja tetap lengkap (tidak ikut terhapus)', () => {
    for (const kept of ['animexin', 'anoboy', 'hianime', 'animeku', 'oploverz']) {
        assert.equal(typeof FACTORIES[kept], 'function', `${kept} kehilangan factory`);
        assert.ok(SOURCES.enabled.includes(kept), `${kept} hilang dari daftar default`);
    }
    // Adapter lama yang hanya dimatikan (bukan dihapus) tetap bisa diaktifkan lewat env.
    for (const optIn of ['samehadaku', 'otakudesu', 'sakunime']) {
        assert.equal(typeof FACTORIES[optIn], 'function', `${optIn} seharusnya masih tersedia`);
        assert.equal(SOURCES.enabled.includes(optIn), false, `${optIn} tidak boleh aktif default`);
    }
});

test('putaran 20: donghua AnimeKu & Oploverz punya benih sendiri (tahan metadata mati)', () => {
    const animeku = createAnimeku({ network: null, createClient: () => ({}), baseUrl: 'https://ww2.animeku.lol' });
    const oploverz = createOploverz({ network: null, createClient: () => ({}), baseUrl: 'https://oploverz.ch' });

    for (const [id, adapter, seeds] of [
        ['animeku', animeku, ANIMEKU_SEEDS],
        ['oploverz', oploverz, OPLOVERZ_SEEDS],
    ]) {
        assert.equal(typeof adapter.browseDonghua, 'function', `${id} tanpa browseDonghua`);
        assert.ok(Array.isArray(adapter.donghuaSeeds), `${id} tanpa benih donghua`);
        assert.deepEqual([...adapter.donghuaSeeds], [...seeds], `${id} harus meneruskan benihnya`);
        assert.ok(adapter.donghuaSeeds.length >= 3, `${id} butuh minimal 3 benih`);
        assert.ok(adapter.donghuaSeeds.every((title) => typeof title === 'string' && title.length >= 4));
    }
    // Benih Oploverz diambil langsung dari daftar ekspor modul (bukan disalin di tes).
    assert.ok(OPLOVERZ_SEEDS.includes('Perfect World'));
});

test('putaran 20: beranda tetap menampilkan Donghua AnimeKu & Animeloverz dari katalog situs', () => {
    const homeJs = read('js/home.js');
    const homeHtml = read('index.html');
    const katalogJs = read('js/katalog.js');

    assert.match(homeJs, /const DONGHUA_SITE_IDS = \['animeku', 'oploverz'\]/);
    assert.match(homeJs, /getSourceBrowse\(id, \{ filter: 'donghua', refresh: refresh \|\| attempt > 1 \}\)/);
    assert.match(homeHtml, /id="donghuaSites"/);
    assert.match(homeHtml, /id="donghuaGrid"/);
    // Katalog: dua entri "Donghua di …" tetap ada untuk kedua situs.
    assert.match(katalogJs, /label: 'Donghua di AnimeKu'/);
    assert.match(katalogJs, /label: 'Donghua di Oploverz'/);
});

test('putaran 20: keterangan Oploverz jujur soal hasil pencariannya (cek 24 Okt 2026)', () => {
    const katalogJs = read('js/katalog.js');
    // Situsnya tidak memuat judul benih: jangan menjanjikan daftar terisi.
    assert.match(katalogJs, /Dicek 24 Okt 2026: oploverz\.ch tidak memuat judul-judul itu/);
    assert.match(katalogJs, /bagian ini wajar kosong/);
});

test('putaran 20: peta sumber Oploverz terdokumentasi dan cocok dengan adapter', () => {
    const doc = read('docs/OPLOVERZ.md');
    const adapter = read('server/sources/oploverz.js');

    // Dokumen tidak boleh memakai selektor yang sudah tidak ada di adapter.
    for (const selector of ['article.bs', '.eplister', 'dsu-server', '.spe > span']) {
        assert.ok(adapter.includes(selector), `adapter kehilangan selektor ${selector}`);
        assert.ok(doc.includes(selector), `docs/OPLOVERZ.md tidak menyebut ${selector}`);
    }
    // Klaim penting: Oploverz bukan sumber donghua saat dicek 24 Okt 2026.
    assert.match(doc, /saat ini tidak memuat donghua/);
    assert.match(doc, /tidak ada di paket|Tidak memakai Oploverz|tidak memakai Oploverz/i);
});
