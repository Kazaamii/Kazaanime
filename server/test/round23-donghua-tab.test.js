/**
 * Kazanime — round23-donghua-tab.test.js
 * Putaran 23 (24 Okt 2026).
 *
 * Permintaan pengguna: *"Perluas tab Donghua ke AnimeXin & HiAnime"* — kedua situs nyata-nyata
 * punya donghua (AnimeXin: situs donghua China; HiAnime: Soul Land, Battle Through the Heavens,
 * Perfect World, Douluo Dalu, Renegade Immortal, Throne of Seal, Shaonian Ge Xing/Anhe Zhuan).
 *
 * Yang dikunci tes ini:
 *  - `browseDonghua` HiAnime mencari tiap benih lalu hanya memakai kartu yang judulnya cocok;
 *  - `browseDonghua` AnimeXin memakai katalog `latest()` tanpa request tambahan;
 *  - daftar benih HiAnime berisi judul yang sudah diverifikasi ada di situs (24 Okt 2026);
 *  - registry melayani `/api/anime/browse?source=hianime&filter=donghua` lewat jalur yang sama
 *    dengan AnimeKu/Oploverz (tanpa kode khusus per situs);
 *  - tab Donghua di `js/katalog.js` benar-benar menunjuk sumber-sumber itu, dan setiap bagian
 *    punya kunci DOM unik (lima bagian boleh memakai id filter "donghua" yang sama).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createHianime, DONGHUA_SEEDS as HIANIME_SEEDS } from '../sources/hianime.js';
import { createAnimexin } from '../sources/animexin.js';
import { createRegistry } from '../sources/index.js';
import { TtlCache } from '../lib/cache.js';
import { makeAnime } from '../lib/anime.js';
import { CACHE } from '../config.js';
import { fakeClientFactory, fixture } from './helpers.js';

const ROOT = process.cwd();
const HIANIME_BASE = 'https://hianime.ro';
const ANIMEXIN_BASE = 'https://animexin.dev';

const hianime = (routes) => {
    const { createClient, calls } = fakeClientFactory(routes);
    return { adapter: createHianime({ network: {}, createClient, baseUrl: HIANIME_BASE }), calls };
};

test('hianime: browseDonghua hanya mengambil kartu yang judulnya cocok dengan benih', async () => {
    const searchUrl = `${HIANIME_BASE}/?s=One+Piece`;
    const { adapter, calls } = hianime({
        [searchUrl]: fixture('hianime-search.html'),
        [`${HIANIME_BASE}/?s=Naruto`]: fixture('hianime-search.html'),
    });

    const hit = await adapter.browseDonghua(['One Piece']);
    assert.equal(hit.length, 4, 'semua kartu One Piece cocok dengan kueri');
    assert.ok(hit.every((a) => a.source === 'hianime'));
    assert.deepEqual(hit.map((a) => a.slug)[0], 'hianime~one-piece-umi-no-heso-no-daibouken-hen~209821');

    // Kueri yang tidak cocok: kartu yang sama dikembalikan server, tetapi semuanya dibuang.
    const miss = await adapter.browseDonghua(['Naruto']);
    assert.deepEqual(miss, [], 'kartu dengan judul lain tidak boleh lolos');

    assert.deepEqual(calls, [`${HIANIME_BASE}/?s=One+Piece`, `${HIANIME_BASE}/?s=Naruto`]);
});

test('hianime: benih donghua adalah judul yang sudah diverifikasi ada (24 Okt 2026)', () => {
    assert.ok(HIANIME_SEEDS.length >= 6);
    for (const title of ['Soul Land', 'Battle Through the Heavens', 'Perfect World', 'Douluo Dalu', 'Renegade Immortal', 'Throne of Seal']) {
        assert.ok(HIANIME_SEEDS.includes(title), `${title} harus ada di benih`);
    }
    // Benih dipakai registry; adapter harus mengeksposnya.
    const { adapter } = hianime({});
    assert.equal(adapter.donghuaSeeds, HIANIME_SEEDS);
});

test('animexin: browseDonghua memakai katalog latest tanpa request tambahan', async () => {
    const routes = {
        [`${ANIMEXIN_BASE}/`]: fixture('animexin-home.html'),
        [`${ANIMEXIN_BASE}/anime/?status=&type=&order=update`]: fixture('animexin-list.html'),
    };
    const { createClient: c1 } = fakeClientFactory(routes);
    const adapter = createAnimexin({ network: {}, createClient: c1, baseUrl: ANIMEXIN_BASE });
    const latest = await adapter.latest();

    const { createClient: c2, calls } = fakeClientFactory(routes);
    const again = createAnimexin({ network: {}, createClient: c2, baseUrl: ANIMEXIN_BASE });
    const donghua = await again.browseDonghua(['abaikan benih']);
    assert.deepEqual(donghua.map((a) => a.slug), latest.slice(0, 24).map((a) => a.slug));
    assert.equal(calls.length, 2, 'hanya dua request yang sama seperti latest()');
    assert.deepEqual(again.donghuaSeeds, [], 'AnimeXin tidak perlu benih: seluruh katalognya donghua');
    assert.ok(donghua.every((a) => a.country === 'CN'));
});

test('registry: browse filter=donghua melayani hianime lewat jalur generik', async () => {
    // Semua benih dijawab fixture yang sama (One Piece) → tidak ada yang cocok, tanpa error.
    const routes = Object.fromEntries(HIANIME_SEEDS.map((title) => [
        `${HIANIME_BASE}/?s=${new URLSearchParams({ s: title }).toString().slice(2).replace(/\+/g, '+')}`,
        fixture('hianime-search.html'),
    ]));
    const { adapter } = hianime(routes);
    const metadata = { latestDonghua: async () => ({ provider: 'kitsu', items: [] }) };
    const registry = createRegistry({
        adapters: [adapter], metadata, cache: new TtlCache(), ttl: CACHE,
    });
    const res = await registry.browse({ source: 'hianime', filter: 'donghua' });
    assert.equal(res.source, 'hianime');
    assert.deepEqual(res.data.items, [], 'benih donghua tidak cocok dengan kartu One Piece');
    assert.equal(res.data.filter, 'donghua');

    // Dengan kueri yang cocok, item mengalir apa adanya.
    const ok = hianime({ [`${HIANIME_BASE}/?s=One+Piece`]: fixture('hianime-search.html') });
    const registry2 = createRegistry({
        adapters: [ok.adapter], metadata, cache: new TtlCache(), ttl: CACHE,
    });
    const res2 = await registry2.browse({ source: 'hianime', filter: 'donghua', q: 'One Piece' });
    assert.equal(res2.data.items.length, 4, 'pencarian dalam sumber tetap bekerja');
});

test('katalog UI: tab Donghua menampilkan HiAnime & AnimeXin, tiap bagian punya kunci unik', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'katalog.js'), 'utf8');
    assert.match(source, /label: 'Donghua di HiAnime'[\s\S]{0,120}source: 'hianime'/);
    assert.match(source, /label: 'Donghua di AnimeXin'[\s\S]{0,120}source: 'animexin'/);
    assert.match(source, /label: 'Donghua di AnimeKu'[\s\S]{0,120}source: 'animeku'/);
    assert.match(source, /label: 'Donghua di Oploverz'[\s\S]{0,120}source: 'oploverz'/);
    // Bagian boleh menimpa sumber tab (tanpa ini semua bagian jatuh ke tab "donghua").
    assert.match(source, /const browseSource = runtime\.def\.source \|\| state\.source;/);
    // Genre/tahun/musim tab tidak dipaksakan ke sumber lain, dan daftar genre situs lain
    // tidak menular ke kartu filter tab Donghua.
    assert.match(source, /const crossSource = browseSource !== state\.source;/);
    assert.match(source, /genre: crossSource \? '' : state\.genre,/);
    assert.match(source, /if \(!paged && !crossSource && \(res\.genres\.length \|\| res\.seasons\.length\)\)/);
    // "Lihat Semua" tidak boleh menunjuk tab yang tidak ada (HiAnime/AnimeXin bukan tab),
    // dan tetap menunjuk tab pemiliknya untuk AnimeKu/Oploverz.
    assert.match(source, /source: 'hianime',\s*seeAll: false,/);
    assert.match(source, /source: 'animexin',\s*seeAll: false,/);
    assert.match(source, /source: 'animeku',\s*\/\/ Tab AnimeKu juga punya bagian ini[\s\S]{0,80}seeAll: 'animeku',/);
    assert.match(source, /source: 'oploverz',\s*seeAll: 'oploverz',/);
    assert.match(source, /seeAll\.hidden = runtime\.def\.seeAll === false \|\|/);
    // Lima bagian ber-id "donghua" butuh kunci DOM unik, bukan def.id.
    assert.match(source, /key: `\$\{def\.id\}-\$\{index\}`/);
    assert.match(source, /data-section="\$\{runtime\.key\}"/);
    assert.match(source, /item\.key === entry\.target\.dataset\.section/);
    // Pesan jujur untuk sumber yang memang kosong.
    assert.match(source, /Oploverz tidak memuat donghua sejak 24 Okt 2026/);
});
