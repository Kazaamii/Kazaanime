# 🌸 Kazanime — Refactor Multi-Halaman

Refactor dari `index-final-v4.html` (±3.850 baris CSS/HTML/JS campur) menjadi
proyek multi-halaman berbasis **ES Modules**, dengan pemisahan **data ↔ UI**,
satu **format anime yang dinormalisasi**, dan (di Tahap D) **backend scraper**
beradapter.

| Tahap | Isi | Status |
|---|---|---|
| **A** | Pecah struktur halaman + CSS, komponen bersama (navbar, footer, modal, toast), tema | ✅ Selesai |
| **B** | Layer API (`js/api/`: cache, timeout, retry, fallback), auth & bookmark, pencarian, data homepage, jadwal WIB, status API | ✅ Selesai |
| **C** | `watch.html`: satu player + fallback server otomatis, episode, info, download, rekomendasi | ✅ Selesai |
| **D** | Backend Express + adapter `animexin` / `kuramanime` + fallback metadata (satu project Vercel) | ✅ Selesai |
| **D+** | Perbaikan 22 Okt 2026: player memutar server **hasil scraping lebih dulu** untuk semua anime; MegaPlay (`megaplay.buzz`) jadi cadangan; perkiraan jumlah episode saat AniList mati | ✅ Selesai |
| **D++** | Perbaikan 22 Okt 2026 (2): **Samehadaku** (anime Jepang, Sub Indo) menggantikan Kuramanime; tombol **Server 1, 2, …**; **Jadwal Rilis** dari Samehadaku + AnimeXin (`/api/anime/schedule`); poster donghua Kitsu → **Bangumi** → **MangaBaka**; donghua cadangan via Kitsu & bergambar; cadangan Vidnest/TryEmbed | ✅ Selesai |
| **E** | Perbaikan 22 Okt 2026 (3): **Genre & Jadwal di atas** beranda (hasil genre langsung di bawah tombol); server cadangan #2 → **ReAnime**, + tombol **AniZone "Multi Sub"** (player HLS bawaan + proxy); **tombol bookmark kartu** di pojok poster; **ikon** pengganti emoji; font **Figtree + Bricolage Grotesque**; donghua + **Anichin**; Sub Indo + **Otakudesu**, **Anoboy** & **Sakunime** (robots.txt fail-closed) + **hianime.ro**; **Jikan dihapus** | ✅ Selesai — lihat [Batasan Cloudflare](#-batasan-cloudflare-dicek-22-okt-2026) |
| **F+** | Subtitle lokal untuk pemutar HLS: pilih `.srt` / `.vtt` di browser, konversi SRT→WebVTT, ganti/hapus track; tidak diunggah | ✅ Selesai |
| **G** | Penguatan feed Sub Indo 23 Okt 2026: verifikasi beranggaran waktu, batas kandidat per situs, fallback episode sebelumnya, ringkasan & tombol coba lagi per panel, panel gagal ringkas dengan diagnosis tergabung dan tautan "Buka situs" (tanpa bypass) | ✅ Selesai |
| **H** | Pengganti saat sumber gagal 23 Okt 2026: **AnimeKu** (`ww2.animeku.lol`) dan **Oploverz** (`oploverz.ch`, dikenal juga sebagai Animeloverz) sebagai adapter penuh + panel Sub Indo cadangan; bukti Sub Indo tetap per episode | ✅ Selesai |
| **I** | Katalog 23 Okt 2026: panel Sub Indo tinggal **AnimeKu** + **Oploverz** (Samehadaku, Sakunime, Otakudesu, Kuramanime tidak lagi jadi panel); endpoint **`/api/anime/browse`**; halaman baru **Jelajah** (`katalog.html`) dengan tiga tab (AnimeKu / Oploverz / Donghua), bagian berurutan, filter genre, dan Coming Soon dari metadata | ✅ Selesai |
| **J** | 24 Okt 2026: **verifikasi per episode dihapus** — panel beranda menampilkan katalog AnimeKu & Oploverz apa adanya (tanpa batas waktu, tanpa "tanpa bukti"), plus tombol **Tampilkan lebih banyak** di tiap panel; **Jelajah** kembali punya tombol expand per bagian (tetap dengan **Lihat Semua** → `?filter=<bagian>`) | ✅ Selesai |
| **K** | 24 Okt 2026 (lanjutan): **menu genre situs** (±70 chip jadi satu tombol), **Donghua dari AnimeKu & Oploverz**, **auto refresh AnimeKu & Oploverz** (percobaan ulang otomatis untuk timeout/jaringan/5xx, muat ulang saat jaringan kembali/tab aktif/data basi, cadangan lokal `kz:donghua-last`, tombol **Muat ulang** di bagian Donghua), Sub Indo tahan jaringan ponsel | ✅ Selesai |

---

## 📁 Struktur folder (final)

Tanda: ✅ sudah ada & berfungsi · 🅒 baru/diubah di Tahap C · 🅓 baru/diubah di Tahap D · 🅔 baru/diubah di Tahap E (22 Okt 2026) ·
🅕 baru/diubah di Tahap F — Subtitle Indonesia (AI) · 🅖 subtitle lokal browser (22 Okt 2026) ·
🅗 feed Sub Indo per sumber (23 Okt 2026, verifikasi dihapus 24 Okt 2026) · 🅘 katalog Jelajah (23 Okt 2026) ·
🅙 permintaan 24 Okt 2026: pencarian per sumber, Donghua AnimeKu, semua genre, halaman Bookmark, lapisan efek, proteksi pop-up
🅚 permintaan 24 Okt 2026 (lanjutan): **Jadwal & Genre di paling atas**, paragraf pengantar Sub Indo dihapus, **sort Tahun/Musim/Urutan** di genre, genre **AnimeKu** (23 slug) & **Oploverz** (80 genre + 24 musim), Donghua di **kedua** situs

```
kazanime/
├── index.html                 ✅🅔🅚 homepage: hero, JADWAL, GENRE (filter Tahun/Musim/Urutan + hasil + 19 genre AniList + genre situs), SUB INDO (per sumber, + kolom cari), ongoing, populer, baru rilis, donghua
├── watch.html                 ✅🅒 halaman nonton: watch.html?title=...&ep=1&mal=...&anilist=...[&kitsu=][&slug=&src=]
├── search.html                ✅ ?q=... · ?browse=ongoing|popular|new|donghua · ?genre=Action (+ &sort= &format= &source=)
├── katalog.html               ✅🅘🅙🅚 Jelajah: ?source=…&genre=<slug>&year=<yyyy>&season=<winter|spring|summer|fall>&filter=<bagian>&q=<kata kunci>; bagian berurutan + expand + Lihat Semua + kolom cari
├── bookmark.html              🅙 halaman Bookmark sendiri: cari, urutkan, hapus dari daftar (menggantikan section beranda & tautan navbar)
├── README.md                  ✅🅓
├── package.json               🅓🅔 dependency backend (cheerio/Express/Undici/fetch-socks/tough-cookie; Playwright opsional), skrip dev/start/test/check:sources
├── package-lock.json          🅓
├── vercel.json                ✅🅓🅕 header keamanan + rewrite /api/* → Function + maxDuration 60 dtk (bagian subtitle AI)
├── .env.example               🅔🅕 semua environment variable (opsional) beserta default-nya (+ GEMINI_*, nilai kosong)
├── .gitignore                 🅔 (node_modules, .env, .vercel, .scraper-data)
├── api/
│   └── index.js               🅓 Vercel Function: `export default createApp()`
├── css/
│   ├── base.css               ✅🅔 reset, variabel (+ --font-body/--font-display), 7 tema, ikon .ic, keyframes, partikel tema
│   ├── components.css         ✅ navbar, dropdown, card, skeleton, modal, toast, API status, footer, keterangan section, panel Sub Indo per sumber (+ status & retry)
│   ├── home.css               ✅🅚 hero, genre (+filter Tahun/Musim/Urutan + grup genre situs), jadwal
│   ├── search.css             ✅ tab sumber, filter, muat lagi
│   ├── katalog.css            ✅🅘🅙 blok bagian, tombol expand, tautan "Lihat Semua" (.see-all), pemilih genre, kolom cari
│   ├── bookmark.css           🅙 toolbar cari/urutkan halaman Bookmark (variabel tema)
│   └── watch.css              ✅🅒 player, server, episode, info, download, platform legal (+ urutan mobile)
├── js/
│   ├── theme-preload.js       ✅ script klasik di <head>: pasang tema sebelum render (anti-kedip)
│   ├── config.js              ✅🅓🅔🅕🅙 konstanta UI + API_CONFIG (backend.enabled: true), CACHE_TTL, SCHEDULE + STREAMING_SERVERS, PLAYER (hls, aiSubtitle, sandbox anti pop-up + opt-out per browser) & SUB_INDO (24 hasil, 6 kartu cuplikan), GENRES (18 genre AniList + Isekai)
│   ├── routes.js              ✅🅒 pembuat/pembaca URL watch & search (filter di URL, batas nomor episode)
│   ├── data/
│   │   └── fallback.js        ✅ data cadangan offline (format ternormalisasi)
│   ├── api/                   ← SATU-SATUNYA tempat request jaringan
│   │   ├── normalize.js       ✅🅒 KONTRAK format Anime (+ field detail) + helper label, isSameAnime, airedEpisodeCount
│   │   ├── http.js            ✅🅓 fetchJSON: timeout, retry, cache Map+sessionStorage, dedupe, throttle, circuit breaker
│   │   ├── retry.js           ✅🅚 denganAutoRetry: percobaan ulang khusus kegagalan sementara (timeout/jaringan/5xx/circuit) — 403/429/challenge tidak pernah diulang
│   │   ├── anilist.js         ✅🅒 GraphQL (homepage gabungan, search, jadwal) + detail+rekomendasi dalam 1 query
│   │   ├── kitsu.js           ✅🅒 Kitsu (JSON:API, simple GET) + detail dengan mapping id MAL/AniList
│   │   ├── sources.js         ✅🅓🅔🅕 klien backend /api/anime/* + /api/stream/servers + /api/stream/subai (aktif; mati otomatis bila /api tidak ada) + normalisasi server/download
│   │   ├── streams.js         🅒🅓🅔 server streaming per episode (config + slot penyedia + SEMUA situs backend yang cocok), link download
│   │   ├── subindo.js         ✅🅗 katalog Sub Indo per sumber tanpa verifikasi episode (24 Okt 2026): pengelompokan, dedupe, `sourceIds`, batas 24
│   │   └── index.js           ✅🅓 FASAD untuk UI: rantai fallback (donghua: backend → AniList CN) + getWatchData + getSubIndoHomeSources
│   ├── services/
│   │   ├── storage.js         ✅ localStorage aman
│   │   ├── theme.js           ✅ 7 tema + partikel
│   │   ├── hash.js            ✅ SHA-256 (Web Crypto + cadangan JS murni untuk akses via IP LAN)
│   │   ├── auth.js            ✅ login/daftar/avatar (kompatibel data lama, password di-hash + migrasi otomatis)
│   │   ├── bookmark.js        ✅ bookmark per akun (format lama tetap terbaca) + event lintas tab
│   │   └── history.js         🅒 riwayat tontonan lokal (penanda episode yang sudah ditonton)
│   ├── ui/
│   │   ├── dom.js             ✅ html`` ber-escape otomatis, delegate, fallback gambar
│   │   ├── layout.js          ✅ app shell bersama: menyambungkan UI ↔ auth/bookmark
│   │   ├── navbar.js          ✅
│   │   ├── footer.js          ✅ (+ tombol "📡 Status API")
│   │   ├── modal.js           ✅ manajer modal (Esc, backdrop, focus trap)
│   │   ├── theme-modal.js     ✅
│   │   ├── auth-modal.js      ✅ UI modal masuk/daftar/ganti avatar
│   │   ├── toast.js           ✅
│   │   ├── card.js            ✅🅒 (+ episode tujuan per kartu: "Baru Rilis" → episode terbaru)
│   │   ├── hero.js            ✅
│   │   ├── skeleton.js        ✅
│   │   ├── schedule.js        ✅ jadwal (link + nomor episode, kerangka loading)
│   │   ├── notice.js          ✅ keterangan "data cadangan" + tombol Coba lagi
│   │   ├── search-dropdown.js ✅🅔 autocomplete AniList + Kitsu (bertahap, bisa dibatalkan, keyboard, ARIA)
│   │   ├── api-status.js      ✅ widget status sumber data
│   │   ├── player.js          🅒🅔🅕🅖 SATU player: iframe ATAU video HLS (hls.js / HLS native), mirror, status, tombol server, fallback otomatis, postMessage, subtitle AI & lokal
│   │   ├── ai-subtitle.js     🅕 "Subtitle Indonesia (AI)": track AI (TextTrack/VTTCue) per bagian, subtitle bawaan disembunyikan, pilihan pengguna dihormati
│   │   ├── local-subtitle.js  🅖 pilih .srt/.vtt lokal, konversi SRT→WebVTT, track browser + cleanup object URL; tanpa upload
│   │   ├── icons.js           🅔 ikon garis Lucide (ISC) pengganti emoji: icon() + hydrateIcons() untuk HTML statis
│   │   ├── episode-list.js    🅒 tombol episode (link asli), tab rentang >100 ep, input manual, penanda ditonton
│   │   └── download-list.js   🅒🅓 daftar link download per kualitas (+ format & bahasa subtitle dari backend)
│   ├── vendor/
│   │   └── hls.min.js         🅔 hls.js 1.7.3 (Apache-2.0, LICENSE-hls.js.txt) — dimuat malas saat server HLS diputar
│   ├── home.js                ✅🅓🅔🅗🅚 homepage (feed Sub Indo: ringkasan + coba lagi per panel; genre → hasil di bawah tombol + filter Tahun/Musim/Urutan + genre situs dari `/api/anime/genres`; panel Donghua AnimeKu & Oploverz + **auto refresh**; kartu donghua backend → episode terbaru)
│   ├── search.js              ✅🅓 pencarian & "Lihat Semua"
│   ├── katalog.js             ✅🅘🅙🅚 Jelajah: tab AnimeKu/Oploverz/Donghua, bagian ringkas 6 kartu + expand + Lihat Semua, Muat Lagi, genre + Tahun/Musim (Oploverz), pencarian per sumber, percobaan ulang otomatis
│   ├── bookmark.js            🅙 halaman Bookmark: baca services/bookmark.js, cari & urutkan, ajakan login
│   └── watch.js               ✅🅓🅕 halaman nonton (anime dari backend: server situs sumber didahulukan) + getAiSubtitlePart ke player
└── server/                    🅓 backend Node.js + Express
    ├── app.js                 createApp(): /api/health, /api/bot, /api/anime/*, /api/stream/*, error handler, rate limit masuk (+ klien Gemini bila GEMINI_API_KEY ada 🅕)
    ├── index.js               server LOKAL: API + file frontend (`npm run dev`)
    ├── config.js              semua konstanta backend (+ override lewat env; AI_SUBS 🅕)
    ├── routes/
    │   ├── anime.js           5 endpoint + validasi + header cache CDN
    │   └── stream.js          🅔🅕 /api/stream/servers (ReAnime + AniZone) · /hls (proxy HLS bertanda tangan) · /sub (ASS/SRT → WebVTT) · /subai (Subtitle Indonesia AI)
    ├── lib/
    │   ├── fetcher.js         SATU-SATUNYA request keluar: allowlist+redirect aman, robots, proxy, throttle/concurrency, cookies, timeout/retry terbatas; challenge berhenti tanpa retry
    │   ├── proxy-manager.js   proxy HTTP(S)/SOCKS4a/5/5h, health TCP, rotasi terkonfigurasi, cooldown; tanpa direct fallback bila proxy mati
    │   ├── cookie-manager.js  jar tough-cookie per sumber/domain, persistensi AES-256-GCM opsional
    │   ├── fingerprint-manager.js BrowserContext stabil & transparan (UA bot, tanpa stealth)
    │   ├── browser-automation.js Playwright opsional, host allowlist; hanya rendering JS eksplisit, bukan fallback challenge
    │   ├── request-manager.js cache TTL yang ada, backoff terbatas, throttle + semaphore per host
    │   ├── challenge-handler.js deteksi CAPTCHA/403/429/security challenge dan cooldown tanpa solver/retry
    │   ├── stream-proxy.js    🅔 tanda tangan HMAC URL proxy, penulisan ulang playlist m3u8, konversi ASS/SRT → WebVTT
    │   ├── gemini.js          🅕 klien Gemini API (generateContent): model utama → cadangan, pendinginan kuota/key, thinking minimal
    │   ├── subtitle-ai.js     🅕 VTT → bagian (±2 per episode), prompt "nomor|teks", validasi jawaban, cache & dedupe per instance
    │   ├── robots.js          parser & pencocok robots.txt (RFC 9309) + cache; dipakai hanya saat mode enforce/warn
    │   ├── subtitle-evidence.js bukti Sub Indo per episode (track/judul/download/label/deskripsi) — wajib sebelum `lang: 'id'`
    │   ├── rate-limit.js      throttle per host, circuit breaker, rate limit per IP
    │   ├── cache.js           cache TTL + LRU + dedupe + stale-if-error
    │   ├── concurrency.js     🅚 mapLimit(): tugas async paralel berbatas, hasil tetap urut (pencarian donghua)
    │   ├── anime.js           makeAnime()/makeEpisode(): format SERAGAM untuk frontend
    │   ├── slug.js            slug "sumber~path" (animexin~soul-land-2…)
    │   ├── text.js            helper urai teks (episode, status, format, URL, judul)
    │   └── errors.js          error bertipe → status HTTP & pesan ramah
    ├── sources/
    │   ├── index.js           registry + aggregator + fallback (menambah sumber = 1 file + 1 baris)
    │   ├── animexin.js        adapter AnimeXin — donghua + mirror HTML/Base64/URL/meta (tidak fetch hoster) + jadwal
    │   ├── samehadaku.js      adapter Samehadaku — anime Jepang Hardsub Indonesia; embed publik + fallback player_ajax yang eksplisit
    │   ├── animeonsen.js      adapter API AnimeOnsen — OAuth/search token/episode + HLS/native video dan subtitle soft; opt-in fail-closed
    │   ├── kusonime.js        pencarian paket download terpisah — kandidat Romaji + cocok judul exact; hanya halaman lewat robots gate
    │   ├── anoboy.js          adapter Anoboy — anime Jepang, server dari `data-url`; klaim Sub Indo dari bukti halaman episode
    │   ├── sakunime.js        adapter Sakunime — anime Jepang, `data-default` eksplisit; `serverId` opaque diabaikan; bukti dari judul episode
    │   ├── anichin.js         🅔 adapter Anichin — donghua Sub Indo (tema AnimeStream, parser bersama AnimeXin) + jadwal berjam
    │   ├── otakudesu.js       🅔 adapter Otakudesu — anime Jepang Hardsub Indonesia (diblokir Cloudflare untuk IP pusat data, lihat batasan)
    │   ├── kuramanime.js      adapter Kuramanime opt-in; nonaktif default; klaim bahasa hanya bila halaman menyebutnya; token player tidak di-bypass
    │   ├── animeku.js         adapter AnimeKu — kartu rilis terbaru → slug seri; judul episode tanpa "Sub Indo" tidak diklaim Indonesia
    │   ├── oploverz.js        adapter Oploverz (Animeloverz) — kartu `article.bs`, daftar episode `.eplister`, server `#embed_holder`; tanpa klaim bahasa otomatis
    │   ├── hianime.js         🅔 adapter hianime.ro — anime Jepang, subtitle Inggris (REST otakuthemes)
    │   └── metadata.js        fallback API publik Kitsu → AniList (Jikan dihapus) + poster Kitsu → Bangumi → MangaBaka
    ├── providers/             🅔 penyedia server berbasis id/judul (bukan katalog)
    │   ├── index.js           registry + cache + status per penyedia
    │   ├── reanime.js         ReAnime: /api/flix/<id AniList>/<ep> → embed flixcloud (Sub English)
    │   ├── anizone.js         AniZone: pencarian → halaman episode → HLS + subtitle multi-bahasa
    │   └── match.js           pencocokan judul (2nd Season = Season 2 = II)
    ├── scripts/
    │   ├── check-sources.js   `npm run check:sources [-- --live]`: laporan robots/ToS/kesehatan sumber
    │   └── check-subtitle-evidence.js `npm run check:subindo`: bukti Sub Indo per halaman episode (fixture, offline)
    └── test/                  `npm test` (node:test) + fixtures/ (HTML/JSON asli dipangkas; Otakudesu anime/episode = rekonstruksi struktur)
```

---

## ▶️ Menjalankan secara lokal

> ⚠️ **Jangan buka lewat `file://`** (klik dua kali file HTML). ES Modules diblokir
> browser di `file://`, dan AniList menolak request tanpa header `Referer`
> (halaman `file://` tidak mengirim Referer). Gunakan server lokal.

**Lengkap (frontend + backend scraper)** — butuh **Node.js ≥ 20.18**:

```bash
cd kazanime
npm install
npm run dev        # → http://localhost:3000  (auto-restart saat file server/ berubah)
# npm start        # sama, tanpa watch
# PORT=3001 npm run dev   # bila port 3000 terpakai (PowerShell: $env:PORT=3001; npm run dev)
```

Satu server melayani halaman (`index.html`, `watch.html`, `search.html`, `katalog.html`, `css/`, `js/`) **dan** `/api/*`.
Sumber default tidak membutuhkan API key. AnimeOnsen opsional memerlukan kredensial resmi dan allowlist host media yang dikonfirmasi operator; lihat `.env.example`.

**Frontend saja (tanpa Node)** — tetap berjalan normal, fitur backend mati otomatis:

```bash
python -m http.server 5500          # atau: npx serve -l 5500 .  · atau VS Code Live Server
```

Server statis membalas 404 (non-JSON) untuk `/api/...` → frontend menandai backend "tidak ada"
untuk halaman itu (1 request), section Donghua memakai AniList, bagian download menampilkan
"belum tersedia" tanpa pesan error. Ingin Live Server **dan** backend sekaligus? Jalankan
`CORS_ORIGINS=http://127.0.0.1:5500,http://localhost:5500 npm run dev`, lalu isi `API_CONFIG.backend.baseUrl`
dengan `'http://localhost:3000'` di `js/config.js`.

Yang bisa dicoba (Tahap D):
- `/` → section **Donghua** berisi rilis terbaru AnimeXin (via backend); klik kartu → episode terbaru diputar dengan Multi Sub lebih dulu bila tersedia, bahasa lain tetap sebagai opsi + link download
- `/api/anime/latest` · `/api/anime/search?q=soul%20land` · `/api/anime/animexin~soul-land-2-the-peerless-tang-clan` · `/api/anime/animexin~soul-land-2-the-peerless-tang-clan/episode/175`
- `/api/health` (status sumber, robots, circuit, cache) · `/api/bot` (info bot untuk admin situs sumber)
- `npm run check:sources -- --live` → laporan robots.txt/ToS + uji ambil data tiap sumber
- `npm run check:subindo` → bukti Sub Indo **per halaman episode** dari fixture: judul/deskripsi yang dikutip,
  label download, label server — plus kontrol negatif dari situs yang sama (offline)
- `npm test` → 340 unit test backend + helper UI frontend (tanpa internet)

Yang bisa dicoba (Tahap C):
- klik kartu mana pun → `watch.html`: player, daftar episode asli, info + sinopsis, rekomendasi
- `/watch.html?title=One%20Piece&ep=1100&anilist=21&mal=21` — 1000+ episode → tab rentang 1–100, 101–200, ...
- `/watch.html?mal=52991` — hanya id MAL → server 2 langsung diputar, id AniList dicari otomatis
- `/watch.html?title=Frieren` — hanya judul → id dicari lewat AniList → Jikan → Kitsu
- pilih episode / ◀ ▶ / ⟳ Server Lain, centang **Auto-next**, bookmark dari halaman nonton

Yang bisa dicoba (Tahap B):
- `/` — homepage dengan data live, genre, jadwal WIB (scroll ke bawah), bookmark setelah login
- ketik di kotak cari (min. 2 huruf) → dropdown MAL + Kitsu + AniList; ↑/↓ lalu Enter
- `/search.html?q=one piece` — tab sumber, urutan, filter format, "Muat Lebih Banyak"
- `/search.html?browse=ongoing` · `?browse=new` · `?browse=donghua` · `?genre=Isekai`
- `/katalog.html` — **Jelajah**: AnimeKu (Terbaru → New Anime Populer → Top Favorit → Coming Soon → Complete),
  tiap bagian ringkas 6 kartu + tombol **Tampilkan lebih banyak** + tautan **Lihat Semua**; tab **Oploverz** (Terbaru → Populer → Rating Tertinggi →
  Ongoing → Completed → Movie) dengan **filter genre**; tab **Donghua** (rilis terbaru)
- footer → **📡 Status API** untuk mengecek ulang semua sumber

Membuka dari HP di jaringan yang sama (`http://192.168.x.x:5500`) juga didukung: login tetap
bekerja karena hash password memakai cadangan JavaScript bila Web Crypto tidak tersedia.

**Menguji fallback:** DevTools → Network → klik kanan request `graphql.anilist.co` →
*Block request domain* → reload. Section otomatis pindah ke Kitsu; blokir semua
domain API untuk melihat data cadangan + tombol "Coba lagi".
Cache tersimpan di **sessionStorage** (hilang saat tab ditutup); untuk memaksa data baru,
tutup tab atau hapus kunci `kz:cache:*` di DevTools → Application.

---

## 🔌 Lapisan data (Tahap B)

```
UI (home.js, search.js, ui/*)
      │  hanya memanggil fungsi di js/api/index.js, menerima objek Anime
      ▼
api/index.js  ── rantai fallback: AniList → Kitsu → data statis   (Jikan/MAL dihapus 22 Okt 2026)
      │
anilist.js · kitsu.js · sources.js   (normalisasi → createAnime())
      │
api/http.js  ── fetchJSON(): satu-satunya fetch()
```

| Fitur | Detail |
|---|---|
| Timeout | AbortController sungguhan (AniList 8 dtk, Kitsu 7 dtk, autocomplete 6 dtk) |
| Retry | 1× untuk error jaringan / 5xx / 429 (hormati `Retry-After`); timeout tidak diulang |
| Cache | Map + sessionStorage, berisi data yang **sudah dinormalisasi** (kecil). Homepage 15 mnt, jelajah/cari 10 mnt, jadwal 60 mnt |
| Dedupe | Hero + 4 section homepage memakai **1 request AniList** yang sama |
| Circuit breaker | Sumber yang gagal dilewati 90 dtk (juga di halaman lain) → fallback instan; tombol "Coba lagi" membukanya |
| Pesan error | `friendlyError()` → kalimat Bahasa Indonesia (offline, timeout, 403, 429, 5xx, ...) |
| Status API | Diambil dari request yang benar-benar dipakai; hanya sumber yang belum terpakai yang di-ping ringan |

Jumlah request saat membuka homepage pertama kali: **1 AniList** (+1 ping ringan Kitsu untuk
widget status, sekali per sesi). Reload / kembali ke homepage: **0 request** (cache).
File asli: ±12 request setiap kali dibuka, login, atau logout.

**Menambah sumber metadata baru:** buat `js/api/<sumber>.js` yang mengembalikan
`{ items: Anime[], hasNext }` lewat `createAnime()`, lalu tambahkan langkahnya di rantai
yang relevan di `js/api/index.js`. UI tidak perlu diubah.

---

## 🌸 Feed Sub Indo di beranda

Section **Anime Jepang Sub Indo** tepat di bawah hero tetap dipisah per situs.
`GET /api/anime/latest-subindo` mengirim judul terbaru **AnimeKu** dan **Oploverz**;
beranda menampilkannya apa adanya, tanpa pemeriksaan episode.

> **24 Okt 2026 — verifikasi per episode dihapus** (permintaan pengguna: *"hapus fitur ini,
> tidak perlu pencocokan filter; AnimeKu & Oploverz sudah situs Sub Indo dengan
> ekosistemnya sendiri"*). Panel tidak lagi memanggil endpoint episode, tidak punya batas
> waktu, dan tidak menyembunyikan judul "tanpa bukti". `SUB_INDO` (`js/config.js`) kini
> hanya berisi `resultLimit: 24` dan `previewLimit: 6`.

| Aspek | Perilaku |
|---|---|
| **Sumber panel** | Hanya **AnimeKu** lalu **Oploverz** (`SUB_INDO_LATEST_SOURCE_ORDER`). Samehadaku, Sakunime, Otakudesu, dan Kuramanime tidak lagi menjadi panel; adapter mereka tetap bisa dipakai pencarian halaman nonton. `js/home.js` juga menyaring `PANEL_SOURCE_IDS` = `animeku`/`oploverz` sebagai jaring pengaman untuk respons lama di cache CDN/browser, jadi keempat situs itu tidak muncul lagi meski API mengirimnya. |
| **Tampilan panel** | **6 kartu** (`SUB_INDO.previewLimit`) + tombol **Tampilkan lebih banyak (24)** yang langsung membuka sisa judul yang sudah dimuat (tanpa request baru; tombol berubah jadi **Tampilkan lebih sedikit**) + tautan **Lihat Semua** (`.see-all`) menuju `katalog.html?source=<situs>`. |
| Ringkasan | "N situs · N judul" dihitung dari respons backend, bukan teks statis; daftar feed di intro juga dari backend. |
| **Tanpa pemeriksaan** | `groupSubIndoSources()` hanya mengelompokkan, membuang duplikat (slug/judul), dan memotong ke `resultLimit`. Tidak ada `getEpisode`, `timeBudgetMs`, `maxChecks`, atau label "terverifikasi"/"tanpa bukti". |
| Coba lagi per panel | Tombol **Coba lagi** mengambil katalog baru (`refresh` → `force` + `noCache`, termasuk `cache: no-store`) hanya untuk situs itu (`sourceIds`); panel lain tidak ikut dimuat ulang. |
| Panel kosong/gagal | Situs tanpa judul tampil sebagai **satu baris** (ikon + diagnosis + tindakan), bukan kotak kosong besar. Diagnosis hanya ditulis sekali: pesan yang sama untuk beberapa situs digabung pada keterangan global ("Penyebab: … (AnimeKu, Oploverz)"). |
| Label jujur | `blocked`/`policy`/`rate_limited`/`robots` diberi label **Akses dibatasi** (kita sengaja berhenti), sedangkan `parse`/`network` tetap **Sumber bermasalah**. Tidak ada kesan situsnya "rusak" saat penyebabnya kebijakan. |
| Buka situs | Panel kosong/gagal menyertakan tautan `homeUrl` (`target="_blank"`, `rel="noopener noreferrer"`, hanya `http(s)`). Ini tautan biasa — **bukan** upaya menembus Cloudflare/robots, dan tidak ada stealth, solver CAPTCHA, atau rotasi proxy. |
| Tanpa backend | Section menampilkan pesan yang bisa dicoba lagi; tidak ada judul metadata cadangan yang diklaim Sub Indo. |

Bukti subtitle tetap ada di sisi server: `server/lib/subtitle-evidence.js` menandai
`subtitleEvidence` pada data episode (dipakai halaman nonton dan `npm run check:subindo`),
tetapi beranda tidak lagi memakainya untuk menyaring judul.

Tes offline: `server/test/subindo-home.test.js` (pengelompokan per situs, dedupe, batas
24, `sourceIds`, fallback, tanpa request episode), `server/test/subindo-ui.test.js`
(markup ringkasan, tombol expand, Lihat Semua, konstanta config, CSS), dan
`server/test/subindo-state.test.js` (label status, diagnosis, penggabungan penyebab,
validasi `homeUrl`, helper verifikasi lama sudah hilang). `server/test/frontend-media.test.js`
juga menguji fasad Sub Indo tanpa pemeriksaan episode dan `browse` per sumber.
`server/test/subtitle-evidence.test.js` tetap menguji deteksi bukti sisi server.

## 🔁 Sumber pengganti: AnimeKu & Oploverz (23 Okt 2026)

Saat panel Samehadaku/Sakunime/Otakudesu/Kuramanime kosong karena `403`, batas waktu, atau
robots.txt yang tidak terbaca, dua situs berikut dipakai sebagai **sumber pengganti**.

| Sumber | Id | Alamat default | Yang diambil | Batas |
|---|---|---|---|---|
| **AnimeKu** | `animeku` | `https://ww2.animeku.lol` (`ANIMEKU_BASE_URL`) | Beranda (`article.aku-sel` untuk seri, `article.aku-rel-sel` untuk rilis terbaru), halaman seri `.aku-eplist`, halaman episode `/play/<slug>/` | Situs membalas **403** untuk User-Agent browser dari IP pusat data, tetapi **200** untuk User-Agent bot jujur (`KazanimeBot/1.0 …`) — jadi adapter memakai UA bot bawaan proyek (`SCRAPER_USER_AGENT`). 403 tetap dilaporkan sebagai `blocked` dan **tidak** diulang, diakali, atau dilewati dengan stealth/proxy/solver. |
| **Oploverz** (Animeloverz) | `oploverz` | `https://oploverz.ch` (`OPLOVERZ_BASE_URL`) | Beranda `article.bs`, halaman seri `/series/<slug>/` + `.eplister`, halaman episode `#embed_holder` | Snapshot halaman episode tidak memuat daftar unduhan/mirror, jadi `downloads` dikirim kosong (tidak dikarang). Player yang tampil hanya iframe yang benar-benar ada di HTML. |

**Bukti Sub Indo tetap per episode.** AnimeKu menyebut "Nonton … Sub Indo HD" di halaman episode
(judul + deskripsi); Oploverz memakai judul "… Episode N Subtitle Indonesia". Bila penanda itu
dihapus dari halaman yang sama, server tetap bisa diputar tetapi judulnya **tidak** dihitung
Sub Indo — lihat baris kontrol negatif `animeku`/`oploverz` pada `npm run check:subindo`.

**Mematikan:** hapus `animeku` dan/atau `oploverz` dari `SCRAPER_SOURCES` (atau dari
`SOURCES.enabled` di `server/config.js`). Keduanya juga ikut di pencarian halaman nonton
(`/?s=<judul>`) tanpa mengubah urutan sumber lama.

## 🧭 Halaman Jelajah / katalog (23 Okt 2026)

`katalog.html` (menu **Jelajah**) menampilkan katalog per bagian, tanpa perlu mengetik
pencarian. Ada tiga tab:

| Tab | Bagian (urutan tetap) | Filter genre |
|---|---|---|
| **AnimeKu** | Terbaru (`baru`) → New Anime Populer (`populer`) → Top Favorit (`favorit`) → Coming Soon → Complete (`selesai`) → Donghua di AnimeKu (`donghua`) | ✅ 23 genre slug terverifikasi (`/genre/aksi/`), tanpa musim |
| **Oploverz (Animeloverz)** | Terbaru (`update`) → Populer (`popular`) → Rating Tertinggi (`rating`) → Ongoing → Completed → Movie → Donghua di Oploverz (`donghua`) | ✅ 80 genre + **Tahun/Musim** (`season[]`, 24 musim) dari form `/series/` |
| **Donghua** | Donghua Baru Upload (feed Donghua Kazanime: AniList negara CN → backend AnimeXin/Anichin) | — |

**Tampilkan lebih banyak + Lihat Semua.** Setiap bagian tampil ringkas **6 kartu** dengan
dua jalan untuk melihat sisanya:

- **Tampilkan lebih banyak (n)** — membuka semua judul yang **sudah dimuat** di dalam bagian
  itu (tanpa request baru); tombol berubah menjadi **Tampilkan lebih sedikit**. Setelah
  terbuka, **Muat Lagi** mengambil halaman berikutnya (`page` 1..500) tanpa mengacak urutan.
- **Lihat Semua** (`.see-all`, seperti section *Ongoing Anime* / *Anime Populer* di beranda) —
  membuka halaman yang sama dalam mode daftar penuh (`?filter=<bagian>`), dengan
  **Muat Lagi** dan tautan **← Semua bagian** untuk kembali.

Keduanya kompak di kepala bagian pada layar lebar dan menumpuk rapi di layar sempit.
Kartu katalog tidak pernah diklaim Sub Indo — klaim itu hanya milik panel beranda.

**Hemat request.** Bagian dimuat saat mendekati layar (`IntersectionObserver`, `rootMargin`
400 px); bagian pertama langsung dimuat. Fetcher tetap menahan 1 request/detik/host, jadi enam
bagian tidak menembak bersamaan.

**Bagian turunan & batas situs (dicek 23 Okt 2026).**

| Keinginan | Kenyataan di situs | Yang dipakai |
|---|---|---|
| AnimeKu "New Anime Populer" | tidak ada halaman populer | token `populer` = halaman **Baru** (rilis terbaru) diurutkan skor tertinggi pada halaman itu |
| AnimeKu "Coming Soon" | `/upcoming/`, `/jadwal/`, `/jadwal-rilis/`, `/schedule/` → **404**; tidak ada sitemap | bagian **Coming Soon** memakai metadata **AniList** (`status: NOT_YET_RELEASED`, cadangan Kitsu) dan kartunya diberi label sumber + "Segera" |
| AnimeKu "Filter Genre" | `/genre/` → **404**, tetapi arsip genre **bisa dibuka lewat slug**: `/genre/aksi/` dialihkan situs ke `/genre/aksi-<token>/` (30 kartu + paginasi, dicek 24 Okt 2026). 5 slug 404 (`sci-fi`, `mahou-shoujo`, `kehidupan-sehari-hari`, `sekolah`, `laga`) dan `josei` kosong | `GENRE_CATALOG` berisi **23 slug** yang benar-benar 200 + ada kartu; genre di luar daftar → `400` (tidak ada URL tebakan) |
| AnimeKu "Donghua" | tidak ada kategori donghua: `/donghua/` → **404**, `/negara/china-n5z6n97/` → **200 tetapi 0 kartu**, dan seri donghua pun dilabeli "Negara: Japan" | bagian **Donghua di AnimeKu** = judul donghua tayang (metadata AniList, negara CN) yang dicari di halaman pencarian situs; kartu yang tidak cocok dibuang. Jelas ditulis sebagai deteksi, bukan kategori situs |
| Oploverz "Donghua" | `?type=donghua` & `?genre[]=donghua` → **0 kartu**, `/donghua/` → **404**, tidak ada genre donghua | bagian **Donghua di Oploverz** = judul donghua tayang (metadata) dicari di `?s=`, hanya kartu yang cocok dipakai; tab **Donghua** tetap feed Donghua Kazanime |
| Oploverz "Coming Soon" | `?status=upcoming` valid tetapi **0 kartu** saat dicek | tidak ditampilkan; tab Oploverz memakai Ongoing/Completed |

Tidak ada URL atau kategori yang dikarang: setiap token filter yang dipakai sudah diuji ke halaman
aslinya (`server/test/animeku.test.js`, `server/test/oploverz.test.js`).

**State URL.** `katalog.html?source=animeku|oploverz|donghua&genre=<slug>&year=<yyyy>&season=<winter|spring|summer|fall>&filter=<bagian>`
(disimpan dengan `history.replaceState`, jadi refresh/berbagi tautan tetap sama; `filter`
hanya diterima bila bagian itu memang ada di sumber yang dipilih). Kartu memakai varian `catalog`
(badge sumber + nomor episode terakhir) dan membuka **episode terbaru** begitu detail dimuat; kartu
di sini **tidak** mengklaim Sub Indo — klaim itu hanya datang dari panel beranda yang memeriksa
halaman episode.

**🔎 Pencarian di dalam sumber (24 Okt 2026).** Kolom **Cari** di atas daftar bagian mencari
langsung di situs yang sedang dibuka (`?s=` AnimeKu/Oploverz), bukan di metadata. Hasilnya satu
blok **Hasil untuk “<kata kunci>”** (maks. 60 judul, tanpa paginasi); kata kunci < 2
karakter ditolak dengan pesan yang jelas, dan pemilih genre disembunyikan selama mode pencarian.
Panel Sub Indo di beranda juga punya kolom cari sendiri yang meneruskan kata kunci ke halaman
Jelajah dengan tab sumber itu (`katalog.html?source=animeku&q=…`). Kata kunci disimpan di URL
(`?q=`), jadi refresh/berbagi tautan tetap sama.

**Endpoint.** `GET /api/anime/browse?source=<id>&filter=<token>&genre=<slug>&year=<yyyy>&season=<winter|spring|summer|fall>&page=<n>&q=<kata kunci>`
→ `{ source, data: { items, page, hasNext, filters, genres, seasons, filter, genre, query }, fallback: false, stale, errors }`.
`year`/`season` hanya dipakai Oploverz (`season[]=<musim>-<tahun>`; tahun saja = empat musim diminta);
AnimeKu mengabaikannya dan panel menyembunyikan pemilih musim. `GET /api/anime/genres` mengirim
`{ data: { sources: [{ id, name, genres, seasons }] } }` untuk panel genre di beranda.
Dengan `q` (2–100 karakter) endpoint memakai pencarian adapter dan `hasNext` selalu `false`.
Validasi: token/parameter asing → `400`, sumber tanpa halaman daftar → `400`, sumber tidak dikenal → `404`.

**🐉 Donghua di AnimeKu.** Bagian tambahan di tab AnimeKu menjawab pertanyaan "AnimeKu punya
donghua?" — ya, dan situsnya **tidak** memberinya kategori (lihat tabel di atas). Backend
mengambil 20 judul donghua tayang dari metadata (`metadata.latestDonghua()`, AniList negara CN),
lalu adapter mencari **3 judul pertama** di `/?s=` AnimeKu (jeda 1 detik/host, hasil di-cache)
dan hanya memakai kartu yang judulnya cocok (dinormalisasi: tanpa tanda baca & penanda season).
Kartu ditandai `country: 'CN'`; bila tidak ada yang cocok, bagian menampilkan pesan kosong —
tidak ada judul karangan. Batasnya jujur: donghua lama yang tidak sedang tayang bisa belum
tercakup.

**🔖 Halaman Bookmark (24 Okt 2026).** Daftar bookmark keluar dari navbar yang sempit dan dari
beranda: sekarang ada `bookmark.html` (menu profil → **Bookmark Saya**, dan tautan di footer).
Halaman ini menampilkan semua bookmark akun (sumber data tetap `services/bookmark.js`), punya
kolom cari (judul utama & alternatif) dan urutan **Terakhir disimpan / Judul A–Z / Rating
tertinggi**, serta ajakan masuk bila belum login. Tombol bookmark di kartu tetap berfungsi
(hapus langsung dari halaman ini). Beranda kini hanya menyinkronkan status tombol bookmark.

**🎨 Lapisan efek tema (24 Okt 2026).** `.visual-effects` turun ke `z-index: 0`; `.main-content`
dan `.footer` naik ke `z-index: 1` (player tetap `z-index: 2` + `isolation: isolate`). Jadi
kelopak/salju/gelembung tetap terlihat di ruang kosong, tetapi **tidak pernah** menembus kartu,
foto, atau video.

**🚫 Proteksi pop-up player (24 Okt 2026).** Iframe embed dipasang dengan `sandbox` berisi
`allow-scripts allow-same-origin allow-forms allow-presentation` dan **tanpa**
`allow-popups`/`allow-top-navigation`, sehingga skrip iklan di dalam player tidak bisa membuka
tab baru atau membajak tab Kazanime. Karena sebagian embed menolak sandbox, tombol
**Pop-up diblokir / Pop-up diizinkan** di bawah player bisa melepasnya; pilihan disimpan di
`localStorage` (`kz:popup-guard`) dan hanya berlaku di browser itu. Server `kind: 'hls'|'video'`
memakai `<video>` sendiri sehingga tidak terpengaruh. Ini mitigasi terbaik yang bisa dilakukan
dari sisi halaman — halaman lintas-domain tidak bisa ditutup paksa oleh Kazanime.

## 🎬 Halaman nonton (Tahap C)

Satu implementasi player (`ui/player.js`) menggantikan **dua** salinan di file asli
(modal `#playerModal` + "streaming page" yang saling override).

```
watch.html?title=...&ep=3&anilist=...&mal=...[&alt=judul romaji]
   │  1. cari episode di situs backend aktif lewat judul (default: Samehadaku, AnimeKu, Oploverz, Anoboy, Sakunime,
   │     Otakudesu, AnimeXin, Anichin, hianime.ro; Anoboy/Sakunime hanya berjalan jika robots.txt eksplisit mengizinkan),
   │     judul alternatif & judul tanpa season → Multi Sub diprioritaskan bila tersedia; bahasa lain tetap jadi opsi
   │  2. paralel: GET /api/stream/servers → AniZone (HLS "Multi Sub") + ReAnime (embed) untuk episode itu
   │  3. tidak ada / gagal / > PLAYER.scrapeWaitMs (8 dtk) → server cadangan sesuai urutan config
   │     (AniZone Multi Sub, lalu MegaPlay/ReAnime/Vidnest/TryEmbed), kemudian server Sub Eng hasil scraping
   ▼
getWatchData()  AniList by id/idMal ── 1 request: detail + episode berikutnya + rekomendasi
                 └ gagal → Kitsu by id (mapping id MAL/AniList) → AniList lagi lewat id hasil mapping
                 └ hanya judul → pencarian AniList → Kitsu  ("S2" → "Season 2")
                 └ semua gagal → data dari URL / data cadangan + keterangan & "Coba lagi"
```

| Fitur | Detail |
|---|---|
| Server | Hasil scraping backend dulu (`PLAYER.serverOrder = 'scrape-first'`); jika tersedia, **Multi Sub didahulukan**, lalu server bahasa lain. Cadangan statis juga memulai dari AniZone Multi Sub. Tombol tampil **"Server 1, 2, …"** + badge bahasa subtitle (MULTI SUB / SUB INDO / SUB ENG) — nama penyedia/situs tidak ditampilkan. Server yang belum tersedia tampil dengan ikon gembok dan dilewati; slot ReAnime/AniZone yang masih dicari tampil "mencari…" |
| Fallback otomatis | iframe tidak selesai dimuat dalam `PLAYER.loadTimeout` (15 dtk) **atau** player mengirim event `error` → server berikutnya + toast. Semua gagal → pesan + Bstation/YouTube + "Coba lagi" |
| Batas browser | Halaman error **di dalam** iframe lintas-domain (mis. "video tidak ditemukan") tidak bisa dibaca JavaScript → tombol **⟳ Server Lain** |
| Episode | Jumlah dari API (episode yang **sudah tayang**, bukan angka 24 tetap). Bila sumber tidak memberi nomor episode (mis. Kitsu saat AniList mati) → **perkiraan tayang mingguan** dari tanggal mulai (maks. 26 episode, dibatasi total). > 100 episode → tab rentang. Tetap tidak diketahui → input nomor manual. Belum tayang → jadwal episode 1 |
| Ganti episode | Tanpa reload, URL ikut berubah (`replaceState`) → bisa di-share. Tombol episode = link asli (klik-tengah = tab baru) |
| Auto-next | Event `complete` dari player (postMessage, atau `ended` di player HLS) → episode berikutnya. Bisa dimatikan (tersimpan). Episode terakhir → "Selesai!" / jadwal episode berikutnya |
| Keamanan postMessage | Hanya dari iframe aktif / origin server terdaftar (dulu: dari origin mana pun) |
| Riwayat | Episode yang sudah dibuka ditandai (`localStorage kz:history`, per browser) |
| Download | Dari backend (Tahap D): per kualitas + format + bahasa subtitle. Tanpa backend: keterangan jujur, tanpa tombol palsu. URL non-http(s) dibuang |
| Rekomendasi | Ikut di query detail AniList (0 request tambahan) → se-genre → populer (cache homepage) |

Jumlah request saat membuka halaman nonton dari kartu: **1 AniList** (detail + rekomendasi).
Ganti episode: **0 request**. Membuka ulang anime yang sama dalam 30 menit: **0 request** (cache).

### ▶️ Urutan server: hasil scraping dulu (perbaikan 22 Okt 2026)

Urutan sejak 22 Okt 2026 (bagian 3) — `servers()` di `js/watch.js`, slot cadangan diatur `STREAMING_SERVERS`:

| Urutan | Sumber | Isi | Subtitle |
|---|---|---|---|
| 1 | **Samehadaku** · **Otakudesu** (backend) | anime Jepang — server per episode + link download | Bahasa mengikuti server; beberapa sumber berisi Hardsub Indonesia |
| 1 | **AnimeXin** · **Anichin** (backend) | donghua — ±11–16 server per episode (OK.ru, Dailymotion, Rumble, Odysee, …) + link download | Variatif; badge mengikuti bahasa yang dinyatakan sumber |
| 2 | **AniZone — Multi Sub** (cadangan pertama) | HLS di player bawaan + 10–16 pilihan subtitle; Indonesia hanya bila tersedia. Chrome/Firefox/Edge/Android: hls.js lewat proxy `/api/stream/hls`; Safari/iOS: HLS native langsung dari CDN | Banyak bahasa |
| 3 | **MegaPlay** `megaplay.buzz` (cadangan) | hampir semua anime Jepang | Inggris |
| 4 | **ReAnime** (cadangan — **menggantikan MegaPlay-MAL**) | embed `flixcloud.cc` dari API publik `reanime.to/api/flix/<id AniList>/<ep>`; mirror HD-2 → HD-1 dicoba otomatis | Inggris |
| 5 | **Vidnest** · **TryEmbed** (cadangan, via id AniList) | pustaka HiAnime yang sama | Inggris |
| 6 | **hianime.ro** (backend) | server "Fast" (player blogger hianime.ro) & "mega" (megaplay.su) — embed berbasis id yang sudah ada di atas tidak diulang | Inggris |

Bila tersedia, server Multi Sub didahulukan; server dengan bahasa tunggal tetap ditampilkan sebagai pilihan berikutnya. Urutan dan
jumlah tombol akhir bergantung pada hasil setiap episode.

Contoh nyata (22 Okt 2026): *The Apothecary Diaries Season 3* ep 2 dicocokkan ke Samehadaku "Kusuriya no
Hitorigoto Season 3". Label bahasa mengikuti hasil tiap sumber; jika AniZone menyediakan Multi Sub untuk episode itu, server tersebut ditempatkan di urutan pertama.

- **Pencocokan judul.** Anime yang dibuka dari kartu AniList/MAL/Kitsu tidak punya slug situs sumber, jadi
  `js/api/streams.js` mencarinya di `/api/anime/search` dengan judul utama **dan** judul alternatif (romaji —
  ikut di URL sebagai `alt`). Cocok bila judulnya sama persis, atau sama setelah penulisan season disamakan
  ("3rd Season" = "Season 3" = "S3"; format AnimeXin "Pinyin [English]" dipecah). Nomor season harus sama,
  jadi season lain tidak ikut tercocokkan. Hasil API metadata (saat semua scraper gagal) tidak dipakai.
- **Menunggu.** Selama mencari, player menampilkan "Mencari server Multi Sub atau pilihan bahasa lain untuk Episode N..."
  (maks. `PLAYER.scrapeWaitMs`, default 8 dtk; biasanya 1–3 dtk, lalu ter-cache). Hasil yang datang setelah
  cadangan diputar tetap ditambahkan sebagai tombol server tanpa memutus video.
- **Samehadaku menggantikan Kuramanime sebagai sumber anime Jepang default.** Adapter Kuramanime tetap tersedia sebagai opt-in,
  tetapi baseline sebelumnya menunjukkan Cloudflare 403 termasuk `robots.txt`; player memakai token anti-bot — tidak di-bypass.
  Samehadaku (`v2.samehadaku.how`, atur lewat `SAMEHADAKU_BASE_URL`) bisa diakses bot, robots.txt hanya melarang
  `/wp-admin/`, dan server videonya ada di HTML publik (`data-embed`). Kuronime juga terjangkau tetapi player-nya
  dimuat lewat loader terenkripsi → tidak dipakai. hianime.ro terjangkau, tetapi isinya subtitle Inggris dan
  servernya MegaPlay/Vidnest/TryEmbed (berbasis id) → tiga embed itu dipakai langsung sebagai cadangan, tanpa scraping.
- **MegaPlay (cadangan).** Host di file asli, `animeplay.cfd`, adalah mirror MegaPlay yang kini di-suspend (semua URL
  → `/cgi-sys/suspendedpage.cgi` = halaman "Account Suspended" di dalam player). Diganti domain utamanya
  `megaplay.buzz` (pola path sama, dicek: episode 1–3 *Kusuriya no Hitorigoto* S3 ada). MegaPlay memutar pustaka
  HiAnime → subtitle **Inggris**, hanya mau diputar bila iframe mengirim header Referer (`PLAYER.referrerPolicy:
  'origin'`), dan episode yang belum dipetakan menampilkan "Oops! Something went wrong" di dalam iframe →
  pakai **⟳ Server Lain**.
- **Pengaturan** (`js/config.js`): `PLAYER.serverOrder = 'static-first'` → perilaku Tahap D (statis dulu).
  Hanya ingin server hasil scraping → `enabled: false` pada keempat server cadangan (anime yang tidak ada di
  situs sumber lalu tidak bisa diputar).
- **Pencarian WordPress.** Samehadaku & AnimeXin mewajibkan SEMUA kata ada, jadi "Kusuriya no Hitorigoto 3rd Season"
  tidak menemukan "… Season 3". Karena itu judul tanpa penanda season ikut dicari (maks. 4 kata kunci, di-cache);
  pencocokan tetap memakai judul lengkap sehingga season lain tidak ikut tercocokkan.

### 📅 Jadwal Rilis (perbaikan 22 Okt 2026)
Rantai: **backend** `GET /api/anime/schedule` → AniList (jam tayang Jepang → WIB) → data contoh (MAL dihapus).
Sejak 22 Okt 2026 (bagian 3) section Jadwal ada **di atas** beranda (setelah Genre) dan ikut menggabungkan
`/schedule/` **Anichin** (donghua Sub Indo + jam perkiraan WIB: halaman situsnya di-cache ±2 jam, jadi jam dihitung
dari item ber-"Jam HH:MM" lalu hitung mundur item lain). Anime & donghua dihitung terpisah per hari
(maks. 8 anime + 5 donghua) supaya donghua berjam tidak menggeser jatah anime Sub Indo.
- Backend menggabungkan `/jadwal-rilis/` **Samehadaku** (jam rilis Sub Indo dalam WIB — dicek: Kikansha S2 terjadwal
  Kamis 03:15, episode 3 terbit Kamis 01:38 WIB) dan `/schedule/` **AnimeXin** (hari rilis donghua, tanpa jam → "—").
  Di-cache 1 jam (`CACHE_SCHEDULE_SEC`). Per hari maks. 8 anime berjam + 4 donghua.
- Klik judul → `watch.html?...&ep=latest&slug=…` → halaman nonton menunggu detail lalu membuka **episode terbaru
  yang ada di situs sumber** (tanpa memutar episode 1 dulu).
- Dulu jadwal hanya dari AniList; karena API AniList sedang menolak semua request, yang tampil selalu "Jadwal contoh".

### 🐉 Donghua & poster (perbaikan 22 Okt 2026)
- Rantai section Donghua: backend (rilis terbaru AnimeXin **+ Anichin** sejak 22 Okt 2026 — kartu ganda lintas situs dibuang; poster Anichin bisa ditampilkan langsung) → AniList CN → **Kitsu** (ONA/TV yang sedang tayang dan
  berjudul pinyin — bekerja tanpa backend & saat AniList mati) → data cadangan. Data cadangan kini **bergambar**
  (poster Kitsu/Bangumi yang dicek HTTP 200), bukan kotak gradasi.
- Poster AnimeXin dilindungi hotlink → backend mencari poster pengganti: **Kitsu** (judul persis) → **Bangumi**
  (judul Mandarin dari halaman seri AnimeXin, nama harus persis sama) → **MangaBaka** (cover manhua, judul persis,
  pilihan terakhir). Hasil live: 14 dari 16 rilis terbaru bergambar; 2 sisanya tidak ada di database mana pun →
  placeholder (lebih baik daripada gambar anime lain). Atur lewat `METADATA_POSTER_SOURCES`.
- Screenshot sebelumnya menampilkan data cadangan karena saat itu backend tidak terhubung **dan** AniList mati.

```js
// js/config.js — contoh menambah server (pola URL dari penyedia yang kamu pakai)
Object.freeze({
    id: 'server-3', flag: '🌐', name: 'Server 3', description: 'Cadangan',
    needs: 'mal', lang: 'en', enabled: true, origins: Object.freeze([]),
    url: ({ mal, ep }) => `https://penyedia-kamu.example/embed/${mal}/${ep}`,
}),
```

---

### 📄 Subtitle lokal (.srt / .vtt)

Pada server yang diputar di video bawaan Kazanime (HLS/native), tombol **Sub Lokal** membuka pemilih berkas di perangkat. Berkas `.srt` dikonversi ke WebVTT di browser; header `.vtt` diperiksa, lalu track dipilih otomatis dan tetap bisa diganti lewat menu CC. Tombol **×** melepas track dan menghapus subtitle lokal dari memori player.

- Batas ukuran **10 MB**. File hanya dibaca browser dan dipasang sebagai Blob URL lokal — **tidak diunggah atau dikirim ke backend**.
- Subtitle dipertahankan di memori saat berganti server pada episode yang sama, tetapi dibersihkan saat pindah episode, menghapusnya, atau menutup player. Object URL/track dilepas saat sumber video berubah.
- Embed iframe pihak ketiga (lintas-domain) tidak dapat diberi track lokal; kontrol hanya muncul untuk player HLS/native milik Kazanime. File tidak disimpan setelah halaman dimuat ulang.

### 🤖 Subtitle Indonesia (AI) — Tahap F (22 Okt 2026)

Permintaan pemilik proyek: bila subtitle Indonesia tidak ada, terjemahkan dengan Gemini Flash lalu matikan subtitle bawaan.

| | |
|---|---|
| Berlaku untuk | Server **AniZone "Multi Sub"** saja — satu-satunya server yang memakai player video kita sendiri (subtitle berupa berkas terpisah). Server iframe (MegaPlay, ReAnime, Vidnest, TryEmbed, hianime.ro, server Sub Indo hasil scraping) **tidak bisa**: video & subtitle ada di dalam player situs lain (lintas-domain, sebagian hardsub) |
| Kapan | Hanya bila episode **tidak** punya subtitle Indonesia **dan** `GEMINI_API_KEY` diisi di server. Terjemahan baru dimulai saat video **benar-benar diputar** (bukan saat halaman dibuka) |
| Sumber | Inggris (non-SDH) → Inggris SDH → Melayu → bahasa lain yang tersedia |
| Tampilan | Track **"Indonesia (AI)"** aktif otomatis, subtitle bawaan disembunyikan (mode `hidden`, tetap termuat). Subtitle asli tetap bisa dipilih di menu subtitle player (ikon CC / menu titik tiga). Bila penonton sudah memilih subtitle lain selama menunggu, pilihannya tidak ditimpa |
| Model | `gemini-3.6-flash` (utama, thinking `minimal` → cepat) → `gemini-3.5-flash-lite` (cadangan bila kuota habis / overload / model tidak ada). Bisa diganti lewat `GEMINI_MODEL`, mis. `gemini-3.8-flash` (Flash terbaru; thinking `low`) |
| Pembagian | Subtitle dibagi per ±220 baris unik → **±2 request per episode TV**; bagian yang sedang ditonton didahulukan (seek ikut mengubah urutan) |
| Cache (pilihan A, tanpa layanan baru) | Respons `/subai` di-cache **CDN Vercel 30 hari** + **browser 7 hari** + memori instance; satu episode cukup diterjemahkan sekali untuk semua penonton selama cache CDN masih ada. Cache CDN bisa hilang saat deploy ulang / beda region → episode diterjemahkan ulang (memakai kuota) |
| Gagal | Kuota harian habis / key ditolak / AI mati → subtitle asli tetap tampil + toast penjelasan. Gagal sementara → diulang (Retry-After dihormati). Baris yang tidak diterjemahkan model tetap **bahasa asli** (dihitung `untranslated`), tidak pernah diisi teks karangan |

**Cara mengaktifkan (pemilik situs):**
1. Buat API key di Google AI Studio (aistudio.google.com/apikey). **Jangan** tempel key di chat/issue/commit —
   repo ini publik; key yang pernah terlihat publik sebaiknya dihapus dan dibuat ulang.
2. Vercel → Project → **Settings → Environment Variables** → `GEMINI_API_KEY` = key tadi (Production + Preview) → **Redeploy**.
3. Cek `https://<domain>/api/health` → `data.aiSubtitles.enabled: true` dan status tiap model (`ready` / `quota-day` / …).
4. Buka episode AniZone yang tidak punya subtitle Indonesia → tekan play → track "Indonesia (AI)" muncul dalam belasan–puluhan detik.

**Kuota & biaya.** Tier gratis Gemini: batasnya tidak lagi dipublikasikan sebagai angka tetap — lihat AI Studio
(per *project*, reset tengah malam waktu Pasifik ≈ 14.00–15.00 WIB). Laporan developer per Sept 2026: ±20 request/hari
untuk Gemini 3.x Flash, ±500/hari untuk Flash-Lite. Tanpa billing aktif, kuota habis = error 429 (tanpa biaya).
Di tier gratis, Google boleh memakai teks yang dikirim untuk memperbaiki produknya. Secara hukum fitur ini sama
abu-abunya dengan proxy AniZone (menerjemahkan subtitle milik pihak lain); hasilnya selalu diberi label "(AI)".

**Yang sudah diuji:** 22 unit test (Gemini tiruan dengan format respons & error resmi) + uji end-to-end lokal di
Chromium 153 headless: backend & frontend asli, hls.js memutar stream HLS H.264/AAC lewat proxy, CDN & Gemini **tiruan**
(tidak ada akses internet ke Google dari sandbox). Terbukti: tidak ada request sebelum video diputar; track AI tampil
& subtitle bawaan tersembunyi; posisi sign `{\an8}` terjaga; 3 bagian urut p0 → p2 → p1 saat penonton lompat ke akhir;
pilihan "subtitle mati" penonton dihormati; kuota habis → subtitle asli + pesan; menu titik tiga Chrome menampilkan
"Captions: Indonesia (AI)". **Belum diuji:** panggilan Gemini sungguhan (butuh key di Vercel), Safari/iOS.

## 🕷️ Backend scraper (Tahap D)

```
Browser (js/api/sources.js) ── GET /api/anime/... (origin sama → tanpa CORS)
      │
Vercel CDN  ── cache s-maxage 10 mnt + stale-while-revalidate 30 mnt (kebanyakan kunjungan berhenti di sini)
      ▼
api/index.js → server/app.js (Express 5)
      │   rate limit masuk 60/menit/IP · batas waktu total 10 dtk · validasi slug/q/ep
      ▼
server/sources/index.js  (registry + aggregator)
      │   latest/search: semua scraper paralel → gabung + dedupe  ─┐ semua gagal
      │   latest-subindo: daftar per sumber (tanpa merge/fallback)   │
      │   detail/episode: dirutekan lewat prefix slug               ├──────────────→ metadata.js
      ▼                                                             │                (Kitsu → AniList)
animexin · samehadaku · anichin · otakudesu · hianime · kuramanime (opt-in) ── makeAnime()/makeEpisode() → format SERAGAM
      │
server/lib/fetcher.js  ── allowlist + validasi redirect → circuit breaker → mode robots (enforce/warn/off) → throttle/concurrency
                          → proxy operator (bila dikonfigurasi) + User-Agent bot + cookie jar sumber
                          → timeout + retry terbatas untuk error jaringan/5xx; 403/429/CAPTCHA/challenge berhenti & cooldown

Browser (watch.js) ── GET /api/stream/servers?ep=&anilist=&title=   (22 Okt 2026)
      ▼
server/providers/  reanime.js (API JSON → embed flixcloud) · anizone.js (pencarian → halaman episode → HLS)
      │
server/routes/stream.js ── /api/stream/hls  : proxy HLS AniZone (URL ditandatangani HMAC, host media di allowlist,
                           playlist ditulis ulang, segmen/key diteruskan + Range; CDN cache lama)
                       ├── /api/stream/sub  : subtitle ASS/SRT → WebVTT (challenge/403/429 tidak diulang)
                       └── /api/stream/subai: (Tahap F) bagian ke-p subtitle diterjemahkan Gemini → JSON cue
                                              (lib/subtitle-ai.js → lib/gemini.js → fetcher; cache CDN 30 hari)
```

### Endpoint & format respons

| Endpoint | Isi `data` |
|---|---|
| `GET /api/anime/latest` | daftar anime (rilis terbaru semua sumber; animexin = episode terbaru tiap seri) |
| `GET /api/anime/latest-subindo` | grup `{ id, name, items, stale, browse, error? }` untuk homepage; tiap sumber tetap terpisah, tanpa fallback metadata. Panel hanya **AnimeKu** lalu **Oploverz** (`SUB_INDO_LATEST_SOURCE_ORDER`, 23 Okt 2026); `browse` menandai sumber yang punya halaman daftar (dipakai tautan "Lihat Semua"). Sejak 24 Okt 2026 homepage **tidak** memeriksa endpoint episode: katalog ditampilkan apa adanya (6 kartu + expand + Lihat Semua); judul yang sama dari situs berbeda tetap menjadi kartu terpisah. Anoboy belum memiliki rute latest terverifikasi; AnimeIndo masih lookup-only. |
| `GET /api/anime/browse?source=&filter=&genre=&year=&season=&page=&q=` | katalog per sumber untuk halaman **Jelajah**: `{ source, data: { items, page, hasNext, filters, genres, seasons, filter, genre, query }, fallback: false, stale, errors }`. `source` wajib punya `supportsBrowse` (AnimeKu, Oploverz); token filter/genre divalidasi → `400`, sumber asing → `404`. Token AnimeKu: `baru`, `populer`, `favorit`, `coming`, `selesai`, `ongoing`, `film`, `donghua`; Oploverz: `update`, `popular`, `rating`, `ongoing`, `completed`, `movie`, `donghua` + 80 genre + 24 musim. `year` (1950–2100) & `season` (winter|spring|summer|fall) opsional |
| `GET /api/anime/genres` | **(baru, 24 Okt 2026)** `{ data: { sources: [{ id, name, genres: [{ id, label }], seasons: [{ id, label, season, year }] }] } }` — AnimeKu 23 genre (musim kosong), Oploverz 80 genre + 24 musim. Satu sumber gagal tidak menggagalkan yang lain (`errors[]`) |
| `GET /api/anime/search?q=` | daftar anime (2–100 karakter) |
| `GET /api/anime/downloads/kusonime?title=<romaji>` | paket unduhan Kusonime yang judul detailnya cocok persis setelah normalisasi (dapat mengirim beberapa `title`). Diakses hanya dari bagian unduhan; hasil bisa berupa satu season/seri, bukan episode tunggal. Mirror tidak di-fetch atau di-decode. |
| `GET /api/anime/schedule` | **(baru, 22 Okt 2026)** `{ timezone: "Asia/Jakarta", days: { 0..6: [{ title, time, slug, source, url, image, country }] } }` — 0 = Minggu; `time` = jam rilis WIB atau `null` (donghua). Didaftarkan **sebelum** `/:slug` |
| `GET /api/anime/:slug` | satu anime + `episodeList: [{ number, title, released, url }]` |
| `GET /api/anime/:slug/episode/:ep` | `{ episode, title, released, url, servers: [{ name, url, lang, subtitleType?, kind?: 'hls'|'video', subtitles? }], downloads: [...] }`. AnimeOnsen media memakai URL proxy same-origin bertanda tangan; respons episode `no-store`. |
| `GET /api/anime/:slug/subtitles?from=&to=` | **(baru, 24 Okt 2026)** Sub Indo **per episode** untuk badge di daftar episode: `{ slug, source, from, to, episodes: [{ number, sub: 'id' \| '' \| null, evidence }] }`. `id` = ada bukti (daftar episode / server / judul episode), `''` = sudah diperiksa tanpa bukti, `null` = belum bisa diperiksa (tanpa badge). Maks **24** episode per panggilan, diperiksa maks 3 permintaan bersamaan, hasil di-cache `CACHE_SUBTITLE_MAP_SEC` (default 30 menit). |
| `GET /api/stream/servers?ep=&anilist=&title=&title=&year=` | **(baru, 22 Okt 2026)** `{ episode, servers: [{ provider, kind: 'embed', name, label, lang, url } \| { provider, kind: 'hls', name, lang: 'multi', url: '/api/stream/hls?…', direct, poster, subtitles: [{ label, lang, default, url: '/api/stream/sub?…' }], ai: { url: '/api/stream/subai?…', from, sourceLabel, label } \| null }], status: { reanime, anizone } }` — status: `ok` / `not_found` / `blocked` / `error` / `stale`. `ai` (Tahap F) hanya ada bila episode **tidak** punya subtitle Indonesia dan `GEMINI_API_KEY` diisi |
| `GET /api/stream/hls?u=&s=&p=` | proxy media bertanda tangan (HLS, MP4/WebM). Tanpa `p` = provider AniZone; `p=animeonsen` hanya untuk URL yang ditandatangani adapter dan exact hostname dalam `ANIMEONSEN_MEDIA_HOSTS`. Playlist ditulis ulang, segmen/key diteruskan; AnimeOnsen memakai `private, no-store` dan robots gate per URL. |
| `GET /api/stream/sub?u=&f=&s=&p=` | ASS/SSA/SRT/VTT dikonversi ke WebVTT. `p=animeonsen` diverifikasi dalam tanda tangan, hostname exact + robots gate; respons no-store. |
| `GET /api/stream/subai?u=&f=&l=&v=&s=&p=` | **(Tahap F)** `{ part, parts, ranges: [[mulai, akhir]…], lang: 'id', label: 'Indonesia (AI)', model, untranslated, cues: [[mulai, akhir, teks, pengaturan]…] }` — hanya URL bertanda tangan dari `ai.url`; parameter lain ditolak. Error: `503 AI_DISABLED` / `AI_QUOTA` (+ `Retry-After`) / `AI_CONFIG`, `504 AI_TIMEOUT`, `502 AI_UPSTREAM` / `AI_BAD_OUTPUT` / `AI_BLOCKED`, `409 AI_STALE` |
| `GET /api/health` | status backend, User-Agent, TTL/cache, robots/circuit, concurrency, status proxy (tanpa host/kredensial), ringkasan cookie (tanpa nilai), status browser & `aiSubtitles` (key tidak ditampilkan) |
| `GET /api/bot` | penjelasan bot **jujur sesuai mode robots aktif** (mode `off` menyatakan bahwa robots.txt tidak ditegakkan dan meminta admin memakai alamat kontak) |

```jsonc
// sukses
{ "ok": true, "source": "animexin", "fallback": false, "stale": false,
  "errors": [{ "source": "samehadaku", "kind": "timeout", "message": "..." }],   // sumber lain yang gagal (opsional)
  "generatedAt": "2026-10-21T17:11:07.546Z", "data": [ /* anime */ ] }
// gagal
{ "ok": false, "error": "Episode 999 belum tersedia di AnimeXin.", "code": "NOT_FOUND" }
```

- **Item anime** memakai field yang sama dengan `createAnime()` di frontend:
  `title, titleAlt, image, banner, description, episodes, latestEpisode, genres, score, status,
  format, year, popularity, country, ids, slug, source, studios, duration, season, nextAiring` (+ `url` halaman asli).
- **Slug menyertakan sumber**: `animexin~soul-land-2-the-peerless-tang-clan`, `samehadaku~kusuriya-no-hitorigoto-season-3`
  (karakter `[a-zA-Z0-9._~-]`, lolos sanitasi `routes.js`). Frontend cukup mengirim slug, tanpa tahu sumbernya.
- `fallback: true` = semua scraper gagal, data dari API metadata publik. `stale: true` = sumber gagal,
  dipakai cache lama (maks 1 jam).
- Status HTTP: `400` input salah · `404` tidak ada (di-cache 5 mnt) · `429` rate limit ·
  `502/503/504` sumber error/diblokir/timeout (+ `Retry-After` bila ada). Pesan error internal tidak pernah bocor.

### Kepatuhan & sopan santun scraper

| Aturan | Implementasi |
|---|---|
| robots.txt | **Mode diatur `SCRAPER_ROBOTS_MODE`** (23 Okt 2026): `off` *(default proyek, permintaan pemilik)* = robots.txt tidak diminta sama sekali; `warn` = dibaca untuk diagnosis tetapi tidak memblokir; `enforce` = perilaku lama (RFC 9309: grup `KazanimeBot`/`*`, kecocokan terpanjang, `*` & `$`, `Crawl-delay`; 4xx = boleh, 5xx/jaringan = dilarang sementara; blokir Cloudflare = **blocked**). Mode aktif tampil di `/api/health` (`robotsMode`) dan `/api/bot` |
| ToS | Hasil peninjauan per sumber di `POLICY.tos` adapter (`allowed` / `unknown` / `forbidden`). `forbidden` → adapter tidak pernah dipanggil. `unknown` → tetap boleh dicoba (gerbang robots tidak lagi memblokir). Data episode tetap membawa bukti subtitle Indonesia sisi server (`subtitleEvidence`), sedangkan panel beranda menampilkan katalog AnimeKu/Oploverz apa adanya — lihat [Feed Sub Indo di beranda](#-feed-sub-indo-di-beranda) |
| User-Agent | `KazanimeBot/1.0 (+https://<domain>/api/bot; <BOT_CONTACT>)` yang deskriptif; tidak meniru browser. Opsi `headers` hanya untuk kebutuhan protokol terdokumentasi (mis. Origin/Referer media), bukan fingerprint spoofing |
| Rate limit keluar | maks 1 request/detik per host (Crawl-delay bisa memperbesar), antrean > 6 dtk ditolak |
| Rate limit masuk | 60 request/menit per IP untuk `/api/anime/*` (header `RateLimit-*`) |
| Cache | memori per instance: latest 10 mnt, search/detail/episode 15 mnt, dedupe request identik, stale-if-error 1 jam; CDN Vercel `s-maxage` |
| Timeout & retry | 6 dtk per request; retry exponential-backoff terbatas hanya untuk error jaringan & 5xx; timeout tidak diulang. 403/429/CAPTCHA/challenge langsung berhenti; 429 memakai `Retry-After` terbatas dan circuit/cooldown |
| Circuit breaker | 2 gagal beruntun → sumber diistirahatkan 60 dtk; semua 403/challenge membuka cooldown tanpa retry; 429 dihentikan dengan cooldown dari `Retry-After` yang dibatasi |
| Anti-SSRF | hanya host allowlist (+ CDN AniZone `xin-cdn.xyz` dan exact hostname AnimeOnsen yang diisi operator); setiap redirect divalidasi sebelum diikuti, redirect robots harus tetap satu origin, header rahasia/cookie tidak diteruskan lintas origin; respons > 3 MB ditolak (segmen maks 40 MB) |
| Proteksi bot | Profil BrowserContext stabil/transparan dengan User-Agent bot; tidak ada stealth/solver. Cookie/proxy hanya untuk request normal sesuai konfigurasi sumber/operator. Challenge tidak memicu retry, rotasi proxy, refresh cookie, atau fallback Playwright; circuit dibuka dan fallback dipakai. Proxy media tetap bertanda tangan + allowlist host |
| Gemini (subtitle AI) | API resmi ber-key (header `x-goog-api-key`, bukan di URL); robots.txt tidak berlaku. Hanya subtitle yang ditawarkan `/servers` (URL bertanda tangan) yang bisa diterjemahkan → key tidak bisa dipakai pihak lain sebagai penerjemah gratis. Rate limit 20/menit/IP untuk request yang lolos cache CDN |
| Proxy stream | `/api/stream/hls` dan `/api/stream/sub` hanya menerima URL bertanda tangan (HMAC, `STREAM_SECRET`) serta host media allowlisted → bukan open proxy. Respons proxy media AnimeOnsen `private, no-store` dan client credentials tidak dikirim ke browser; CDN media tetap memerlukan `ANIMEONSEN_MEDIA_HOSTS` + robots allow. Rate limit terpisah 900/menit/IP. **Memakai bandwidth Vercel** |
| Gambar | poster animexin dilindungi hotlink (403 + `Cross-Origin-Resource-Policy: same-origin`) → diganti poster **Kitsu** → **Bangumi** (judul Mandarin) → **MangaBaka**, hanya bila judul cocok persis (maks 2,5 dtk; sisanya dicari di belakang & respons diberi cache CDN 60 dtk). Poster Samehadaku boleh ditampilkan langsung. Tidak ada proxy gambar |

`npm run check:sources` mencetak laporan ini untuk setiap sumber (tambahkan `-- --live` untuk uji ambil data).

### Status sumber (dicek 21–22 Okt 2026)

| Sumber | Status | Catatan |
|---|---|---|
| **AnimeXin** | ✅ aktif, diverifikasi live | robots.txt mengizinkan semua; tidak ada ToS (DMCA & Privacy Policy tanpa larangan bot). Latest = beranda + `/anime/?order=update` (2 request, slug asli digabung lewat ID seri). 16 server per episode (Dailymotion, OK.ru, Odysee, Rumble, Mega, …) + link download Sub Indo/English |
| **Samehadaku** | 🟡 adapter & fixture teruji; baseline terbaru homepage di-challenge | ToS tidak tertaut → `unknown`. Adapter menyediakan anime terbaru, pencarian, detail, server episode, unduhan, dan jadwal; klaim Sub Indo sekarang dari bukti halaman episode (deskripsi/judul/label), bukan nama situs. Fallback `player_ajax` hanya memakai data-post/data-nume/data-type yang ada di markup dan berhenti pada challenge |
| **AnimeOnsen** | ⚪ opt-in, belum live-tested | Implementasi berdasarkan source extension upstream (Apache-2.0); `supportsLatest=false` (katalog popular tidak dilabeli latest). API/auth/search/robots/ToS dan host CDN belum diverifikasi live. Harus diberi `ANIMEONSEN_CLIENT_ID` + `ANIMEONSEN_CLIENT_SECRET` dari akses resmi, `ANIMEONSEN_MEDIA_HOSTS` berisi hostname CDN yang dikonfirmasi (exact match), serta robots.txt yang terbaca dan mengizinkan host/path site/API/auth/search/CDN media. Tidak ada secret OAuth upstream yang disalin; media di-proxy melalui URL bertanda tangan + `no-store`, tanpa field URL CDN mentah di payload. |
| **Anoboy** | 🟡 default-enabled | Adapter dan fixture offline dari snapshot pengguna (22 Okt 2026). ToS belum ditinjau → `unknown`. Server diambil dari `.aspd-server[data-url]`; label Sub Indo hanya bila judul episode menyatakan "Subtitle Indonesia". Belum live-tested |
| **Sakunime** | 🟡 default-enabled | Adapter dan fixture offline dari snapshot pengguna (22 Okt 2026). ToS belum ditinjau → `unknown`. Hanya `#playerShell[data-default]` eksplisit; `serverId` opaque tidak di-resolve. Bukti Sub Indo dari `data-ep-title`/judul halaman; belum live-tested |
| **Anichin** | 🟡 aktif, parser diverifikasi dgn HTML asli | (22 Okt 2026) robots.txt mengizinkan (kecuali /wp-admin/); tema AnimeStream (parser AnimeXin). Dari IP pusat data: request kadang lolos, kadang challenge Cloudflare (beranda & halaman episode paling sering) |
| **hianime.ro** | ✅ aktif, diverifikasi live | (22 Okt 2026) robots.txt hanya melarang /wp-admin/; tanpa Cloudflare challenge. Recently Updated, pencarian, detail, daftar episode & server lewat REST `wp-json/v1/otakuthemes` — server "Fast" & "mega" (Sub English) |
| **Otakudesu** | 🔴 adapter ada, diblokir | (22 Okt 2026) domain resmi `otakudesu.blog`: robots.txt, beranda, halaman anime/episode → 403 "Attention Required! \| Cloudflare" untuk IP pusat data; hanya pencarian yang lolos. Adapter mengklasifikasikan server Sub Indo sebagai Hardsub sesuai konfirmasi pemilik proyek; sumber tetap ditandai *blocked*, tanpa data palsu. Gunakan hanya bila pemilik sumber memberi akses/allowlist, selain itu fallback dipakai |
| **ReAnime** (penyedia stream) | 🟡 parser diverifikasi dgn JSON asli | (22 Okt 2026) robots.txt mengizinkan semua; `/api/flix/<id AniList>/<ep>` publik. Dari IP pusat data sering di-challenge Cloudflare |
| **AniZone** (penyedia stream) | 🟡 parser & proxy diverifikasi dgn data asli | (22 Okt 2026) robots.txt mengizinkan semua. Halaman episode → HLS + 17 subtitle (termasuk Indonesia). CDN video 200/206 tanpa Referer; halaman & berkas subtitle sering di-challenge dari IP pusat data |
| **Kuramanime** | ⚪ opt-in, nonaktif default | Grup unduhan membedakan Hardsub/Softsub, tetapi halaman tidak menulis bahasa → **tidak diklaim Sub Indo** sampai ada bukti. Adapter hanya aktif bila ditambahkan ke `SCRAPER_SOURCES`. Pengguna memberi `v9.kuramanime.blog` dan `v9.kuramanime.work` sebagai pilihan manual; keduanya belum live-verified. Pilih satu via `KURAMANIME_BASE_URL`; tidak ada auto-failover/rotasi setelah blokir. Token player tidak dipecahkan |
| **Kusonime (download saja)** | 🟡 aktif | Cari paket saat membuka halaman nonton dengan kandidat judul Latin/Romaji; detail harus cocok persis setelah normalisasi. Struktur parser diamati dari [scraper MIT publik](https://github.com/Zmy71/Kusonime-Scraper/tree/8f8e7098f1161d6451471f5c28bdf32fa29aad49), bukan dari live check. ToS/robots/markup belum diverifikasi live; gerbang robots mengikuti `SCRAPER_ROBOTS_MODE` (default `off`). Link mirror tidak di-fetch, di-decode, atau ditebak; dapat berupa paket satu season/seri. Matikan dengan `KUSONIME_DOWNLOADS_ENABLED=0` |
| Bangumi · MangaBaka | ✅ poster pengganti | `api.bgm.tv` (robots hanya melarang /pic/ /img/ /js/) & `api.mangabaka.org/v1` (robots mengizinkan /v1/) |
| Kitsu | ✅ fallback utama | bisa dijangkau server; mapping id MAL/AniList; poster pengganti |
| AniList | ⚠️ fallback berikutnya | dari sandbox: AniList 403 "temporarily disabled" (juga dengan Referer) — di Vercel bisa berbeda; circuit breaker membuatnya cepat dilewati |
| ~~Jikan~~ | ❌ dihapus | 22 Okt 2026 atas permintaan pemilik proyek (frontend & backend) |

### Environment variable (semua opsional)
Lihat `.env.example`. Yang paling berguna: `BOT_CONTACT` (email/URL kontak di User-Agent),
`SCRAPER_SOURCES` (urutan/aktifkan sumber, default `animexin,samehadaku,anoboy,sakunime,anichin,otakudesu,hianime`; `kuramanime` opt-in; `animeonsen` auto-enabled hanya bila kredensial + allowlist media disediakan),
`SAMEHADAKU_BASE_URL` / `ANOBOY_BASE_URL` / `SAKUNIME_BASE_URL` / `ANICHIN_BASE_URL` / `OTAKUDESU_BASE_URL` / `KURAMANIME_BASE_URL` / `HIANIME_BASE_URL` / `ANIMEKU_BASE_URL` / `OPLOVERZ_BASE_URL` (domain sering berganti; Kuramanime hanya satu domain manual per deployment, tanpa failover otomatis), `KUSONIME_BASE_URL` / `KUSONIME_DOWNLOADS_ENABLED` (lookup paket Romaji; terpisah dari `SCRAPER_SOURCES`, robots wajib mengizinkan),
`ANIMEONSEN_CLIENT_ID` / `ANIMEONSEN_CLIENT_SECRET` (authorized credentials, server-side only) dan `ANIMEONSEN_MEDIA_HOSTS` (allowlist operator-confirmed; kosong = no playback),
`CACHE_*_SEC` (termasuk `CACHE_SCHEDULE_SEC` dan `CACHE_SUBTITLE_MAP_SEC` untuk peta Sub Indo per episode), `RATE_LIMIT_PER_MIN`, `METADATA_ORDER`, `METADATA_POSTER_SOURCES`.
Penyedia stream: `STREAM_PROVIDERS` (default `reanime,anizone`), **`STREAM_SECRET`** (≥ 16 karakter acak — isi di
Vercel; tanpa ini secret proxy diturunkan dari ID deployment), `STREAM_PROXY_RATE_LIMIT_PER_MIN`,
`ANIZONE_MEDIA_HOSTS`, `REANIME_EMBED_HOSTS`. Subtitle AI (Tahap F): **`GEMINI_API_KEY`** (kosong = fitur mati),
`GEMINI_MODEL` (default `gemini-3.6-flash`), `GEMINI_FALLBACK_MODEL` (default `gemini-3.5-flash-lite`; `none` = tanpa
cadangan), `AI_SUBTITLES=0` (matikan walau key ada), `AI_SUBTITLE_PART_LINES` / `AI_SUBTITLE_PART_CHARS` /
`AI_SUBTITLE_TIMEOUT_MS` / `AI_SUBTITLE_RATE_LIMIT_PER_MIN`.
Runtime scraper: `SCRAPER_PROXY_URLS` / `SCRAPER_PROXY_URL` (HTTP(S), SOCKS4a/5/5h; credentials URL-encoded; bila
kosong, satu `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` dikenali), `SCRAPER_PROXY_ROTATION` (`round-robin`/`sticky`/
`disabled`), timeout/health/cooldown `SCRAPER_PROXY_*`, `SCRAPER_MAX_CONCURRENCY_PER_HOST`,
`SCRAPER_COOKIES_ENABLED`, `SCRAPER_COOKIE_STORE_KEY` (≥32 byte), `SCRAPER_COOKIE_STORE_PATH`,
`SCRAPER_BROWSER_ENABLED`, `SCRAPER_BROWSER_SETTLE_MS`, `PLAYWRIGHT_EXECUTABLE_PATH`, serta per-sumber
`SAMEHADAKU_RENDER_JAVASCRIPT` / `OTAKUDESU_RENDER_JAVASCRIPT` / `KURAMANIME_RENDER_JAVASCRIPT` dan `*_COOKIES`.
Proxy hanya egress operator yang diizinkan; challenge tidak memicu rotasi atau retry. Cookie persistent dienkripsi
AES-256-GCM di `.scraper-data/cookies.enc`; filesystem Vercel bersifat sementara/per-instance. `playwright-core`
tidak mengunduh browser: ikuti instruksi `.env.example` hanya bila kebutuhan JS rendering sudah diverifikasi.
Lokal: `node --env-file=.env server/index.js`.

### Menambah / mengganti sumber
1. Buat `server/sources/<nama>.js` → factory `create<Nama>({ network, createClient, baseUrl })` yang
   mengembalikan `{ id, name, baseUrl, policy, parseRef, titleHint, latest, search, getAnime, getEpisode }`
   (+ opsional `schedule()` untuk Jadwal Rilis),
   semua hasil lewat `makeAnime()` / `makeEpisode()`. Isi `policy.tos` setelah membaca ToS situsnya.
2. Daftarkan di `FACTORIES` (`server/sources/index.js`) + konfigurasi server-only di `server/config.js`.
3. Tambahkan nama ke `SCRAPER_SOURCES`. Adapter embed biasa tidak perlu mengubah UI; stream langsung/HLS memerlukan kontrak player/proxy yang tervalidasi seperti AnimeOnsen.

### Tes
```bash
npm test                          # unit test: robots, cache, throttle/concurrency, proxy/cookies/fingerprint/browser,
                                  # fetcher (server HTTP lokal, redirect, challenge fail-fast, stream biner), parser semua adapter (fixture;
                                  # Otakudesu anime/episode = rekonstruksi struktur), ReAnime & AniZone (JSON/HTML asli),
                                  # proxy HLS (playlist asli, Range, tanda tangan), ASS/SRT → VTT, jadwal, metadata, routes,
                                  # subtitle AI (Gemini tiruan: format respons & error resmi, kuota, fallback model, /subai,
                                  # pengendali track di frontend dengan TextTrack/VTTCue tiruan)
npm run check:sources -- --live   # uji langsung ke situs sumber (±5 request per sumber)
```

### 🧱 Batasan Cloudflare (dicek 22 Okt 2026)
Diukur dari runner GitHub Actions (IP pusat data, mirip Vercel): **hianime.ro** selalu lolos, tetapi **Anichin, AniZone,
ReAnime, AnimeXin, Samehadaku** di-challenge Cloudflare *kadang-kadang* — request yang sama beberapa detik kemudian
sering lolos, dan pada run lain semuanya diblokir selama beberapa menit. **Otakudesu** memblokir permanen untuk IP pusat data.

Pemeriksaan baseline non-evasif tersedia lewat `npm run check:reachability` dan workflow GitHub Actions
`Upstream reachability baseline`. Runner mengirim User-Agent KazanimeBot yang transparan: satu GET `robots.txt`, lalu
satu GET `/` hanya jika robots.txt terbaca dan mengizinkan (termasuk `Crawl-delay`). Skrip mandiri ini selalu
memeriksa robots.txt dan **tidak** mengikuti `SCRAPER_ROBOTS_MODE` — ia hanya melaporkan keadaan situs. Redirect tidak diikuti; tidak ada
fingerprint browser, cookie, proxy, retry, atau solver challenge. Hasilnya hanya menunjukkan akses biasa saat pemeriksaan,
bukan izin penggunaan konten atau cara untuk melewati proteksi.

Baseline terbaru (22 Okt 2026, 12:16 UTC; suffix `cf-ray` SJC): kedua `robots.txt` membalas 200, tetapi homepage AniZone
dan Samehadaku membalas 403 Cloudflare challenge. Cek ini hanya meminta `/`; endpoint katalog/episode tidak diuji.

**Catatan 23 Okt 2026 — gerbang robots.txt dimatikan atas permintaan pemilik proyek.** Default
`SCRAPER_ROBOTS_MODE=off`: server tidak lagi mengambil `robots.txt` sebelum request. Set
`SCRAPER_ROBOTS_MODE=enforce` untuk mengembalikan perilaku lama, atau `warn` untuk tetap membaca
robots.txt sebagai diagnosis tanpa memblokir. Yang **tidak** berubah: User-Agent tetap jujur,
rate limit per host tetap 1 request/detik, dan 403/429/CAPTCHA tetap berhenti tanpa retry, tanpa rotasi
proxy, tanpa solver, tanpa stealth. Halaman `/api/bot` menyatakan mode ini apa adanya agar admin situs
sumber bisa memakai alamat kontak, bukan robots.txt, untuk meminta penghentian.

- Semua adapter dan jalur media menghentikan 403/429/CAPTCHA/security challenge tanpa retry. Pengaturan retry yang masih ada
  hanya berlaku untuk error jaringan/5xx; proxy tidak dirotasi sebagai respons challenge, cookie tidak di-refresh, dan
  Playwright tidak dipanggil sebagai fallback WAF. Cooldown + cache/fallback yang tersedia dipakai tanpa data palsu.
- Proxy, cookie jar, serta rendering JS adalah konfigurasi operator untuk akses normal yang diizinkan; bukan cara
  menghindari proteksi. Jika sumber memblokir bot, minta akses/allowlist resmi atau biarkan adapter/fallback berhenti.

---

## 🚀 Deploy ke Vercel (lewat GitHub)

Frontend statis (tanpa build) + backend Express sebagai **Vercel Function** di project yang
sama — `/api/...` satu domain dengan halaman, jadi tanpa CORS. `vercel.json`, `package.json`
dan `.gitignore` sudah disiapkan:

| Bagian | Cara Vercel menjalankannya |
|---|---|
| `index.html`, `watch.html`, `search.html`, `css/`, `js/` | file statis di CDN |
| `/api/*` | `rewrites` → `api/index.js` (Express; `req.url` tetap path asli) — `maxDuration` 60 dtk (satu bagian terjemahan subtitle AI bisa butuh puluhan detik; endpoint lain tetap selesai secepatnya) |
| `npm install` | otomatis dari `package.json` (dependensi: `express`, `cheerio`) |
| Node.js | `engines.node` `>=20.18.1` → Vercel memakai versi Node yang didukung |
| `/server/*`, `/package*.json` | di-redirect ke `/` (kode backend tidak ikut disajikan sebagai file) |

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
git commit -m "Tahap D: backend scraper + adapter animexin/samehadaku"
git branch -M main
git remote add origin https://github.com/USERNAME/kazanime.git
git push -u origin main
```

### 2. Import di Vercel
vercel.com → login dengan GitHub → **Add New… → Project** → pilih repo `kazanime` → **Import**:

| Pengaturan | Isi |
|---|---|
| Framework Preset | **Other** (`vercel.json` sudah berisi `"framework": null`) |
| Root Directory | `./` (isi `kazanime` jika yang ter-upload adalah foldernya) |
| Build Command | kosongkan |
| Output Directory | kosongkan |
| Install Command | biarkan default (`npm install`) |
| Environment Variables | opsional — disarankan `BOT_CONTACT` (email/URL kontakmu), `STREAM_SECRET` (≥ 16 karakter acak), dan `GEMINI_API_KEY` bila ingin Subtitle Indonesia (AI) |

Klik **Deploy** → situs aktif di `https://<nama-project>.vercel.app`. Cek: buka
`https://<nama-project>.vercel.app/api/health` → harus `{"ok":true,...}`.
Setiap `git push` ke `main` otomatis deploy ulang; branch lain (mis. `tahap-c`) mendapat
**Preview URL** sendiri untuk dicek sebelum di-merge.

**Tanpa GitHub (alternatif):** `npm i -g vercel` → `cd kazanime` → `vercel` → `vercel --prod`.

### Catatan
- `Referrer-Policy: strict-origin-when-cross-origin` di `vercel.json` **jangan diganti** ke
  `no-referrer`: AniList menolak request tanpa header `Referer`.
- Paket **Hobby** (gratis) hanya untuk pemakaian pribadi non-komersial. Pasang iklan / monetisasi
  → butuh paket Pro. Bila kuota Hobby terlampaui, project dijeda.
- Backend memakai header CDN (`s-maxage=600, stale-while-revalidate=1800`) sebagai cache utama,
  karena memori serverless tidak bertahan antar-instance. Rate limit per IP & throttle bersifat
  per instance (best effort) — perlindungan utama untuk situs sumber tetap cache CDN.
- Hobby: function invocation & bandwidth terbatas per bulan; dengan cache CDN, satu kunjungan
  homepage biasanya tidak memanggil function sama sekali.
- IP Vercel bisa saja diblokir situs sumber (seperti Kuramanime pada baseline lama). Backend tidak mencoba
  melewatinya: sumber ditandai "blocked" dan cache/fallback yang tersedia dipakai.

---

## 🧭 Aturan arsitektur (wajib diikuti saat menambah fitur)

1. **Data terpisah dari UI.** Hanya `js/api/http.js` yang memanggil `fetch`; modul sumber
   memakai `fetchJSON()`. UI hanya mengimpor dari `js/api/index.js` dan tidak pernah fetch sendiri.
2. **Satu format anime.** Semua sumber diubah lewat `createAnime()` di
   `js/api/normalize.js`. UI hanya mengenal bentuk itu.
3. **Setiap request punya timeout, cache, dan jalur gagal** (fallback / pesan ramah + coba lagi).
4. **Tanpa `onclick` inline.** Pakai `addEventListener` / `delegate()`.
5. **HTML selalu lewat `html```** dari `ui/dom.js` (nilai di-escape otomatis → aman XSS).
   `raw()` hanya untuk markup tepercaya (ikon SVG statis).
6. **Komponen bersama dipasang `initLayout()`**, bukan disalin ke tiap halaman.
7. **Link antar halaman lewat `routes.js`** (`watchUrl()`, `searchUrl()`, `browseUrl()`, `genreUrl()`).
8. **Services tanpa UI.** `auth.js`/`bookmark.js`/`history.js` hanya menyimpan & mengirim event;
   toast/modal diurus `ui/layout.js` / halaman.
9. **Penyedia video hanya di satu tempat.** Pola URL embed ada di `config.STREAMING_SERVERS`
   (atau adapter/penyedia backend: `server/sources/`, `server/providers/`); urutan slot cadangan termasuk
   ReAnime/AniZone diatur di `STREAMING_SERVERS`; `ui/player.js` hanya menerima daftar server jadi dari `js/api/streams.js`.
10. **Backend: satu pintu keluar.** Hanya `server/lib/fetcher.js` yang melakukan request ke situs lain
    (allowlist/redirect, mode robots `enforce|warn|off`, proxy terkonfigurasi, cookies per sumber,
    throttle/concurrency, UA, timeout, retry terbatas).
    Adapter di `server/sources/` hanya mengurai HTML/JSON dan WAJIB mengembalikan `makeAnime()` / `makeEpisode()`.
    BrowserContext stabil/transparan hanya untuk rendering JS yang diminta eksplisit; tidak ada stealth atau solver.
    Challenge tidak diulang dan tidak memicu rotasi proxy/browser. Proxy stream hanya untuk URL bertanda tangan
    + host media di allowlist.
11. **Ikon, bukan emoji, untuk UI.** Pakai `icon('nama')` dari `js/ui/icons.js` (template JS) atau
    `<span class="ic-slot" data-icon="nama"></span>` (HTML statis). Emoji hanya untuk konten pilihan pengguna
    (tema, avatar). Font lewat `var(--font-body)` / `var(--font-display)` — jangan hardcode nama font.

---

## ✅ Checklist fitur lama

### Sudah dipindahkan & berfungsi
**Tahap A**
- [x] 7 tema + efek partikel + tersimpan + **tanpa kedip** saat pindah halaman (+ sinkron antar tab)
- [x] Modal pilih tema
- [x] Navbar: logo, link (smooth scroll di homepage; dari halaman lain → `index.html#section`), Ctrl/⌘+K, Enter → `search.html`
- [x] **Pencarian di mobile ≤480px** (dulu tersembunyi total → sekarang tombol 🔍)
- [x] Footer + kredit pembuat
- [x] Toast (bertumpuk, tidak saling menimpa)
- [x] Kartu anime → **link ke `watch.html`**, skeleton loading
- [x] Modal Masuk/Daftar/Ganti Avatar (UI), profile dropdown
- [x] Platform streaming legal (Bstation, Muse, Ani-One, Vidio)

**Tahap B**
- [x] Login / daftar / logout / ganti avatar (preset & upload foto) — **akun lama tetap bisa login**
- [x] Password disimpan **SHA-256 + salt**; password polos akun lama dikonversi otomatis saat login
- [x] Bookmark: kartu, hero, halaman watch, section "Bookmark Saya", badge jumlah — bookmark lama tetap tampil
- [x] Bookmark saat belum login → modal login, lalu otomatis tersimpan setelah login
- [x] Sinkron antar tab (login, logout, bookmark)
- [x] Homepage data live: hero trending, ongoing, populer, baru rilis (episode yang benar-benar baru tayang), anime Jepang Sub Indo per sumber, dan donghua (backend → AniList CN)
- [x] Rantai fallback AniList → Jikan → Kitsu → data statis, dengan keterangan jujur + tombol "Coba lagi"
- [x] Filter genre (bug variabel GraphQL diperbaiki, Isekai sebagai tag) + "Lihat Semua" per genre
- [x] Dropdown autocomplete 3 sumber (urutan & batas sama: MAL 4, Kitsu 3, AniList 3; tanpa duplikat)
- [x] Halaman pencarian: tab sumber (masing-masing benar), urutan, filter format (gabung dengan tab), muat lebih banyak, filter tersimpan di URL
- [x] "Lihat Semua" → `search.html?browse=ongoing|popular|new|donghua`
- [x] Jadwal rilis **asli dari AniList dalam WIB** (7 hari mulai hari ini, link ke episode), cadangan Jikan (JST→WIB) lalu jadwal statis
- [x] Widget status API (+ tombol cek ulang di footer)
- [x] Login/logout tidak lagi memuat ulang seluruh data

**Tahap C**
- [x] **Satu** player untuk seluruh situs (modal player + streaming page lama digabung)
- [x] Pilihan server + fallback **otomatis** ke server berikutnya (timeout / event error) — di file asli fallback tidak pernah jalan
- [x] Server tanpa id yang dibutuhkan otomatis dilewati (🔒) + toast sama seperti asli
- [x] Daftar episode dari API (episode yang sudah tayang), tab rentang untuk >100 episode, input manual bila tidak diketahui
- [x] ◀ Sebelumnya / ⟳ Server Lain / Berikutnya ▶, ganti episode tanpa reload + URL bisa di-share
- [x] Auto-next via postMessage (bisa dimatikan) + progres tonton di status bar
- [x] Info anime: poster, judul alternatif, sinopsis (Selengkapnya), genre (link ke halaman genre), skor, status, musim, durasi, studio, jadwal episode berikutnya (WIB)
- [x] Bookmark dari halaman nonton (pakai data detail lengkap)
- [x] Rekomendasi asli (AniList → MAL → genre → populer)
- [x] Platform streaming legal + tombol Bstation/YouTube saat streaming tidak tersedia
- [x] Penanda episode yang sudah ditonton
- [x] Bagian download siap menerima data backend (Tahap D); tanpa link palsu
- [x] Mobile: daftar episode langsung di bawah judul (dulu paling bawah halaman)

**Tahap D**
- [x] Backend Node.js + Express: `/api/anime/latest`, `/search?q=`, `/:slug`, `/:slug/episode/:ep` (+ `/api/health`, `/api/bot`)
- [x] Adapter pattern `server/sources/` (animexin, samehadaku, metadata) — satu format anime, menambah sumber tanpa menyentuh frontend
- [x] robots.txt (RFC 9309) + peninjauan ToS per sumber + skrip `check:sources`
- [x] Rate limit keluar (1 req/dtk/host + Crawl-delay) & masuk (60/menit/IP), cache 10–15 mnt + CDN, User-Agent jelas, timeout, retry terbatas, circuit breaker
- [x] Fallback ke API metadata publik (Kitsu → Jikan → AniList) bila scraper gagal
- [x] Section Donghua homepage dari rilis terbaru AnimeXin (kartu → episode terbaru), cadangan AniList CN
- [x] Server streaming & link download per episode dari backend di `watch.html` (Multi Sub diprioritaskan bila tersedia; bahasa lain tetap ditampilkan)
- [x] Player memutar server hasil scraping **lebih dulu** untuk semua anime (pencocokan judul + judul alternatif), MegaPlay jadi cadangan otomatis
- [x] Host embed cadangan diganti `megaplay.buzz` (`animeplay.cfd` suspended) + Vidnest & TryEmbed
- [x] Samehadaku (Sub Indo) menggantikan Kuramanime sebagai sumber anime Jepang (adapter + fixture asli + 8 test)
- [x] Tombol server "Server 1, 2, …" + badge bahasa subtitle, tanpa nama penyedia/database
- [x] Jadwal Rilis live dari Samehadaku + AnimeXin (`/api/anime/schedule`), klik → episode terbaru (`ep=latest`)
- [x] Poster donghua: Kitsu → Bangumi (judul Mandarin) → MangaBaka; section Donghua bisa dari Kitsu tanpa backend; data cadangan bergambar
- [x] Frontend tetap normal di hosting statis tanpa backend (deteksi otomatis, tanpa pesan error)
- [x] Satu project Vercel: frontend CDN + Express sebagai Function (`api/index.js`)

### Belum / di luar cakupan
- [x] Adapter Kuramanime tetap tersedia tetapi nonaktif default; klaim bahasa hanya bila halaman episode menyebutnya, token player tidak di-bypass; Samehadaku tetap sumber anime Jepang default

### Perubahan perilaku kecil (Tahap C)
- Kartu **"Baru Rilis"** (homepage & `search.html?browse=new`) membuka episode yang baru tayang (label "EP 9" → episode 9). Kartu lain tetap episode 1.
- Label episode kartu untuk anime berstatus tidak diketahui kini kosong (dulu "Completed" walau belum tentu tamat).
- Izin iframe `camera`, `microphone`, `display-capture` tidak lagi diberikan ke penyedia embed.
- CSS `.server-buttons` (flex-wrap) dipulihkan — hilang saat migrasi Tahap A sehingga tombol server bertumpuk.

### Perubahan perilaku kecil (Tahap D)
- Section **Donghua** kini dari backend (rilis terbaru AnimeXin) dan kartunya membuka episode terbaru (sama seperti "Baru Rilis"). Bila backend tidak ada/gagal → AniList CN seperti sebelumnya.
- Anime dari backend (URL membawa `slug`): player menunggu server situs sumber dulu, jumlah episode mengikuti daftar episode situs itu (tanpa toleransi +2), dan bila judulnya cocok di AniList/MAL, info & id diambil dari sana tetapi jumlah/status episode tetap dari situs sumber.
- Detail download menampilkan format & bahasa subtitle dari backend (default tetap "MP4 • Sub Indo").
- Pesan "sumber sedang dilewati" kini menyebut penyebab terakhir (mis. 403 → "dibatasi oleh penyedianya").
- `watch.html?slug=...` tanpa judul kini didukung (dulu "Anime tidak ditemukan").

### Perubahan perilaku (perbaikan 22 Okt 2026)
- Semua anime: player menunggu server hasil scraping dulu (maks. 8 dtk), baru server MegaPlay. Sebelumnya hanya anime dari kartu backend.
- URL nonton membawa judul alternatif latin (`&alt=...`) agar pencarian di situs sumber langsung memakai judul romaji. URL lama tanpa `alt` tetap jalan (judul dari detail dipakai mencari ulang).
- Status player menyebut bahasa subtitle server yang diputar (MegaPlay = "Sub English", dulu selalu tertulis "Sub Indo").
- Anime ongoing tanpa nomor episode dari sumber (Kitsu / Jikan saat AniList mati) kini mendapat daftar episode perkiraan mingguan, bukan input manual.

### Perubahan perilaku (perbaikan 22 Okt 2026 — bagian 2)
- Tombol server tampil "Server 1, 2, …" (urutan putar) + badge SUB INDO / SUB ENG; status player "✅ Server 1 | Episode 2 | Sub Indo". Nama MegaPlay/AniList/MAL/situs sumber tidak lagi tampil di tombol, tooltip, maupun pesan menunggu.
- Server cadangan: 4 (MegaPlay ×2, Vidnest, TryEmbed), dulu 2.
- Anime dari situs sumber (slug): episode terbaru = milik situs sumber (dulu nilai terbesar antara situs sumber & metadata, sehingga bisa menunjuk episode yang belum ada subtitle Indonesianya).
- Jadwal Rilis: Samehadaku + AnimeXin dulu (jam rilis Sub Indo), AniList/MAL hanya cadangan. Item donghua tanpa jam tampil "—".
- Section Donghua tanpa backend & tanpa AniList → Kitsu; data cadangan bergambar.
- Endpoint backend bertambah satu: `GET /api/anime/schedule`.

### Perubahan perilaku (perbaikan 22 Okt 2026 — bagian 3, Tahap E)
- Beranda: **Genre** lalu **Jadwal Rilis** tepat di bawah hero; klik genre menampilkan hasil **langsung di bawah
  tombol genre** (dulu memfilter section Populer). Klik genre aktif atau tombol tutup untuk menyembunyikan; tombol
  "Semua" tidak diperlukan lagi. Section Populer selalu berisi anime populer.
- Halaman nonton: server cadangan #2 **MegaPlay-MAL → ReAnime**; tombol baru **AniZone "Multi Sub"** (player video
  bawaan, pilih subtitle lewat tombol CC). Server Sub Indo dari **semua** situs backend yang cocok digabung
  (dulu hanya satu situs); server Sub Eng hasil scraping (hianime.ro) di urutan paling belakang.
- Kartu anime: tombol bookmark di **pojok kanan atas poster, selalu terlihat** (dulu di tengah poster & hanya saat
  hover); label kualitas pindah ke kiri bawah poster. Badge sumber pencarian: titik warna, tanpa emoji.
- Emoji di UI diganti **ikon garis Lucide** yang mengikuti warna tema; status player & toast tanpa emoji (toast
  memakai ikon per jenis). Emoji tema & avatar tetap.
- Font: **Figtree** (teks/UI, sama dengan referensi AniZone) + **Bricolage Grotesque** (judul), menggantikan Poppins.
- **Jikan/MyAnimeList dihapus**: tab & grup saran MAL hilang, pencarian = AniList + Kitsu, fallback metadata
  backend = Kitsu → AniList. Tautan lama `?mal=` tetap dibuka lewat AniList (idMal). Tombol tautan luar "Cari di
  MAL" di hasil kosong tetap ada (hanya link ke situs MyAnimeList, bukan API).
- Donghua: + **Anichin** (Sub Indo, jadwal berjam). Anime Sub Indo: + **Otakudesu** (diblokir Cloudflare dari IP
  pusat data) & **hianime.ro** (Sub English).
- `npm test` diperbaiki untuk Node 22 (`node --test server/test/*.test.js`; dulu argumen folder hanya jalan di Node 20).

### Perubahan perilaku (Tahap F — Subtitle Indonesia AI, 22 Okt 2026)
- Server AniZone "Multi Sub": bila episode **tidak** punya subtitle Indonesia, subtitle Inggris diterjemahkan Gemini saat
  video mulai diputar; track **"Indonesia (AI)"** tampil otomatis dan subtitle bawaan disembunyikan (tetap bisa dipilih
  di menu subtitle player). Episode yang sudah punya subtitle Indonesia tidak berubah. Server iframe tidak terpengaruh.
- Status player menampilkan keadaan terjemahan ("menerjemahkan 1/2", "Indonesia (AI)", "siap di menu subtitle");
  toast saat aktif / gagal (mis. kuota harian habis → subtitle asli tetap dipakai).
- `vercel.json`: `maxDuration` 30 → 60 dtk. Endpoint baru `GET /api/stream/subai`; `/api/stream/servers` membawa `ai`.

### Perubahan perilaku (24 Okt 2026 — permintaan pengguna)
- **Sumber default backend** kini `animexin, anichin, anoboy, hianime, animeku, oploverz`; Samehadaku, Sakunime,
  Otakudesu, dan Kuramanime **dimatikan sebagai default** (adapter tetap ada dan bisa diaktifkan lewat `SCRAPER_SOURCES`).
- **Pencarian di dalam sumber**: kolom cari di tab AnimeKu/Oploverz halaman Jelajah dan di tiap panel Sub Indo beranda
  (`katalog.html?source=…&q=…`), memakai halaman pencarian situs (`?s=`), bukan metadata.
- **Donghua AnimeKu** ditampilkan sebagai bagian sendiri dengan penjelasan bahwa situs tidak punya kategori donghua;
  judulnya dicocokkan dari daftar donghua tayang (AniList CN) lewat pencarian situs.
- **Genre beranda** dari 10 menjadi **18 genre AniList + Isekai** (seluruh genre yang disediakan AniList).
- **Bookmark** pindah ke halaman sendiri (`bookmark.html`, menu profil + footer) dengan pencarian & urutan; section
  bookmark di beranda dan tautannya di daftar navbar dihapus.
- **Efek tema** tidak lagi menembus konten: `.visual-effects` di `z-index: 0`, `.main-content`/`.footer` di `z-index: 1`.
- **Proteksi pop-up player**: iframe embed memakai sandbox tanpa `allow-popups`/`allow-top-navigation`, dengan tombol
  pelepas (tersimpan per browser) bila player menolak diputar.

### Perubahan perilaku (24 Okt 2026 — putaran kedua)
- **Urutan beranda**: **Jadwal Rilis → Jelajahi Genre** langsung di bawah hero; panel **Anime Jepang Sub Indo**
  turun ke bawahnya (tetap sebelum Ongoing/Populer/Baru Rilis/Donghua).
- **Paragraf pengantar panel Sub Indo dihapus** (permintaan pengguna). Yang tersisa hanya baris status
  ringkas (“AnimeKu · Oploverz — 2 situs · 48 judul”) dan panel kartu; ringkasan feed terpisah ikut dihapus.
- **Sort Tahun / Musim / Urutan** di bagian Genre: pilihan tahun 1990–tahun depan, musim Winter/Spring/Summer/Fall,
  serta urutan Terpopuler / Rating Tertinggi / Terbaru. Untuk genre AniList filter dikirim ke
  `season`+`seasonYear`+`sort`; untuk genre situs, Oploverz memakai `season[]` (`fall-2024`) dan AnimeKu
  memakai arsip genrenya (tanpa musim — panel memberi tahu bila filter tahun diminta).
- **Genre AnimeKu**: 23 slug `GENRE_CATALOG` yang diverifikasi 200 + berisi kartu (`/genre/aksi/`), dipakai
  tombol genre di beranda (grup “AnimeKu”) dan pemilih genre di tab AnimeKu halaman Jelajah.
- **Genre Oploverz**: 80 genre + **24 musim** dibaca dari form `/series/`; pemilih **Tahun** & **Musim**
  muncul di halaman Jelajah hanya untuk tab Oploverz.
- **Donghua di kedua situs**: selain “Donghua di AnimeKu”, tab Oploverz kini punya “Donghua di Oploverz”
  dengan cara yang sama (judul donghua tayang dari metadata → dicari di `?s=` situs, hanya kartu yang cocok).
- **Endpoint baru** `GET /api/anime/genres` untuk daftar genre + musim per sumber, dipakai panel genre beranda.
- **Semua genre di beranda**: 19 genre AniList + seluruh genre situs yang belum terwakili (dedupe lewat
  padanan istilah, mis. *aksi* = *Action*), masing-masing mengambil data nyata (AniList untuk genre AniList,
  arsip situs untuk genre situs) — bukan tombol dekoratif.

### Perubahan perilaku (24 Okt 2026 — putaran ketiga: player, subtitle, badge per episode)
- **Sandbox iframe player DEFAULT MATI.** Sejak mode blokir pop-up dinyalakan, banyak embed menolak
  berjalan di dalam sandbox dan hanya menampilkan pesannya sendiri —
  *“Opss! Sandboxed our player is not allowed. Remove sandbox to use it.”* — sehingga area player hitam,
  tanpa video dan tanpa subtitle. Sekarang iframe dimuat **tanpa** `sandbox` secara default, dan tombol di
  bawah player berubah menjadi **“Pop-up diizinkan”**. Mode ketat tetap tersedia (klik → “Pop-up diblokir”,
  disimpan di `localStorage` `kz:popup-guard = 'on'`); host yang terbukti menolak sandbox otomatis
  dikecualikan (`sandboxFor`/`sandboxRefused`) dan iframe ber-sandbox yang gagal dimuat dicoba ulang tanpa
  sandbox untuk server yang sama — bukan langsung “Streaming Tidak Tersedia”.
- **Subtitle di Chrome (iPad & macOS).** Tiga perbaikan: (1) `<track>` default kini juga ditulis sebagai
  atribut `default` dan modenya dipaksa `showing` setelah `loadedmetadata` (Chrome tidak selalu menyalakan
  track yang dipasang dinamis); (2) di WebKit + **ManagedMediaSource** (iPadOS 17.1+) episode yang punya
  subtitle diputar lewat hls.js/MSE karena HLS native WebKit tidak menampilkan `<track>` inline;
  (3) bila hls.js tidak tersedia, pemutar kembali ke HLS native lewat proxy alih-alih menggagalkan server.
- **Badge “Sub Indo” per episode.** Endpoint baru `GET /api/anime/:slug/subtitles` memeriksa **setiap**
  episode pada rentang yang diminta; `js/ui/episode-list.js` menampilkan badge kecil di tombol episode.
  Bukti diambil dari daftar episode situs bila ada (Oploverz menulis “Episode N Subtitle Indonesia”),
  sisanya dari halaman episode (AnimeKu). Episode tanpa bukti **tidak** diberi badge — tidak ada klaim
  Sub Indo tanpa bukti, dan episode yang gagal diperiksa dibiarkan `null`.
- **Batas & biaya:** maks 24 episode per permintaan (frontend `PLAYER.subtitleMapLimit`, backend
  `SUBTITLES.maxEpisodes`), 3 pemeriksaan bersamaan, hasil di-cache 30 menit
  (`CACHE_SUBTITLE_MAP_SEC`). Episode di luar daftar situs tidak diperiksa; episode >24 tetap bisa
  ditonton, badge-nya menyusul saat episode itu dibuka.

### Perubahan perilaku (24 Okt 2026 — putaran keempat: genre situs, Donghua, Sub Indo di ponsel)
- **Genre situs jadi tombol menu.** ±70 chip Oploverz + 6 chip AnimeKu tidak lagi dijajarkan di beranda
  (5 baris). Chip genre AniList tetap terlihat; genre situs dibuka lewat tombol **“Genre situs”**
  (`#genreMenuBtn` → `#genreMenu`) yang berisi grup per situs, **kotak cari** di dalam panel, tombol tutup,
  klik-di-luar, dan `Esc`. Panel bisa dibuka-tutup (`aria-expanded`), jumlah genre tampil di badge, dan
  pemilihan genre langsung menutup panel lalu menampilkan hasil di bawahnya. Pembersihan render tetap
  memakai kunci `[data-site-genres]`.
- **Filter tahun/musim/urutan ikut ke situs.** Tahun & musim diteruskan ke `browse` (Oploverz mendukung
  `season[]`; AnimeKu tidak punya filter itu dan diberi catatan), urutan memakai token Oploverz
  (`order=popular|rating|update`), dan tautan **Lihat Semua** membawa `source+genre+year+season`.
- **Donghua dari AnimeKu & Oploverz di beranda.** Bagian Donghua kini punya panel per situs
  (`#donghuaSites`) yang memanggil `GET /api/anime/browse?source=…&filter=donghua`; grid metadata AniList
  tetap ada di bawahnya sebagai pelengkap, tidak lagi satu-satunya sumber.
  - Bagian Donghua AnimeKu sebelumnya **kosong** di produksi (0 item) karena hanya mengandalkan judul
    metadata yang sedang tayang. Adapter kini membawa **seed** franchise donghua (`DONGHUA_SEEDS`:
    Douluo Dalu, Perfect World, Battle Through the Heavens) yang dikirim registry sebelum judul metadata;
    `Douluo Dalu` sudah dicocokkan dengan hasil pencarian asli situs (7 seri). Kegagalan feed metadata
    tidak lagi membatalkan permintaan dan tidak lagi senyap — masuk ke `errors`.
  - Panel donghua situs dimuat **saat bagiannya mendekati layar** (`whenVisible`) supaya dua permintaan
    katalog tidak berebut jaringan dengan hero/section di awal halaman.
  - **Batas Oploverz (jujur):** situs ini tidak punya kategori donghua dan pencariannya fuzzy
    (kueri “Battle Through the Heavens” dijawab “Kingdom 6th Season”). Bagian Donghua Oploverz bisa kosong;
    UI menjelaskannya dan tidak mengarang judul.
- **Sub Indo di ponsel.** Tidak ada aturan CSS yang menyembunyikan panel (dijaga tes regresi), jadi
  perbaikannya di sisi perilaku:
  - status teks **selalu** terisi saat memuat (`Memuat katalog AnimeKu & Oploverz…`), bukan kotak kosong;
  - tombol **“Muat ulang”** global (`#subIndoRefresh`, ikon berputar saat bekerja) di samping tombol
    “Coba lagi” per panel;
  - **satu percobaan ulang otomatis** saat `timeout`/`network`, dengan status “Jaringan lambat — mencoba
    sekali lagi…”;
  - hasil sukses terakhir disimpan di `localStorage` (`kz:subindo-last`, hanya judul+poster+slug) dan
    dipakai bila feed live gagal — panel tetap terisi dengan label “cache” dan catatan “data tersimpan”.
- **Perbaikan kecil:** filter pencarian Jelajah tidak lagi mengirim `filter=hasil` (id bagian sintetis) ke
  backend; label + tombol muat ulang Sub Indo dibungkus `.subindo-header-actions` agar tidak berdesakan
  di layar kecil.

### Perubahan perilaku (24 Okt 2026 — putaran kelima: auto refresh AnimeKu & Oploverz)
Permintaan pengguna: *"tambahkan auto refresh nya untuk animeloverz dan animeku agar tidak gagal memuat"*.
Empat lapis pengaman, semuanya tanpa menembus pembatasan situs:

1. **Percobaan ulang otomatis** (`js/api/retry.js`, `withAutoRetry`). Panel donghua AnimeKu/Oploverz,
   panel Sub Indo, dan bagian katalog Jelajah mencoba **sekali lagi** (jeda 0,9 dtk) bila gagal karena
   `timeout`, jaringan putus, HTTP 5xx, atau circuit breaker yang baru terbuka. Percobaan kedua memakai
   `refresh: true` supaya circuit breaker 90 dtk tidak langsung menolak. **403, 429, challenge keamanan,
   robots.txt, dan permintaan yang dibatalkan tidak pernah diulang** — itu sama dengan menerobos situs.
2. **Muat ulang otomatis (auto refresh).** Bagian AnimeKu/Oploverz yang gagal, kosong, atau datanya lebih
   tua dari **15 menit** dimuat ulang sendiri saat: koneksi kembali (`online`), tab dibuka lagi
   (`visibilitychange`), atau tiap **5 menit** (`setInterval`). Pemuatannya **quiet**: panel yang sudah
   terisi tidak dikosongkan lebih dulu, hasil baru menggantikan setelah datang.
3. **Jeda bertahap setelah gagal:** 15 dtk → 45 dtk → 2 mnt (maksimum tiga kali), lalu menyerah ke
   penjadwalan 5 menit. Klik **Muat ulang** manual mengembalikan jatah percobaan.
4. **Cadangan lokal** `kz:donghua-last`: hasil sukses terakhir panel Donghua disimpan (judul + poster +
   slug) dan dipakai bila kedua situs benar-benar tidak bisa dihubungi — dengan catatan
   "Menampilkan data tersimpan dari <waktu>", bukan kotak kosong. Panel Sub Indo sudah memakai cara yang
   sama lewat `kz:subindo-last`.

**Tombol “Muat ulang” di bagian Donghua** (`#donghuaRefresh`,`.subindo-refresh`) memakai pola yang sama
dengan Sub Indo: ikon berputar, tombol nonaktif selama bekerja, lalu aktif kembali. Situs yang gagal juga
punya tombol **Coba lagi** di catatan `#donghuaNote`.

**Akar masalah di sisi server juga dipangkas.** Pacing sopan `SCRAPER_MIN_INTERVAL_MS` (1 dtk/permintaan
per host) membuat lima kueri pencarian donghua berurutan memakan ~7–8 dtk — melewati batas waktu klien
(12 dtk) dan terlihat sebagai “gagal memuat”. Sekarang:

- kueri donghua dijalankan **paralel berbatas** (`server/lib/concurrency.js`, `mapLimit`, maks 3) dengan
  urutan hasil yang tetap sama;
- AnimeKu memakai **3 kueri** (tiga seed) alih-alih 5, jadi respons pertama ~3–5 dtk dan sesudah itu
  dilayani cache `browse:donghua:<sumber>`;
- satu kueri gagal tidak lagi menggagalkan permintaan selama kueri lain memberi hasil.

**Batas jujur.** Auto refresh hanya membantu kegagalan **sementara**. Kalau situs mengirim 403/429 atau
halaman berubah struktur, setelah percobaan habis panel tetap menampilkan pesan + “Buka situs”, tanpa
percobaan tanpa henti. Di sandbox pengembangan (tanpa akses keluar ke AnimeKu/Oploverz) jalur ini hanya
diuji dengan respons tiruan (happy-dom) dan uji unit; bukti produksi menyusul setelah deploy.

### Sengaja dihapus (mati / palsu / duplikat)
- Modal player lama `#playerModal` → digabung ke `watch.html` (satu implementasi)
- "Streaming page" di dalam homepage → menjadi `watch.html` (punya URL, bisa di-share, tombol Back browser bekerja)
- Modal YouTube + peta video ID manual + `confirm()` — tidak pernah terpanggil sejak `openPlayer` di-override
- `handleDownload()` palsu ("Download siap! Cek folder downloads" padahal tidak mengunduh apa pun)
- Kontrol player palsu (progress bar statis, tombol kualitas yang hanya memunculkan toast)
- Fungsi mati: `selectEp`, `selectServer`, `fetchStreamingSources`, `_origOpenPlayer`, `toggleHeroBookmark` versi pertama, `updateHeroBookmarkBtn`
- `API_CONFIG.HIANIME / ANICHIN / MULTIEMBED / ANIWATCH_BASE` (tidak pernah dipakai)
- Request uji terpisah untuk status API (diganti status dari request yang dipakai)
- CSS mati: `.daily-badge`, `.hero-particles`, `.particle` + `@keyframes float`, `.player-placeholder`, `.progress-bar/.progress-fill`, CSS modal player
- Script Cloudflare `/cdn-cgi/challenge-platform/...`

---

## 🔎 Catatan sumber data (dicek 21 Okt 2026)

- **AniList** sejak Sept 2026 membalas `403 "temporarily disabled"` untuk request **tanpa header
  `Referer`**, dan memblokir IP **Cloudflare Workers**. Dari browser (http://localhost / domain Vercel)
  aman karena Referer terkirim otomatis. Batas sementara AniList **30 request/menit** — karena itu
  homepage memakai satu query gabungan. Jika suatu saat AniList menolak query gabungan, frontend
  otomatis pindah ke query per-section dan mengingatnya 24 jam.
- **Jikan**: batas ±3 request/detik & 60/menit → request diberi jeda. Pencarian "relevansi" lama
  memakai `order_by=mal_id` (hasilnya anime ber-ID terbaru, bukan yang cocok) → diperbaiki.
- **Kitsu**: `sort=relevance` → `HTTP 400` (pencarian Kitsu lama selalu gagal) → diperbaiki.
  `kitsu.app` menolak **preflight CORS** (`OPTIONS` → 403) yang dipicu header `Content-Type` di file
  asli → request sekarang "simple GET" tanpa header kustom. `page[offset]` saat ini **diabaikan**
  server (halaman 2 = halaman 1), jadi Kitsu hanya dipakai untuk halaman pertama.
- **animexin.dev**: `robots.txt` → `User-agent: * / Disallow:` (semua path diizinkan), ada halaman DMCA &
  Privacy Policy, tidak ada halaman ToS maupun larangan scraping. HTML biasa (tema WordPress "AnimeStream").
  Server episode tersimpan sebagai iframe base64 di `select.mirror`; gambar `/wp-content/uploads`
  membalas 403 + `Cross-Origin-Resource-Policy: same-origin` (tidak bisa ditampilkan di situs lain →
  diganti poster Kitsu). Beberapa slug situs berbeda dari judulnya (mis. `shrounding-the-heavens`) →
  slug selalu diambil dari URL, bukan ditebak dari judul.
- **v20.kuramanime.ing**: Baseline lama membalas Cloudflare 403 ("Sorry, you have been blocked"), bahkan untuk
  `robots.txt` (blokir IP/WAF). Sesuai aturan proyek, adapter **tidak** mem-bypass Cloudflare; gerbang robots
  mengikuti `SCRAPER_ROBOTS_MODE` (default `off` sejak 23 Okt 2026). Pengguna memberi `https://v9.kuramanime.blog/` dan
  `https://v9.kuramanime.work/` sebagai alternatif; belum ada live check. Pilih satu lewat `KURAMANIME_BASE_URL`;
  tidak ada rotasi atau failover antar-domain, terutama setelah blokir.
- **v2.samehadaku.how** (22 Okt 2026): robots.txt `Disallow: /wp-admin/` saja, bot tidak diblokir, server video di
  atribut `data-embed` (HTML publik), poster bisa ditampilkan dari situs lain. Jam di `/jadwal-rilis/` = jam rilis
  Sub Indo (WIB). Pencarian WordPress = semua kata wajib ada.
- **otakudesu.blog** → Cloudflare 403 untuk bot. **kuronime.sbs** → terjangkau, tetapi daftar server dimuat lewat
  loader terenkripsi (tidak dipakai). **hianime.ro** → terjangkau (REST `wp-json/v1/otakuthemes`), subtitle Inggris,
  server = MegaPlay + `tryembed.us.cc` + `vidnest.fun` berbasis id AniList/MAL → dipakai langsung sebagai cadangan.
- **Bangumi** `api.bgm.tv/search/subject/<kata>?type=2` — pencarian bahasa Inggris tidak bisa diverifikasi (nama
  Mandarin), jadi hanya judul Mandarin yang cocok persis yang dipakai. **MangaBaka**: `api.mangabaka.dev` sudah
  pensiun → `api.mangabaka.org/v1`; isinya manga/manhua (cover komik).
- **animeplay.cfd** (host embed server 1 & 2 di file asli, mirror MegaPlay): semua URL → 302 ke `/cgi-sys/suspendedpage.cgi` ("Account Suspended") → diganti **megaplay.buzz** (pola path sama; butuh header Referer; subtitle Inggris). Lihat bagian Halaman nonton.
- **AniList (22 Okt 2026)**: dari server ini API membalas `403 "The AniList API has been temporarily disabled due to severe stability issues"` — pesan yang menurut dokumentasi AniList berarti akses API sedang dihentikan sementara. Frontend otomatis memakai Kitsu (Jikan dihapus 22 Okt 2026); untuk anime ongoing dari Kitsu jumlah episode diperkirakan dari tanggal mulai (tayang mingguan).
- **Kitsu** `include=mappings` memberi id MyAnimeList & AniList (dicek langsung, mis. Frieren → MAL 52991, AniList 154587),
  jadi anime dari hasil Kitsu tetap bisa diputar. Jumlah episode Kitsu untuk anime tayang tidak dapat diandalkan → tidak dipakai.
- 34 dari 35 URL gambar statis di file asli **404** (logo, 25 avatar, 9 gambar hero). Logo + 16 avatar +
  10 gambar hero diganti URL Kitsu yang sudah diverifikasi; 9 avatar lain memakai avatar emoji
  (sama seperti tampilan sebelumnya) sampai diisi URL valid di `js/config.js`. Akun lama yang
  menyimpan URL avatar 404 otomatis memakai gambar terbaru dari config.

- **22 Okt 2026 (bagian 3, diukur dari runner GitHub Actions):**
  - **anichin.moe** — robots.txt Cloudflare-managed (`Allow: /`, Content-Signal `ai-train=no`) + `Disallow: /wp-admin/`.
    Tema AnimeStream: kartu `.listupd article.bs`, `.eplister`, `select.mirror` (iframe base64), `.soraddlx`; jadwal
    `.bixbox.schedulepage.sch_<hari>` dengan `data-cndwn` (relatif waktu render; halaman di-cache ±2 jam). Gambar
    `/wp-content/uploads` 200 tanpa Referer & tanpa CORP. Challenge Cloudflare acak.
  - **otakudesu.blog** — domain resmi (otakudesu.cloud: 523). 403 "Attention Required!" untuk robots/beranda/anime/episode
    dari IP pusat data, termasuk dengan UA browser; pencarian lolos.
  - **hianime.ro** — tanpa challenge. REST: `episode/list/<id post anime>`, `episode/servers?episodeId=<id post episode>`,
    `search/suggestions?keyword=`; `data-hash` server = URL base64.
  - **reanime.to** — SvelteKit; `/api/flix/<id AniList>/<ep>` & `/api/v1/search` publik (tanpa CORS → lewat backend);
    embed `flixcloud.cc/e/<id>?v=1|2` tanpa X-Frame-Options/frame-ancestors. Token video flixcloud terikat IP klien →
    yang dipakai embed-nya (diputar di browser pengguna), bukan URL m3u8.
  - **anizone.to** — Laravel + Livewire + Vidstack; font **Figtree** (referensi tipografi). CDN `*.xin-cdn.xyz`:
    playlist/segmen 200/206 dengan Referer apa pun atau tanpa Referer, `Access-Control-Allow-Origin: https://anizone.to`,
    segmen AES-128, audio Jepang+Inggris terpisah, subtitle ASS/SRT 10–17 bahasa.
  - UA browser palsu di-challenge Cloudflare lebih sering daripada UA bot jujur (ReAnime/AniZone/Anichin).

> ⚖️ **Catatan hukum.** Konten di situs sumber scraping umumnya tidak berlisensi. Menampilkan ulang
> embed/link-nya berisiko hak cipta (dan bisa melanggar ketentuan hosting, termasuk Vercel) —
> pertimbangkan sebelum dipublikasikan, tetap tampilkan platform legal, dan tanggapi permintaan
> penghapusan. robots.txt & ketiadaan ToS bukan izin hak cipta; itu hanya soal etika akses.
> **Proxy video AniZone (22 Okt 2026)** membuat server Kazanime ikut meneruskan berkas video — risikonya lebih
> besar daripada embed (hak cipta, ketentuan & kuota bandwidth hosting). Matikan dengan
> `STREAM_PROVIDERS=reanime` bila diperlukan.
