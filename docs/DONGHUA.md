# Donghua: kenapa katalog aplikasi berbeda dari katalog Kazanime

Status: **catatan verifikasi** (bukan fitur baru) — 24 Oktober 2026
Pertanyaan pengguna: *"untuk katalog lihat gambar 1 yg ada di aplikasi kok bisa berbeda yah padahal
ada donghua dan sebaliknya animeku pun ada bahkan hampir sama"*, disusul *"ini animeku juga ada"*.

Ringkas: **aplikasi Animeloverz dan aplikasi Animeku tidak membaca situs publik yang kita scraping.**
Katalog donghua di kedua aplikasi berasal dari API khusus aplikasi yang menolak klien luar
(`403`), sedangkan situs publik `ww2.animeku.lol` dan `oploverz.ch` **tidak punya kategori donghua
sama sekali**. Karena itu Kazanime tidak bisa menyamakan katalognya tanpa API tersebut.

**Pembaruan 24 Okt 2026 (APK Miku Moe 3.6 dibongkar):** kedua tab di aplikasi itu — "Animeku"
dan "Animeloverz" — memakai **host API yang sama**, `apps.animekita.org/api/v1.2.5/`. Itu sebabnya
isinya "hampir sama" seperti yang Anda amati. Host tersebut sekarang **mati**: semua path API →
**403**, dan halaman depannya menampilkan tulisan vandalisme (`MEMEK EUR`)."


---

## 1. Isi dua tangkapan layar

| Gambar | Aplikasi | Yang terlihat |
|---|---|---|
| 1 | **Animeloverz** | Chip **Terbaru · Baru Upload · Donghua · Movie · Filter Genre**; chip **Donghua** aktif berisi *Summer Punch*, *Divine Manifestation*, *King of Loose Cultivators* (label “敬请期待”); lembar genre: Semua, Action, Adventure, Comedy, Demons, Drama, Ecchi, Entertainment, … |
| 2 | **Animeku** | Chip **Populer · Top Favorite · Coming Soon · Completed** + **Genre: Donghua**; isi: *Ai Zai Xi Yuan Qian (Immortal Love for You)*, *Ai Zai Xi Yuan Qian 2nd Season*, *Aishang Ta de Liyou*, *Aishang Ta de Liyou (Dub JP)*, *Aiyou de Mishi*, *Anhe Zhuan*, … |

Jumlah judul di kedua aplikasi jauh di atas isi katalog kita, dan (menurut pengguna) isinya
"hampir sama" antara dua aplikasi itu — petunjuk bahwa keduanya memakai backend yang sama.

---

## 2. Bukti probe (bukan asumsi)

Probe dijalankan **dari GitHub Actions** (IP pusat data, `User-Agent: KazanimeBot/1.0`), satu GET per
URL, tanpa header browser, tanpa cookie, tanpa proxy, tanpa retry, tanpa solver. Skrip probe hanya
dipakai sekali lalu dihapus dari repo; daftar URL di bawah bisa diulang kapan saja.

### 2.1 AnimeKu — `ww2.animeku.lol`

| URL | Status | Kartu | Judul yang terlihat |
|---|---|---|---|
| `/` | **200** | 30 `article.aku-sel` (84 `article`) | Tokyo Revengers, Toaru Anbu No Item, … |
| `/genre/donghua/` | **404** (dialihkan ke `/genre/donghua-cn3x6cu/`) | 21 kartu sisa halaman 404 | Romelia Senki, Shuiro No Kamen, … |
| `/genre/aksi/` (kontrol) | **200** | 30 | One Piece Film Strong World, Fate/Kaleid, … |
| `/negara/china-n5z6n97/` | **200** | **0** | — |
| `/?s=Anhe+Zhuan` | 200 | 14 (tidak ada yang cocok) | hasil generik: Romelia Senki, … |
| `/?s=Aiyou+de+Mishi` | 200 | 14 (tidak ada yang cocok) | hasil generik: Romelia Senki, … |

Kata **“donghua” tidak muncul sekali pun** di HTML beranda (0 kemunculan).

### 2.2 Animeloverz — `oploverz.ch`

| URL | Status | Kartu | Catatan |
|---|---|---|---|
| `/` | **200** | 49 `article.bs` | anime Jepang |
| `/genres/donghua/` | **404** | 0 | tidak ada genre donghua |
| `/?s=Summer+Punch` | 200 | **0** | judul dari aplikasi tidak ada di situs |
| `/?s=Divine+Manifestation` | 200 | **0** | idem |
| `/?s=King+of+Loose+Cultivators` | 200 | **0** | idem |

Kata **“donghua” juga 0 kemunculan** di HTML beranda.

### 2.3 Domain & API lain

| Target | Hasil | Arti |
|---|---|---|
| `apps.animekita.org/api/v1.2.5/baruupload.php?page=1` | **403** | API aplikasi; dari Actions pun 403 → bukan pembatasan IP sandbox |
| `apps.animekita.org/api/v1.2.5/` | **403** | idem |
| `animeku.lol` | 200 → dialihkan ke `ww2.animeku.lol` | domain sama, bukan katalog lain |
| `animeloverz.com` | tidak resolve (fetch failed) | tidak ada domain alternatif |
| `animeloverz.id` | tidak resolve (fetch failed) | idem |
| `oploverz.biz` | **526** (Cloudflare: origin SSL mati) | bukan cermin yang hidup |

Tambahan dari putaran sebelumnya (`docs/ANIMEXNONTON.md`): APK Miku Moe 3.6 memuat
`apps.animekita.org` sebagai sumber **“Animeku”**. Artinya API itu memang API aplikasi, dan ia
memang menolak klien luar.

---

### 2.4 Bukti dari APK Miku Moe 3.6 (`64bit.Miku Moe_3.6_R27_v2.apk`)

Dibongkar dengan `androguard` (17,4 MB, `classes.dex` 10 MB, `libmikumoe.so` 9,2 MB).

| Temuan di APK | Nilai |
|---|---|
| Kelas tab Animeku | `Lmiku/moe/app/BaseAnimekuGridFragment;`, `AnimekuGridAdapter` |
| Kelas tab Animeloverz | `Lmiku/moe/app/BaseAnimeLoverzGridFragment$ResponseConsumer;` |
| API tab **Animeku** | `apps.animekita.org/api/v1.2.5/baruupload.php?page=`, `home/ongoing.php?page=&type=all`, `genreseries.php?page=`, `search.php?keyword=`, `movie.php`, `series.php?url=`, `series/episode/data.php?url=` |
| API tab **Animeloverz** | **host yang sama**: `baruupload.php?page=` + `home/ongoing.php?page=&type=all` |
| Filter donghua di aplikasi | `search.php?keyword=donghua&page=` |
| Header yang dikirim aplikasi | `user-agent: Dart/3.9 (dart:io)`, `accept: application/json` |
| Sumber lain | `pencarinafkah.xyz/vA6//api` (api_key tertanam), `api.wincamp.web.id/animexnonton` |

Hasil uji host `apps.animekita.org` dari GitHub Actions (User-Agent bot jujur, GET & POST, http & https):

| URL | Hasil |
|---|---|
| `/api/v1.2.5/baruupload.php?page=1` (GET & POST) | **403** `403 Forbidden` (Apache di balik Cloudflare) |
| `/api/v1.2.5/search.php?keyword=donghua&page=1` | **403** |
| `/api/v1.2.5/genreseries.php?page=1`, `/home/ongoing.php` | **403** |
| `/` | **200**, 9 byte: `MEMEK EUR` (vandalisme) |
| `animekita.org` | **200**, 11 byte: `HALO DUNIA!` |

Kesimpulan dari APK: **tidak ada endpoint baru yang bisa dipakai.** Katalog donghua aplikasi
berjalan di atas API pihak ketiga yang kini rusak/diambil alih, dan header yang dipakai adalah
identitas aplikasi (`Dart/3.9`) — Kazanime tidak meniru identitas itu.

---

## 3. Kesimpulan

1. **Situs publik tidak punya donghua sebagai kategori.** AnimeKu: `/genre/donghua/` 404,
   `/negara/china-*` kosong, kata “donghua” 0 kemunculan. Oploverz: `/genres/donghua/` 404,
   dan tiga judul dari aplikasi tidak ada di sana.
2. **Aplikasi memakai jalur lain.** Aplikasi Animeku memakai API aplikasi (`apps.animekita.org`)
   yang membalas 403 untuk siapa pun yang bukan aplikasinya. Aplikasi Animeloverz menampilkan judul
   yang tidak ada di `oploverz.ch`; endpoint-nya belum teridentifikasi, tetapi polanya sama.
3. **Kazanime tidak bisa menyamakan katalog itu tanpa API tersebut**, dan kita tidak menembusnya
   (tanpa UA aplikasi palsu, tanpa solver, tanpa retry 403, tanpa proxy rotasi) — aturan yang sama
   dengan seluruh adapter lain di repo ini.
4. **Isi donghua kita memang tipis karena sumbernya tipis**, bukan karena filter kita salah:
   `GET /api/anime/browse?source=animeku&filter=donghua` → **7 judul, semuanya varian Douluo Dalu**
   (satu benih pencarian yang benar-benar ada di situs); `source=oploverz&filter=donghua` → **0**.
5. **HiAnime adalah satu-satunya sumber donghua yang benar-benar kaya** (dicek 24 Okt 2026 lewat API
   produksi): `Soul Land` → 5 seri, `Battle Through the Heavens` → 3, `Douluo Dalu` → 4,
   `Perfect World` → 2, `Renegade Immortal` → 2, `Throne of Seal` → 1, `Shaonian Ge Xing` → 1
   (termasuk *Anhe Zhuan*). AnimeXin juga situs donghua (seluruh katalognya CN).

---

## 4. Pilihan yang tersedia

| Opsi | Isi | Konsekuensi |
|---|---|---|
| **A. Terima perbedaan (dokumen ini)** | Tidak ada perubahan data; katalog donghua tetap dari AnimeKu (varian Douluo Dalu) + benih Oploverz | Jujur, nol risiko; katalog tetap lebih kecil dari aplikasi |
| **B. Perkaya donghua dari AnimeKu** | Tambah benih judul donghua yang **benar-benar ada** di AnimeKu (mis. Perfect World, Battle Through the Heavens, Soul Land, Swallowed Star) | Tiap benih = 1 request pencarian (~1 dtk/host); jumlah kueri perlu dinaikkan |
| **C. Perluas tab Donghua ke sumber lain** | AnimeXin (punya jadwal donghua) dan HiAnime (punya *Anhe Zhuan* dkk.) jadi isi tab Donghua | ✅ **dikerjakan 24 Okt 2026** (lihat §7) |
| **D. Periksa APK aplikasinya** | Kirim APK Animeku / Animeloverz; dibongkar seperti `Sumber APK.zip` untuk mencari endpoint katalog donghua | Satu-satunya jalan menuju paritas isi; hasilnya bisa tetap 403 seperti Animeku API |

Urutan rekomendasi: **D → C → B → A**. Tanpa APK atau izin memperluas sumber, A adalah satu-satunya
opsi yang tidak mengarang data.

---

## 5. Tab Donghua yang baru (24 Oktober 2026)

Tab **Donghua** di `katalog.html` kini berisi lima bagian:

| Bagian | Sumber | Isi | Status |
|---|---|---|---|
| Donghua Baru Upload | feed Kazanime (metadata) | rilis donghua terbaru | tetap |
| **Donghua di HiAnime** | `source=hianime&filter=donghua` | 7 benih terverifikasi, difilter judul | **baru** |
| **Donghua di AnimeXin** | `source=animexin&filter=donghua` | katalog AnimeXin apa adanya (situs donghua) | **baru** |
| Donghua di AnimeKu | `source=animeku&filter=donghua` | Douluo Dalu (7 seri) + Doupo Cangqiong (5 seri) | diperkaya 24 Okt 2026 |
| Donghua di Oploverz | `source=oploverz&filter=donghua` | biasanya kosong (situsnya tidak memuat donghua) | tetap |

Detail teknis:

* `browseDonghua(titles)` di `server/sources/hianime.js` mencari ketujuh benih (maks 3 paralel,
  jeda 1 dtk/host dari `lib/fetcher.js`), lalu **hanya** memakai kartu yang judulnya cocok
  (`titleKey` setelah `stripSeason`). Benih: `Soul Land`, `Battle Through the Heavens`,
  `Perfect World`, `Douluo Dalu`, `Throne of Seal`, `Renegade Immortal`, `Shaonian Ge Xing`.
* `browseDonghua()` di `server/sources/animexin.js` memakai `latest()` — tidak ada request baru.
* Di `js/katalog.js`, bagian boleh menunjuk sumber lain lewat `source:`; tiap bagian mendapat
  kunci DOM unik (`key`) karena lima bagian memakai id filter `donghua` yang sama.
* Tes: `server/test/round23-donghua-tab.test.js` (6 tes).

### Benih donghua AnimeKu (opsi B, 24 Okt 2026)

Pencarian AnimeKu **peka romanisasi**: judul Inggris dijawab dengan daftar umum (bukan hasil),
judul China dikenali.

| Kueri `?s=` | Hasil (produksi) |
|---|---|
| `Douluo Dalu` | **7 seri** (Douluo Dalu + Hanhai Qian Kun, Xiaowu Juebie, Hao Tian Yang Wei, Qian Hua Xi Jin, Xingdou Xian Ji Pian, Jingying Sai) |
| `Doupo Cangqiong` | **5 seri** (Doupo Cangqiong 2nd Season Specials, Specials, 3rd Season, S2, Live Action) |
| `Battle Through the Heavens` | daftar umum — **0 cocok** (judul Inggris tidak dikenali) |
| `Perfect World`, `Wanmei Shijie`, `Swallowed Star`, `Tunshi Xingkong`, `Xian Ni`, `Zhu Xian` | daftar umum — **0 cocok** |

Karena itu `DONGHUA_SEEDS` AnimeKu berubah dari `Douluo Dalu, Perfect World, Battle Through the
Heavens` menjadi `Douluo Dalu, **Doupo Cangqiong**, Perfect World` — butir kedua yang mati diganti
romanisasi yang benar-benar berisi 5 seri, dan `DONGHUA_QUERIES` tetap **3** (batas lama: tiap
kueri satu request dengan jeda 1 dtk/host).

**Hasil produksi (24 Okt 2026, setelah merge PR #46 & #47):**

| Permintaan | Hasil |
|---|---|
| `GET /api/anime/browse?source=hianime&filter=donghua` | **200, 17 judul** — Soul Land (5 seri), Battle Through the Heavens (3), Perfect World, Douluo Dalu Movie: Jiandao Chen Xin, Throne of Seal, Renegade Immortal (2), Shaonian Ge Xing (4: asli, *Anhe Zhuan Part 2*, *Feng Hua Xue Yue Pian Part 2*, *… Special*) |
| `GET /api/anime/browse?source=animeku&filter=donghua` | 200, 7 judul (Douluo Dalu + 6 varian) — tidak berubah |
| `GET /api/anime/browse?source=animexin&filter=donghua` | **`SOURCE_BLOCKED`** — animexin.dev membalas **challenge 403** ke IP Vercel; circuit breaker mengistirahatkan sumbernya ±5 menit (`/api/anime/latest` melaporkan `retryAfter`). Situsnya sendiri hidup (dicek dari IP lain: beranda + jadwal normal), jadi ini pembatasan bot di sisi situs, bukan kerusakan adapter. Tidak ada upaya menembus challenge. |

---

## 6. Cara mengulang probe

```bash
# Dari mesin yang bisa menjangkau kedua situs (mis. runner Actions), satu GET per URL:
curl -A 'KazanimeBot/1.0 (+https://github.com/Kazaamii/Kazaanime)' -s -o /dev/null -w '%{http_code} %{url_effective}\n' \
  https://ww2.animeku.lol/genre/donghua/ \
  https://ww2.animeku.lol/negara/china-n5z6n97/ \
  'https://ww2.animeku.lol/?s=Anhe+Zhuan' \
  https://oploverz.ch/genres/donghua/ \
  'https://oploverz.ch/?s=Summer+Punch'

# Hitung kartu (butuh cheerio):
#   animeku  : article.aku-sel
#   oploverz : article.bs
```

Jangan menaikkan frekuensi, jangan menghapus jeda 1 detik/host, dan jangan mengulang saat 403/429 —
situs memperlakukan permintaan beruntun sebagai beban, bukan undangan.

---

## 7. Riwayat

| Tanggal | Perubahan |
|---|---|
| 24 Okt 2026 | Dokumen dibuat setelah probe Actions: AnimeKu tanpa genre/kategori donghua, Oploverz tanpa donghua, `apps.animekita.org` 403 dari Actions, `animeloverz.com/.id` tidak resolve, `oploverz.biz` 526. |
| 24 Okt 2026 (lanjutan) | APK Miku Moe 3.6 dibongkar: kedua tab aplikasi memakai `apps.animekita.org` (403 + halaman depan vandalisme) — tidak ada endpoint baru yang bisa dipakai. Tab **Donghua** di Jelajah diperluas: bagian **Donghua di HiAnime** (7 benih terverifikasi) dan **Donghua di AnimeXin** (katalog situs apa adanya), di samping AnimeKu & Oploverz. |
