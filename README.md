# 🌸 Kazanime — Refactor Multi-Halaman

Refactor dari `index-final-v4.html` (±3.850 baris CSS/HTML/JS campur) menjadi
proyek multi-halaman berbasis **ES Modules**, dengan pemisahan **data ↔ UI**,
satu **format anime yang dinormalisasi**, dan (di Tahap D) **backend scraper**
beradapter.

| Tahap | Isi | Status |
|---|---|---|
| **A** | Pecah struktur halaman + CSS, komponen bersama (navbar, footer, modal, toast), tema | ✅ Selesai |
| **B** | Layer API (`js/api/`: cache, timeout, fallback), services auth/bookmark, pencarian, data homepage | ⏳ Menunggu konfirmasi |
| **C** | `watch.html`: satu player + fallback server otomatis, episode, info, download, rekomendasi | ⏳ |
| **D** | Backend Express + adapter `animexin` / `kuramanime` + fallback metadata | ⏳ |

---

## 📁 Struktur folder (final)

Tanda: ✅ sudah ada (Tahap A) · 🅑 dibuat Tahap B · 🅒 Tahap C · 🅓 Tahap D

```
kazanime/
├── index.html                 ✅ homepage: hero, ongoing, populer, bookmark, genre, baru rilis, donghua, jadwal
├── watch.html                 ✅ halaman nonton: watch.html?title=...&ep=1&mal=...&anilist=...
├── search.html                ✅ hasil pencarian (?q=...) & "Lihat Semua" (?browse=ongoing|popular|new|donghua)
├── README.md                  ✅
├── vercel.json                ✅ header keamanan (Referrer-Policy wajib untuk AniList)
├── .gitignore                 ✅
├── css/
│   ├── base.css               ✅ reset, variabel, 7 tema, keyframes, partikel tema
│   ├── components.css         ✅ navbar, dropdown, card, skeleton, modal, toast, API status, footer
│   ├── home.css               ✅ hero, genre, jadwal
│   ├── search.css             ✅ tab sumber, filter, muat lagi
│   └── watch.css              ✅ player, server, episode, info, download, platform legal
├── js/
│   ├── theme-preload.js       ✅ script klasik di <head>: pasang tema sebelum render (anti-kedip)
│   ├── config.js              ✅ konstanta (tema, avatar, genre, nav, platform)  · 🅑 + API_CONFIG · 🅒 + server streaming
│   ├── routes.js              ✅ pembuat/pembaca URL watch & search
│   ├── data/
│   │   └── fallback.js        ✅ data cadangan offline (format ternormalisasi)
│   ├── api/
│   │   ├── normalize.js       ✅ KONTRAK format Anime + helper label
│   │   ├── http.js            🅑 fetchJSON: timeout + AbortController + retry + cache (Map + sessionStorage) + dedupe
│   │   ├── anilist.js         🅑
│   │   ├── jikan.js           🅑
│   │   ├── kitsu.js           🅑
│   │   ├── sources.js         🅑/🅓 klien backend /api/anime/*
│   │   └── index.js           🅑 fasad: getHome(), search(), getAnime(), ... + rantai fallback
│   ├── services/
│   │   ├── storage.js         ✅ localStorage aman
│   │   ├── theme.js           ✅ 7 tema + partikel
│   │   ├── auth.js            🅑 login/daftar (kompatibel data lama, password di-hash)
│   │   └── bookmark.js        🅑
│   ├── ui/
│   │   ├── dom.js             ✅ html`` ber-escape otomatis, delegate, fallback gambar
│   │   ├── layout.js          ✅ app shell bersama (dipanggil tiap halaman)
│   │   ├── navbar.js          ✅
│   │   ├── footer.js          ✅
│   │   ├── modal.js           ✅ manajer modal (Esc, backdrop, focus trap)
│   │   ├── theme-modal.js     ✅
│   │   ├── auth-modal.js      ✅ UI modal masuk/daftar/ganti avatar
│   │   ├── toast.js           ✅
│   │   ├── card.js            ✅
│   │   ├── hero.js            ✅
│   │   ├── skeleton.js        ✅
│   │   ├── schedule.js        ✅
│   │   ├── search-dropdown.js 🅑 autocomplete navbar
│   │   ├── api-status.js      🅑
│   │   └── player.js          🅒
│   ├── home.js                ✅ (pratinjau data statis) → 🅑 versi penuh
│   ├── search.js              ✅ (pratinjau) → 🅑
│   └── watch.js               ✅ (pratinjau) → 🅒
└── server/                    🅓 Node.js + Express
    ├── package.json
    ├── index.js               (sajikan frontend + /api)
    ├── lib/                   (http client UA+timeout+retry, rate limiter, cache TTL, robots.txt)
    └── sources/
        ├── index.js           (registry + rantai fallback)
        ├── animexin.js
        ├── kuramanime.js
        └── metadata.js        (fallback Jikan/Kitsu/AniList)
```

---

## ▶️ Menjalankan secara lokal

> ⚠️ **Jangan buka lewat `file://`** (klik dua kali file HTML). ES Modules diblokir
> browser di `file://`, dan AniList menolak request tanpa header `Referer`
> (halaman `file://` tidak mengirim Referer). Gunakan server lokal.

Pilih salah satu, dari dalam folder `kazanime/`:

```bash
# Python (sudah terpasang di kebanyakan sistem)
python -m http.server 5500

# atau Node.js
npx serve -l 5500 .

# atau VS Code → ekstensi "Live Server" → klik kanan index.html → Open with Live Server
```

Lalu buka **http://localhost:5500**.

Halaman yang bisa dicoba di Tahap A:
- `http://localhost:5500/` — homepage (data statis pratinjau)
- `http://localhost:5500/search.html?q=one` dan `search.html?browse=donghua`
- `http://localhost:5500/watch.html?title=One%20Piece&ep=3&anilist=21&mal=21`

Mulai Tahap D cukup satu perintah (backend sekaligus menyajikan frontend):
```bash
cd server && npm install && npm start   # → http://localhost:3000
```

---

## 🚀 Deploy ke Vercel (lewat GitHub)

Proyek ini statis (tanpa build), jadi bisa langsung di-deploy. File `vercel.json` dan
`.gitignore` sudah disiapkan.

### 1. Upload ke GitHub
**Cara A — lewat browser (tanpa install git):**
1. github.com → **New repository** → nama `kazanime` → Private/Public → **Create** (tanpa centang "Add README").
2. Klik **"uploading an existing file"** → seret **ISI** folder `kazanime/` (bukan foldernya),
   sehingga `index.html` berada di akar repo → **Commit changes**.

**Cara B — lewat terminal:**
```bash
cd kazanime
git init
git add .
git commit -m "Tahap A: struktur multi-halaman + CSS"
git branch -M main
git remote add origin https://github.com/USERNAME/kazanime.git
git push -u origin main
```

### 2. Import di Vercel
vercel.com → login dengan GitHub → **Add New… → Project** → pilih repo `kazanime` → **Import**:

| Pengaturan | Isi |
|---|---|
| Framework Preset | **Other** |
| Root Directory | `./` (isi `kazanime` jika yang ter-upload adalah foldernya) |
| Build Command | kosongkan |
| Output Directory | kosongkan |

Klik **Deploy** → situs aktif di `https://<nama-project>.vercel.app`.
Setiap `git push` ke `main` otomatis deploy ulang; branch lain (mis. `tahap-b`) mendapat
**Preview URL** sendiri untuk dicek sebelum di-merge.

**Tanpa GitHub (alternatif):** `npm i -g vercel` → `cd kazanime` → `vercel` → `vercel --prod`.

### Catatan
- `Referrer-Policy: strict-origin-when-cross-origin` di `vercel.json` **jangan diganti** ke
  `no-referrer`: AniList menolak request tanpa header `Referer`.
- Paket **Hobby** (gratis) hanya untuk pemakaian pribadi non-komersial. Pasang iklan / monetisasi
  → butuh paket Pro. Bila kuota Hobby terlampaui, project dijeda.
- Mulai Tahap D, backend Express berjalan sebagai Vercel Function di project yang sama
  (`/api/...` satu domain → tanpa CORS). Cache memakai header CDN (`s-maxage`), karena memori
  serverless tidak bertahan antar-instance.

---

## 🧭 Aturan arsitektur (wajib diikuti saat menambah fitur)

1. **Data terpisah dari UI.** Hanya file di `js/api/` yang boleh memanggil `fetch`.
   Fungsi UI menerima data jadi, tidak pernah fetch sendiri.
2. **Satu format anime.** Semua sumber diubah lewat `createAnime()` di
   `js/api/normalize.js`. UI hanya mengenal bentuk itu.
3. **Tanpa `onclick` inline.** Pakai `addEventListener` / `delegate()`.
4. **HTML selalu lewat `html```** dari `ui/dom.js` (nilai di-escape otomatis → aman XSS).
   `raw()` hanya untuk markup tepercaya (ikon SVG statis).
5. **Komponen bersama dipasang `initLayout()`**, bukan disalin ke tiap halaman.
6. **Link antar halaman lewat `routes.js`** (`watchUrl()`, `searchUrl()`, `browseUrl()`).

---

## ✅ Checklist fitur lama

### Sudah dipindahkan (Tahap A, berfungsi)
- [x] 7 tema + efek partikel + tersimpan + **tanpa kedip** saat pindah halaman (+ sinkron antar tab)
- [x] Modal pilih tema
- [x] Navbar: logo, link (smooth scroll di homepage; dari halaman lain → `index.html#section`), Ctrl/⌘+K, Enter → `search.html`
- [x] **Pencarian di mobile ≤480px** (dulu tersembunyi total → sekarang tombol 🔍)
- [x] Footer + kredit pembuat
- [x] Toast (sekarang bertumpuk, tidak saling menimpa)
- [x] Hero slider: prev/next/dots/autoplay 6 detik (data statis di Tahap A)
- [x] Kartu anime: badge, kualitas, rating, overlay play → **link ke `watch.html`**
- [x] Skeleton loading (tinggi ikut breakpoint, tidak melompat)
- [x] Tombol genre (UI), jadwal rilis (hari ini dihitung otomatis)
- [x] Modal Masuk/Daftar (UI: tab, form, 25 avatar, upload foto + crop 200×200)
- [x] Modal Ganti Avatar (UI), profile dropdown (UI)
- [x] Kerangka `watch.html` & `search.html`
- [x] Platform streaming legal (Bstation, Muse, Ani-One, Vidio)

### Belum (dikerjakan di tahap berikut)
- [ ] 🅑 Login / daftar / logout — kompatibel dengan akun lama di `kazanime-users`
- [ ] 🅑 Bookmark: kartu, hero, halaman watch, section "Bookmark Saya", badge jumlah
- [ ] 🅑 Data asli AniList/Jikan/Kitsu (+ cache, timeout, rantai fallback, pesan error ramah)
- [ ] 🅑 Dropdown autocomplete 3 sumber (dedupe)
- [ ] 🅑 Pencarian penuh: tab sumber, urutan, filter format, muat lagi; "Lihat Semua"
- [ ] 🅑 Filter genre (perbaikan variabel GraphQL & Isekai sebagai tag)
- [ ] 🅑 Donghua (AniList CN), jadwal tayang asli (AniList), badge status API
- [ ] 🅒 Player tunggal + fallback server otomatis, jumlah episode asli, auto-next, prev/next
- [ ] 🅒 Info anime & rekomendasi asli, link download
- [ ] 🅓 Backend + adapter scraper + fallback metadata

### Sengaja dihapus (mati / palsu / duplikat)
- Modal player lama `#playerModal` → digabung ke `watch.html` (satu implementasi)
- "Streaming page" di dalam homepage → menjadi `watch.html` (punya URL, bisa di-share, tombol Back browser bekerja)
- Modal YouTube + peta video ID manual + `confirm()` — tidak pernah terpanggil sejak `openPlayer` di-override
- `handleDownload()` palsu ("Download siap! Cek folder downloads" padahal tidak mengunduh apa pun)
- Kontrol player palsu (progress bar statis, tombol kualitas yang hanya memunculkan toast)
- Fungsi mati: `selectEp`, `selectServer`, `fetchStreamingSources`, `_origOpenPlayer`, `toggleHeroBookmark` versi pertama, `updateHeroBookmarkBtn`
- `API_CONFIG.HIANIME / ANICHIN / MULTIEMBED / ANIWATCH_BASE` (tidak pernah dipakai)
- CSS mati: `.daily-badge`, `.hero-particles`, `.particle` + `@keyframes float`, `.player-placeholder`, `.progress-bar/.progress-fill`, CSS modal player
- Script Cloudflare `/cdn-cgi/challenge-platform/...`

---

## 🔎 Catatan sumber data (dicek 21 Okt 2026)

- **AniList** sejak Sept 2026 membalas `403 "temporarily disabled"` untuk request **tanpa header
  `Referer`**, dan memblokir IP **Cloudflare Workers**. Dari browser (http://localhost) aman karena
  Referer terkirim otomatis. Karena itu backend Tahap D memakai **Node.js + Express**, bukan Worker.
- **Kitsu**: parameter `sort=relevance` (dipakai pencarian lama) → `HTTP 400`, jadi Kitsu di
  pencarian penuh selalu gagal. Diperbaiki di Tahap B.
- **animexin.dev**: `robots.txt` → `User-agent: * / Disallow:` (semua path diizinkan), ada halaman DMCA &
  Privacy Policy, tidak ada larangan scraping eksplisit. HTML biasa (tema WordPress).
- **v20.kuramanime.ing**: Cloudflare memblokir bot ber-User-Agent jujur
  ("Sorry, you have been blocked"), bahkan untuk `robots.txt`. Sesuai aturan proyek (hormati
  robots/ToS, UA jelas), adapter **tidak** akan mem-bypass Cloudflare; bila diblokir, sumber ditandai
  tidak tersedia dan otomatis jatuh ke sumber lain / metadata.
- 34 dari 35 URL gambar statis di file asli **404** (logo, 25 avatar, 9 gambar hero). Logo + 16 avatar +
  10 gambar hero diganti URL Kitsu yang sudah diverifikasi; 9 avatar lain memakai avatar emoji
  (sama seperti tampilan sebelumnya) sampai diisi URL valid di `js/config.js`.

> Konten di situs sumber scraping umumnya tidak berlisensi. Menampilkan ulang embed/link-nya
> berisiko hak cipta — pertimbangkan sebelum dipublikasikan, dan tetap tampilkan platform legal.
