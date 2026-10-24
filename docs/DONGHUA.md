# Donghua: kenapa katalog aplikasi berbeda dari katalog Kazanime

Status: **catatan verifikasi** (bukan fitur baru) — 24 Oktober 2026
Pertanyaan pengguna: *"untuk katalog lihat gambar 1 yg ada di aplikasi kok bisa berbeda yah padahal
ada donghua dan sebaliknya animeku pun ada bahkan hampir sama"*, disusul *"ini animeku juga ada"*.

Ringkas: **aplikasi Animeloverz dan aplikasi Animeku tidak membaca situs publik yang kita scraping.**
Katalog donghua di kedua aplikasi berasal dari API khusus aplikasi yang menolak klien luar
(`403`), sedangkan situs publik `ww2.animeku.lol` dan `oploverz.ch` **tidak punya kategori donghua
sama sekali**. Karena itu Kazanime tidak bisa menyamakan katalognya tanpa API tersebut.

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

---

## 4. Pilihan yang tersedia

| Opsi | Isi | Konsekuensi |
|---|---|---|
| **A. Terima perbedaan (dokumen ini)** | Tidak ada perubahan data; katalog donghua tetap dari AnimeKu (varian Douluo Dalu) + benih Oploverz | Jujur, nol risiko; katalog tetap lebih kecil dari aplikasi |
| **B. Perkaya donghua dari AnimeKu** | Tambah benih judul donghua yang **benar-benar ada** di AnimeKu (mis. Perfect World, Battle Through the Heavens, Soul Land, Swallowed Star) | Tiap benih = 1 request pencarian (~1 dtk/host); jumlah kueri perlu dinaikkan |
| **C. Perluas tab Donghua ke sumber lain** | AnimeXin (punya jadwal donghua) dan HiAnime (punya *Anhe Zhuan* dkk.) bisa jadi isi tab Donghua | Melanggar batas lama “panel donghua hanya AnimeKu & Oploverz” → butuh persetujuan pengguna |
| **D. Periksa APK aplikasinya** | Kirim APK Animeku / Animeloverz; dibongkar seperti `Sumber APK.zip` untuk mencari endpoint katalog donghua | Satu-satunya jalan menuju paritas isi; hasilnya bisa tetap 403 seperti Animeku API |

Urutan rekomendasi: **D → C → B → A**. Tanpa APK atau izin memperluas sumber, A adalah satu-satunya
opsi yang tidak mengarang data.

---

## 5. Cara mengulang probe

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

## 6. Riwayat

| Tanggal | Perubahan |
|---|---|
| 24 Okt 2026 | Dokumen dibuat setelah probe Actions: AnimeKu tanpa genre/kategori donghua, Oploverz tanpa donghua, `apps.animekita.org` 403 dari Actions, `animeloverz.com/.id` tidak resolve, `oploverz.biz` 526. |
