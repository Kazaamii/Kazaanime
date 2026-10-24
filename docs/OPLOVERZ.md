# Peta Sumber Oploverz (Animeloverz)

Status: **adapter produksi** — `server/sources/oploverz.js`
Situs: `https://oploverz.ch` (default, atur lewat `OPLOVERZ_BASE_URL`)
Di UI disebut **Animeloverz** (`PLAYER.siteLabels.oploverz = 'Animeloverz'`).
Terakhir diperiksa: **24 Oktober 2026**.

Dokumen ini menggantikan "analisis API Oploverz" yang tidak ada di paket
`Sumber APK.zip` (lihat §10). Isinya memisahkan **yang terbukti dari kode/fixture**,
**yang diuji live**, dan **batas yang tidak bisa ditutup**.

---

## 1. Ringkas

| Aspek | Nilai |
|---|---|
| Jenis sumber | HTML WordPress, tema **dramastream/themesia** |
| API resmi | **tidak ada** (tanpa REST/JSON publik yang dipakai; `?rest_route=` tidak dipanggil) |
| Halaman yang dipakai | beranda `/`, daftar `/series/`, seri `/series/<slug>/`, episode `/<slug-episode-N-subtitle-indonesia>/` |
| Katalog | kartu `article.bs` |
| Server video | tombol `.dsu-server[data-url]` (fallback `#embed_holder iframe`) |
| Unduhan | **tidak disediakan** adapter (`downloads: []`) — markup unduhan tidak ada di halaman contoh |
| Klaim Sub Indo | hanya dari halaman episode itu sendiri |
| robots.txt | Yoast, mengizinkan semua path (dicek 23 Okt 2026) |
| ToS/DMCA | tidak ada halaman yang tertaut → `verdict: 'unknown'` |
| Country/kategori donghua | **tidak ada** (dropdown Country kosong; `/donghua/` 404; `/genres/donghua/` **404**, dan tiga judul donghua dari aplikasi Animeloverz → **0 hasil** saat probe 24 Okt 2026 — bukti lengkap: `docs/DONGHUA.md`) |

---

## 2. Pola URL

| Pola | Arti | Contoh |
|---|---|---|
| `/` | beranda (Latest Release + paginasi `/page/2/`) | `https://oploverz.ch/` |
| `/series/` | daftar seri + form filter | `/series/?status=&type=&order=update` |
| `/series/page/<n>/` | halaman berikutnya dari daftar | `/series/page/2/` |
| `/series/<slug>/` | halaman seri | `/series/toaru-anbu-no-item/` |
| `/<slug>-episode-<n>-subtitle-indonesia/` | halaman episode | `/toaru-anbu-no-item-episode-3-subtitle-indonesia/` |
| `/?s=<kata>` | pencarian situs (fuzzy, lihat §7) | `/?s=Perfect+World` |

Aturan parsing (`seriesSlugFromUrl`, `episodeSlugFromUrl`):
* slug seri = segmen path kedua setelah `series`, huruf kecil, `[a-z0-9][a-z0-9-]{0,158}`;
* slug episode = satu segmen path dengan akhiran `-episode-<n>` (opsional `-subtitle-indonesia`);
* origin wajib sama dengan `base`; hash dibuang; path lain ditolak (`null`).

---

## 3. Selektor per halaman

### 3.1 Kartu (beranda / daftar / pencarian) — `parseCards()`

| Data | Selektor |
|---|---|
| Wadah kartu | `article.bs` |
| Tautan utama | `.bsx > a[href]` → fallback `a[href]` |
| Judul episode | `h2[itemprop="headline"]` → `h2` → atribut `title` anchor |
| Judul seri | `.tt` (isi `h2` dibuang) |
| Nomor episode | `.epx` (mis. `Ep 3`), fallback judul episode / URL |
| Poster | `img` (`src`, `data-src`, `data-lazy-src`) |
| Format | `.typez` |
| Status | label `.epx` (`Ongoing` / `Completed`) |

Kartu episode (`/<slug>-episode-N…/`) dipakai feed **latest**; kartu seri (`/series/<slug>/`) dipakai daftar.

### 3.2 Halaman seri — `seriesMeta()`

| Data | Selektor |
|---|---|
| Judul | `h1.entry-title` |
| Judul alternatif | `.alter` |
| Poster | `meta[property="og:image"]` → `.thumbook img` → `.single-info .thumb img` |
| Sinopsis | `.mindesc` |
| Genre | `a[href*="/genres/"]` |
| Info (Status/Studio/Released/Season/Type/Episodes) | `.spe > span` — kunci dari `<b>` |
| Daftar episode | `.eplister li a[href]` (`.epl-num`, `.epl-title`, `.epl-date`) |

### 3.3 Halaman episode — `parseEpisodePage()`

| Data | Selektor |
|---|---|
| Judul | `h1.entry-title` — memuat "… Episode N Subtitle Indonesia" |
| Server | `.dsu-server[data-url]` (`data-label` = nama server) |
| Fallback server | `#embed_holder iframe[src]`, `.player-embed iframe[src]` |
| Daftar episode sidebar | `#singlepisode .episodelist li a[href]` |
| Seri induk | `#singlepisode .headlist h2 a[href]` → `a[href*="/series/"]` |
| Unduhan | tidak ada (selalu `[]`) |

Server hanya dikirim bila URL-nya **publik dan absolut** (relatif di-resolve ke `base`); URL duplikat dibuang.

---

## 4. Pemetaan ke API Kazanime

| Method adapter | Rute HTTP | Cache |
|---|---|---|
| `latest()` | `GET /api/anime/latest?source=oploverz` | 10 menit |
| `search(q)` | `GET /api/anime/search?q=&source=oploverz` | 15 menit |
| `browse()` | `GET /api/anime/browse?source=oploverz&filter=&genre=&page=&year=&season=` | 15 menit |
| `browseOptions()` | ikut `browse`/`genres` (`filters`, `genres`, `seasons`) | 6 jam (nav) |
| `getAnime(ref)` | `GET /api/anime/oploverz~<slug>` | 15 menit |
| `getEpisode(ref, n)` | `GET /api/anime/oploverz~<slug>/episode/<n>` | 15 menit |
| `browseDonghua(titles)` | `GET /api/anime/browse?source=oploverz&filter=donghua` | 15 menit |

Slug Kazanime selalu berprefix `oploverz~` (mis. `oploverz~toaru-anbu-no-item`).

---

## 5. Filter daftar (`BROWSE_FILTERS`)

| id | Label | Parameter situs |
|---|---|---|
| `update` | Terbaru | `?order=update` |
| `popular` | Populer | `?order=popular` |
| `rating` | Rating Tertinggi | `?order=rating` |
| `ongoing` | Ongoing | `?status=ongoing` |
| `completed` | Complete | `?status=completed` |
| `movie` | Movie | `?type=movie` |

`?status=upcoming` **tidak** dipakai: saat dicek, halaman itu tidak berisi kartu.

**Genre**: 80 genre dari form `/series/` (`input[name="genre[]"][value]`, label dari `label[for=...]`),
dipakai apa adanya sebagai `?genre[]=<id>`.

**Musim**: `input[name="season[]"]` dengan nilai `winter-2026` … `fall-2026` (24 nilai).
Bila hanya tahun dipilih, empat musim tahun itu diminta sekaligus (`season[]=winter-2020&…&fall-2020`).

**Paginasi**: `link[rel="next"]` atau `a.next.page-numbers`.

---

## 6. Bukti Sub Indo

Aturan: **nama situs dan bahasa antarmuka tidak dipakai**. Bukti diambil lewat
`lib/subtitle-evidence.js` dari:

1. judul episode (`… Episode N Subtitle Indonesia`) → `evidence: 'episode-title'`;
2. isi `.entry-content`;
3. label server (`data-label`);
4. label unduhan (tidak ada di sumber ini).

Baris daftar episode juga diuji sekali jalan: bila `.epl-title` memuat frasa Indonesia →
`sub: 'id'`; bila tidak → `sub: ''` (sudah diperiksa, tanpa bukti). Badge tidak pernah dikarang.

Kontrol negatif ada di `server/test/fixtures/oploverz-episode.html` dengan penanda bahasa dihapus
(`npm run check:subindo`): server tetap bisa diputar, tetapi tidak dihitung Sub Indo.

---

## 7. Donghua — mekanisme dan hasil cek

### 7.1 Mekanisme (`browseDonghua`)

Situs tidak punya kategori/negara donghua: dropdown **Country** di `/series/` kosong dan
`/donghua/` → 404. Karena itu daftar donghua disusun dari **pencarian judul**:

```
titles = benih situs (4) + judul donghua tayang (metadata AniList, negara CN)
       → dipotong 12 → diambil 4 kueri pertama (DONGHUA_QUERIES = 4)
       → GET /?s=<judul>  (paralel, maks 3 bersamaan)
       → kartu seri saja, judul harus "related" (sama / saling memuat, min. 5 karakter)
       → maks 24 hasil, ditandai country: 'CN'
```

Benih (`DONGHUA_SEEDS`, ditambahkan putaran 20):

1. `Perfect World`
2. `Battle Through the Heavens`
3. `Soul Land`
4. `Renegade Immortal`

Benih **hanya kueri pencarian** — kalau situs tidak punya judulnya, tidak ada kartu yang
ditampilkan. Tidak ada judul karangan dan tidak ada klaim Sub Indo dari jalur ini.

### 7.2 Hasil cek live (24 Oktober 2026)

| Uji | Hasil |
|---|---|
| `GET /api/anime/browse?source=oploverz&filter=donghua` (produksi) | **200, `items: []`** |
| `https://oploverz.ch/series/perfect-world/` | **404** |
| `https://oploverz.ch/?s=Douluo` | **Not Found** |
| `https://oploverz.ch/?s=Martial Universe` | **Not Found** |
| `https://oploverz.ch/?s=Perfect World` | kartu tak nyambung (Tenmaku no Jaadugar, Wistoria S2, Marriagetoxin, …) |
| `https://oploverz.ch/?s=Battle Through the Heavens` | **Kingdom 6th Season** |
| `https://oploverz.ch/donghua/` | **404** |
| Beranda `/` | semuanya anime Jepang (label `Anime`, `Ongoing`/`Completed`) |

**Kesimpulan:** `oploverz.ch` — domain yang dipakai adapter dan diberi label Animeloverz —
**saat ini tidak memuat donghua**. Panel "Donghua di Oploverz" karena itu wajar kosong;
UI menyatakannya terus terang (lihat hint di `js/katalog.js`).

> Catatan: beberapa artikel 2025 menyebut Oploverz punya donghua (Perfect World, Martial Universe).
> Yang bisa diverifikasi hari ini adalah domain `.ch` di atas. Mirror lain (mis. domain `.cam`,
> `.in`, `.bz`) tidak dipakai karena belum diverifikasi dan bukan bagian dari konfigurasi.

---

## 8. Kebijakan akses

| Aturan | Nilai |
|---|---|
| `robots: true` | gerbang robots aktif (mode `off`/`warn`/`enforce` lewat `SCRAPER_ROBOTS_MODE`) |
| `requireExplicitRobots` | `false` — robots.txt yang 404 tidak memblokir, tetapi robots yang membaca **larangan** tetap dihormati |
| `cookies` | `false` |
| Host yang diizinkan | hanya host dari `OPLOVERZ_BASE_URL` |
| 403 / 429 / challenge | **tidak** diulang, tidak di-bypass (tanpa headless/stealth, solver, proxy rotasi, atau impersonasi TLS) |
| User-Agent | `KazanimeBot` yang jujur (bukan UA browser palsu) |
| Gambar | `imagePolicy: 'allowed'` — poster ditampilkan langsung dari situs (tanpa hotlink ke CDN pihak ketiga) |

---

## 9. Batas yang tidak bisa ditutup dari sisi Kazanime

1. **Tidak ada kategori donghua** — arsip negara/kategori tidak tersedia; pencarian situs fuzzy
   (`Battle Through the Heavens` → `Kingdom`), jadi daftar donghua tidak akan pernah lengkap.
2. **Tidak ada tautan unduhan** di markup yang dipakai → `downloads: []`. Bila situs menambahkannya,
   parser harus diperbarui.
3. **Tidak ada API** — semua data bergantung pada HTML; perubahan tema mematahkan parser
   (diperlukan fixture baru + tes).
4. **Server video** hanya URL embed publik; token/anti-bot player tidak dipecahkan.
5. **Situs bisa memblokir IP pusat data** (403/Cloudflare). Adapter berhenti, tidak mencoba bypass.

---

## 10. Kenapa tidak ada "analisis API" di `Sumber APK.zip`

Paket APK Miku Moe 3.6 (`miku.moe.app`) **tidak memakai Oploverz**:

* `grep -ril oploverz` pada 451 smali + seluruh `res/` + `AndroidManifest.xml` → **0 hit**;
* daftar "Sumber Konten" di `04_analysis/constants_dan_temuan.txt` hanya menyebut Animeku,
  AnimeX/AnimeXNonton, dan Crotpedia;
* Oploverz muncul di laporan paket hanya sebagai **sumber HTML Kazanime** (`ANALISA_REPO_KAZANIME.md`)
  dan sebagai catatan tumpang-tindih konten (`INTEGRASI_ANIMEXNONTON.md` §7).

Jadi satu-satunya "peta Oploverz" yang bisa dibuat dari bahan nyata adalah dokumen ini:
analisis HTML adapter yang benar-benar berjalan, bukan rekonstruksi API yang tidak ada.

---

## 11. Cara memeriksa ulang

```bash
npm test -- server/test/oploverz.test.js     # 15 tes parser, browse, donghua, error
npm run check:subindo                        # bukti bahasa dari fixture (lokal, tanpa internet)
node server/scripts/check-source-reachability.js   # akses live (butuh jaringan)
```

Fixture acuan: `server/test/fixtures/oploverz-{home,series-list,series,episode}.html`
(diambil 23 Okt 2026). Bila tema situs berubah, ganti fixture lalu jalankan tes — tes akan
menunjukkan selektor mana yang patah.

---

## 12. Riwayat perubahan dokumen

| Tanggal | Perubahan |
|---|---|
| 24 Okt 2026 | Dokumen dibuat. Benih donghua (`DONGHUA_SEEDS`) + `DONGHUA_QUERIES` 4. Hasil cek live: situs tidak memuat donghua. |
