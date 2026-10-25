# Aniwaves (aniwaves.ru) — hasil pemeriksaan 25 Okt 2026

Permintaan pengguna: *"https://aniwaves.ru/home tambahkan sumber baru dari sini jika memungkinkan
… untuk animewave pisahkan tombol nya agar tidak terlalu banyak jadi untuk english dipisah baris nya
dan dub nya"*.

Kesimpulan singkat: **katalognya bisa dibaca, tetapi daftar server streaming TIDAK bisa** diambil
tanpa memalsukan tanda tangan anti-bot milik situs. Karena itu adapter `aniwaves` **tidak
ditambahkan** (aturan proyek: tanpa bypass, tanpa UA palsu, tanpa solver). Yang tetap dikerjakan dari
permintaan ini adalah **pemisahan baris tombol server** (Sub Indo / Multi Sub / Subtitle Inggris /
Dub) — lihat `js/watch.js` (`LANG_GROUP`) dan `js/ui/player.js` (`serverRows`).

## 1 · Cara pemeriksaan

- `server/scripts/probe-aniwaves.js` — pengambil halaman read-only dengan UA bot jujur
  `KazanimeBot/1.0 (+https://github.com/Kazaamii/Kazaanime)`, tanpa cookie/proxy/header peramban
  palsu, tanpa retry saat 403/429/challenge.
- Dijalankan sekali lewat GitHub Actions (sandbox pengembangan tidak bisa menjangkau host luar),
  hasilnya diverifikasi ulang dengan pembacaan halaman publik.

## 2 · robots.txt (dibaca 25 Okt 2026)

```
User-agent: *
Disallow: /random
Disallow: /filter
Disallow: /ajax
Disallow: /api
Sitemap: https://aniwaves.ru/sitemap.xml
```

`/home`, `/watch/<slug>-<id>`, `/genre/*`, `/type/*` **diizinkan**.

## 3 · Struktur halaman (HTML asli, 25 Okt 2026)

| Bagian | Temuan |
|---|---|
| Beranda `/home` | kartu `.bs`/`.bsx` dengan tautan `/watch/<slug>-<id>` (dipakai untuk daftar terbaru) |
| Halaman seri `/watch/<slug>-<id>` | `h1`, sinopsis, `.binfo` (tipe, negara, tahun, status, genre, skor, jumlah episode) |
| Halaman episode `/watch/<slug>-<id>/episode/<n>` | `<div id="w-servers"></div>` **kosong** dan `<div id="w-episodes">` berisi `<div class="loading">` — keduanya diisi JavaScript |
| Meta | `data-id="82821"` (id seri) + `data-url` + `data-ep-name`; JSON-LD `TVSeries`/`VideoObject` (embedUrl hanya untuk trailer YouTube) |

## 4 · Dari mana tombol server berasal

Berkas `/assets/js/main.js` (diunduh sekali untuk pemeriksaan) memuat `WatchView`:

```js
d.default.j("ajax/episode/list/" + this.Ee + window.location.search,
            ["data", ["style", ..., "vrf", s(this.Ee)]])           // daftar episode + id server
d.default.j("ajax/server/list?servers=" + ids)                     // daftar tombol server
d.default.j("ajax/sources?id=" + svId + "&asi=" + i + "&autoPlay=" + a)  // URL embed sebenarnya
```

- Semua data server hanya ada di **`/ajax/...`** — path yang **dilarang robots.txt**.
- `ajax/episode/list/<id>` menuntut parameter **`vrf`** = tanda tangan hasil fungsi ter-obfuscate
  (`function s(){…}` di `main.js`), dan `ajax/sources` baru membalas bila id server diketahui.
- Tidak ada satu pun URL embed (`iframe`, `m3u8`, `vidplay`, dst.) di HTML yang bisa dibaca
  langsung; halaman episode yang diambil dengan UA jujur tetap kosong di `#w-servers`.

Mereplikasi `vrf`/`_csrfToken` untuk memanggil `/ajax` berarti **melewati kontrol anti-bot situs**.
Itu dilarang oleh aturan proyek (tanpa solver, tanpa UA palsu, tanpa proxy), jadi **tidak
diimplementasikan**.

## 5 · Kalau situs berubah

Bila suatu hari daftar server muncul di HTML (mis. `#w-servers` berisi `<li data-sv-id>` dengan URL
`data-embed`, atau `<iframe>` langsung di halaman episode), adapter bisa dibuat dengan pola yang sama
seperti `animeku`/`oploverz`:

1. `server/sources/aniwaves.js` — `latest()`, `search()`, `getAnime()`, `getEpisode()`,
   `browseOptions`, `policy` (robots dihormati).
2. Fixture HTML + tes adapter.
3. Daftarkan di `FACTORIES` (`server/sources/index.js`) dan `SOURCES` (`server/config.js`), lalu
   verifikasi dengan UA jujur sebelum menyalakannya.
4. Kelompokkan tombol lewat `group`/`groupHint` (SUB / S-Sub / DUB) — UI-nya **sudah ada** dan
   dipakai sekarang untuk memisahkan Sub Indo / Multi Sub / Subtitle Inggris / Dub.

Jalankan ulang pemeriksaan dengan:

```bash
node server/scripts/probe-aniwaves.js
```
