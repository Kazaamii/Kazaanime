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
| **E** | Perbaikan 22 Okt 2026 (3): **Genre & Jadwal di atas** beranda (hasil genre langsung di bawah tombol); server cadangan #2 → **ReAnime**, + tombol **AniZone "Multi Sub"** (player HLS bawaan + proxy); **tombol bookmark kartu** di pojok poster; **ikon** pengganti emoji; font **Figtree + Bricolage Grotesque**; donghua + **Anichin**; Sub Indo + **Otakudesu** & **hianime.ro**; **Jikan dihapus** | ✅ Selesai — lihat [Batasan Cloudflare](#-batasan-cloudflare-dicek-22-okt-2026) |

---

## 📁 Struktur folder (final)

Tanda: ✅ sudah ada & berfungsi · 🅒 baru/diubah di Tahap C · 🅓 baru/diubah di Tahap D · 🅔 baru/diubah di Tahap E (22 Okt 2026) ·
🅕 baru/diubah di Tahap F — Subtitle Indonesia (AI) (22 Okt 2026)

```
kazanime/
├── index.html                 ✅🅔 homepage: hero, GENRE (+hasil), JADWAL, ongoing, populer, bookmark, baru rilis, donghua
├── watch.html                 ✅🅒 halaman nonton: watch.html?title=...&ep=1&mal=...&anilist=...[&kitsu=][&slug=&src=]
├── search.html                ✅ ?q=... · ?browse=ongoing|popular|new|donghua · ?genre=Action (+ &sort= &format= &source=)
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
│   ├── components.css         ✅ navbar, dropdown, card, skeleton, modal, toast, API status, footer, keterangan section
│   ├── home.css               ✅ hero, genre, jadwal
│   ├── search.css             ✅ tab sumber, filter, muat lagi
│   └── watch.css              ✅🅒 player, server, episode, info, download, platform legal (+ urutan mobile)
├── js/
│   ├── theme-preload.js       ✅ script klasik di <head>: pasang tema sebelum render (anti-kedip)
│   ├── config.js              ✅🅓🅔🅕 konstanta UI + API_CONFIG (backend.enabled: true), CACHE_TTL, SCHEDULE + STREAMING_SERVERS (slot provider ReAnime/AniZone) & PLAYER (hls, aiSubtitle)
│   ├── routes.js              ✅🅒 pembuat/pembaca URL watch & search (filter di URL, batas nomor episode)
│   ├── data/
│   │   └── fallback.js        ✅ data cadangan offline (format ternormalisasi)
│   ├── api/                   ← SATU-SATUNYA tempat request jaringan
│   │   ├── normalize.js       ✅🅒 KONTRAK format Anime (+ field detail) + helper label, isSameAnime, airedEpisodeCount
│   │   ├── http.js            ✅🅓 fetchJSON: timeout, retry, cache Map+sessionStorage, dedupe, throttle, circuit breaker
│   │   ├── anilist.js         ✅🅒 GraphQL (homepage gabungan, search, jadwal) + detail+rekomendasi dalam 1 query
│   │   ├── kitsu.js           ✅🅒 Kitsu (JSON:API, simple GET) + detail dengan mapping id MAL/AniList
│   │   ├── sources.js         ✅🅓🅔🅕 klien backend /api/anime/* + /api/stream/servers + /api/stream/subai (aktif; mati otomatis bila /api tidak ada) + normalisasi server/download
│   │   ├── streams.js         🅒🅓🅔 server streaming per episode (config + slot penyedia + SEMUA situs backend yang cocok), link download
│   │   └── index.js           ✅🅓 FASAD untuk UI: rantai fallback (donghua: backend → AniList CN) + getWatchData
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
│   │   ├── player.js          🅒🅔🅕 SATU player: iframe ATAU video HLS (hls.js / HLS native), mirror, status, tombol server, fallback otomatis, postMessage, subtitle AI
│   │   ├── ai-subtitle.js     🅕 "Subtitle Indonesia (AI)": track AI (TextTrack/VTTCue) per bagian, subtitle bawaan disembunyikan, pilihan pengguna dihormati
│   │   ├── icons.js           🅔 ikon garis Lucide (ISC) pengganti emoji: icon() + hydrateIcons() untuk HTML statis
│   │   ├── episode-list.js    🅒 tombol episode (link asli), tab rentang >100 ep, input manual, penanda ditonton
│   │   └── download-list.js   🅒🅓 daftar link download per kualitas (+ format & bahasa subtitle dari backend)
│   ├── vendor/
│   │   └── hls.min.js         🅔 hls.js 1.7.3 (Apache-2.0, LICENSE-hls.js.txt) — dimuat malas saat server HLS diputar
│   ├── home.js                ✅🅓🅔 homepage (genre → hasil di bawah tombol; kartu donghua backend → episode terbaru)
│   ├── search.js              ✅🅓 pencarian & "Lihat Semua"
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
    │   ├── robots.js          parser & pencocok robots.txt (RFC 9309) + cache
    │   ├── rate-limit.js      throttle per host, circuit breaker, rate limit per IP
    │   ├── cache.js           cache TTL + LRU + dedupe + stale-if-error
    │   ├── anime.js           makeAnime()/makeEpisode(): format SERAGAM untuk frontend
    │   ├── slug.js            slug "sumber~path" (animexin~soul-land-2…)
    │   ├── text.js            helper urai teks (episode, status, format, URL, judul)
    │   └── errors.js          error bertipe → status HTTP & pesan ramah
    ├── sources/
    │   ├── index.js           registry + aggregator + fallback (menambah sumber = 1 file + 1 baris)
    │   ├── animexin.js        adapter AnimeXin — donghua (diverifikasi live) + jadwal rilis
    │   ├── samehadaku.js      adapter Samehadaku — anime Jepang Hardsub Indonesia (diverifikasi live) + jadwal rilis
    │   ├── anichin.js         🅔 adapter Anichin — donghua Sub Indo (tema AnimeStream, parser bersama AnimeXin) + jadwal berjam
    │   ├── otakudesu.js       🅔 adapter Otakudesu — anime Jepang Hardsub Indonesia (diblokir Cloudflare untuk IP pusat data, lihat batasan)
    │   ├── kuramanime.js      adapter Kuramanime (Hardsub Indonesia) opt-in; nonaktif default, robots wajib eksplisit, token player tidak di-bypass
    │   ├── hianime.js         🅔 adapter hianime.ro — anime Jepang, subtitle Inggris (REST otakuthemes)
    │   └── metadata.js        fallback API publik Kitsu → AniList (Jikan dihapus) + poster Kitsu → Bangumi → MangaBaka
    ├── providers/             🅔 penyedia server berbasis id/judul (bukan katalog)
    │   ├── index.js           registry + cache + status per penyedia
    │   ├── reanime.js         ReAnime: /api/flix/<id AniList>/<ep> → embed flixcloud (Sub English)
    │   ├── anizone.js         AniZone: pencarian → halaman episode → HLS + subtitle multi-bahasa
    │   └── match.js           pencocokan judul (2nd Season = Season 2 = II)
    ├── scripts/
    │   └── check-sources.js   `npm run check:sources [-- --live]`: laporan robots/ToS/kesehatan sumber
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

Satu server melayani halaman (`index.html`, `watch.html`, `search.html`, `css/`, `js/`) **dan** `/api/*`.
Tidak ada API key; semua env var opsional (lihat `.env.example`).

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
- `/` → section **Donghua** berisi rilis terbaru AnimeXin (via backend); klik kartu → episode terbaru langsung diputar dari server AnimeXin (Sub Indo didahulukan) + link download
- `/api/anime/latest` · `/api/anime/search?q=soul%20land` · `/api/anime/animexin~soul-land-2-the-peerless-tang-clan` · `/api/anime/animexin~soul-land-2-the-peerless-tang-clan/episode/175`
- `/api/health` (status sumber, robots, circuit, cache) · `/api/bot` (info bot untuk admin situs sumber)
- `npm run check:sources -- --live` → laporan robots.txt/ToS + uji ambil data tiap sumber
- `npm test` → 88 unit test backend (tanpa internet)

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

## 🎬 Halaman nonton (Tahap C)

Satu implementasi player (`ui/player.js`) menggantikan **dua** salinan di file asli
(modal `#playerModal` + "streaming page" yang saling override).

```
watch.html?title=...&ep=3&anilist=...&mal=...[&alt=judul romaji]
   │  1. cari episode di SEMUA situs backend (Samehadaku, Otakudesu, AnimeXin, Anichin, hianime.ro) lewat judul,
   │     judul alternatif & judul tanpa season → server Sub Indo diputar DULU
   │  2. paralel: GET /api/stream/servers → ReAnime (embed) + AniZone (HLS "Multi Sub") untuk episode itu
   │  3. tidak ada / gagal / > PLAYER.scrapeWaitMs (8 dtk) → server cadangan sesuai urutan config
   │     (MegaPlay, ReAnime, AniZone Multi Sub, Vidnest, TryEmbed), lalu server Sub Eng hasil scraping
   ▼
getWatchData()  AniList by id/idMal ── 1 request: detail + episode berikutnya + rekomendasi
                 └ gagal → Kitsu by id (mapping id MAL/AniList) → AniList lagi lewat id hasil mapping
                 └ hanya judul → pencarian AniList → Kitsu  ("S2" → "Season 2")
                 └ semua gagal → data dari URL / data cadangan + keterangan & "Coba lagi"
```

| Fitur | Detail |
|---|---|
| Server | Hasil scraping backend dulu (`PLAYER.serverOrder = 'scrape-first'`), lalu `STREAMING_SERVERS` di `js/config.js` sebagai cadangan (urutan = urutan fallback). Tombol tampil **"Server 1, 2, …"** + badge bahasa subtitle (SUB INDO / SUB ENG / MULTI SUB) — nama penyedia/situs tidak ditampilkan. Server yang belum tersedia tampil dengan ikon gembok dan dilewati; slot ReAnime/AniZone yang masih dicari tampil "mencari…" |
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
| 1 | **Samehadaku** · **Otakudesu** (backend) | anime Jepang — server per episode + link download | Hardsub Indonesia |
| 1 | **AnimeXin** · **Anichin** (backend) | donghua — ±11–16 server per episode (OK.ru, Dailymotion, Rumble, Odysee, …) + link download | Indonesia (AnimeXin juga Inggris; label Hardsub/Softsub AnimeXin ditampilkan bila dicantumkan sumber) |
| 2 | **MegaPlay** `megaplay.buzz` (cadangan #1, via id AniList) | hampir semua anime Jepang | Inggris |
| 3 | **ReAnime** (cadangan #2 — **menggantikan MegaPlay-MAL**) | embed `flixcloud.cc` dari API publik `reanime.to/api/flix/<id AniList>/<ep>`; mirror HD-2 → HD-1 dicoba otomatis | Inggris |
| 4 | **AniZone — Multi Sub** (tombol baru) | HLS di player bawaan + 10–16 pilihan subtitle (Indonesia dipilih otomatis bila ada); audio Jepang/Inggris. Chrome/Firefox/Edge/Android: hls.js lewat proxy `/api/stream/hls` (CDN mengunci CORS & key AES ke anizone.to); Safari/iOS: HLS native langsung dari CDN | Banyak bahasa |
| 5 | **Vidnest** · **TryEmbed** (cadangan, via id AniList) | pustaka HiAnime yang sama | Inggris |
| 6 | **hianime.ro** (backend) | server "Fast" (player blogger hianime.ro) & "mega" (megaplay.su) — embed berbasis id yang sudah ada di atas tidak diulang | Inggris |

Nomor "Server N" mengikuti urutan putar. Bila anime ada di situs Sub Indo, tombol cadangan bergeser ke belakang
(mis. Server 1–4 Samehadaku, lalu Server 5 MegaPlay, Server 6 ReAnime, Server 7 AniZone Multi Sub, …).

Contoh nyata (22 Okt 2026): *The Apothecary Diaries Season 3* ep 2 → dicocokkan ke Samehadaku "Kusuriya no
Hitorigoto Season 3" dalam ±1 dtk → **Server 1–4 Sub Indo** (Samehadaku) lalu **Server 5–8 Sub Eng** (cadangan).

- **Pencocokan judul.** Anime yang dibuka dari kartu AniList/MAL/Kitsu tidak punya slug situs sumber, jadi
  `js/api/streams.js` mencarinya di `/api/anime/search` dengan judul utama **dan** judul alternatif (romaji —
  ikut di URL sebagai `alt`). Cocok bila judulnya sama persis, atau sama setelah penulisan season disamakan
  ("3rd Season" = "Season 3" = "S3"; format AnimeXin "Pinyin [English]" dipecah). Nomor season harus sama,
  jadi season lain tidak ikut tercocokkan. Hasil API metadata (saat semua scraper gagal) tidak dipakai.
- **Menunggu.** Selama mencari, player menampilkan "Mencari server Sub Indo untuk Episode N..."
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
      │   detail/episode: dirutekan lewat prefix slug               ├──────────────→ metadata.js
      ▼                                                             │                (Kitsu → AniList)
animexin · samehadaku · anichin · otakudesu · hianime · kuramanime (opt-in) ── makeAnime()/makeEpisode() → format SERAGAM
      │
server/lib/fetcher.js  ── allowlist + validasi redirect → circuit breaker → robots.txt → throttle/concurrency
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
| `GET /api/anime/search?q=` | daftar anime (2–100 karakter) |
| `GET /api/anime/schedule` | **(baru, 22 Okt 2026)** `{ timezone: "Asia/Jakarta", days: { 0..6: [{ title, time, slug, source, url, image, country }] } }` — 0 = Minggu; `time` = jam rilis WIB atau `null` (donghua). Didaftarkan **sebelum** `/:slug` |
| `GET /api/anime/:slug` | satu anime + `episodeList: [{ number, title, released, url }]` |
| `GET /api/anime/:slug/episode/:ep` | `{ episode, title, released, url, servers: [{ name, url, lang }], downloads: [{ quality, size, format, subtitle, links: [{ provider, url }] }] }` |
| `GET /api/stream/servers?ep=&anilist=&title=&title=&year=` | **(baru, 22 Okt 2026)** `{ episode, servers: [{ provider, kind: 'embed', name, label, lang, url } \| { provider, kind: 'hls', name, lang: 'multi', url: '/api/stream/hls?…', direct, poster, subtitles: [{ label, lang, default, url: '/api/stream/sub?…' }], ai: { url: '/api/stream/subai?…', from, sourceLabel, label } \| null }], status: { reanime, anizone } }` — status: `ok` / `not_found` / `blocked` / `error` / `stale`. `ai` (Tahap F) hanya ada bila episode **tidak** punya subtitle Indonesia dan `GEMINI_API_KEY` diisi |
| `GET /api/stream/hls?u=&s=` | proxy HLS AniZone (hanya URL bertanda tangan dari `/servers`): m3u8 ditulis ulang, segmen/key apa adanya |
| `GET /api/stream/sub?u=&f=&s=` | subtitle AniZone (ASS/SRT) dikonversi ke WebVTT untuk `<track>` |
| `GET /api/stream/subai?u=&f=&l=&v=&s=&p=` | **(Tahap F)** `{ part, parts, ranges: [[mulai, akhir]…], lang: 'id', label: 'Indonesia (AI)', model, untranslated, cues: [[mulai, akhir, teks, pengaturan]…] }` — hanya URL bertanda tangan dari `ai.url`; parameter lain ditolak. Error: `503 AI_DISABLED` / `AI_QUOTA` (+ `Retry-After`) / `AI_CONFIG`, `504 AI_TIMEOUT`, `502 AI_UPSTREAM` / `AI_BAD_OUTPUT` / `AI_BLOCKED`, `409 AI_STALE` |
| `GET /api/health` | status backend, User-Agent, TTL/cache, robots/circuit, concurrency, status proxy (tanpa host/kredensial), ringkasan cookie (tanpa nilai), status browser & `aiSubtitles` (key tidak ditampilkan) |
| `GET /api/bot` | penjelasan bot + cara menolak lewat robots.txt (tercantum di User-Agent) |

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
| robots.txt | RFC 9309: grup `KazanimeBot` (atau `*`), kecocokan terpanjang, `*` & `$`, `Crawl-delay`. 4xx = boleh, 5xx/jaringan = dilarang sementara, halaman blokir Cloudflare = **blocked**. Di-cache 6 jam |
| ToS | Hasil peninjauan per sumber di `POLICY.tos` adapter (`allowed` / `unknown` / `forbidden`). `forbidden` → adapter tidak pernah dipanggil. `unknown` → hanya diakses bila robots.txt **terbaca dan mengizinkan** |
| User-Agent | `KazanimeBot/1.0 (+https://<domain>/api/bot; <BOT_CONTACT>)` yang deskriptif; tidak meniru browser. Opsi `headers` hanya untuk kebutuhan protokol terdokumentasi (mis. Origin/Referer media), bukan fingerprint spoofing |
| Rate limit keluar | maks 1 request/detik per host (Crawl-delay bisa memperbesar), antrean > 6 dtk ditolak |
| Rate limit masuk | 60 request/menit per IP untuk `/api/anime/*` (header `RateLimit-*`) |
| Cache | memori per instance: latest 10 mnt, search/detail/episode 15 mnt, dedupe request identik, stale-if-error 1 jam; CDN Vercel `s-maxage` |
| Timeout & retry | 6 dtk per request; retry exponential-backoff terbatas hanya untuk error jaringan & 5xx; timeout tidak diulang. 403/429/CAPTCHA/challenge langsung berhenti; 429 memakai `Retry-After` terbatas dan circuit/cooldown |
| Circuit breaker | 2 gagal beruntun → sumber diistirahatkan 60 dtk; semua 403/challenge membuka cooldown tanpa retry; 429 dihentikan dengan cooldown dari `Retry-After` yang dibatasi |
| Anti-SSRF | hanya host allowlist (+ sufiks CDN media AniZone `xin-cdn.xyz`); setiap redirect divalidasi sebelum diikuti, redirect robots harus tetap satu origin, header rahasia/cookie tidak diteruskan lintas origin; respons > 3 MB ditolak (segmen maks 40 MB) |
| Proteksi bot | Profil BrowserContext stabil/transparan dengan User-Agent bot; tidak ada stealth/solver. Cookie/proxy hanya untuk request normal sesuai konfigurasi sumber/operator. Challenge tidak memicu retry, rotasi proxy, refresh cookie, atau fallback Playwright; circuit dibuka dan fallback dipakai. Proxy media tetap bertanda tangan + allowlist host |
| Gemini (subtitle AI) | API resmi ber-key (header `x-goog-api-key`, bukan di URL); robots.txt tidak berlaku. Hanya subtitle yang ditawarkan `/servers` (URL bertanda tangan) yang bisa diterjemahkan → key tidak bisa dipakai pihak lain sebagai penerjemah gratis. Rate limit 20/menit/IP untuk request yang lolos cache CDN |
| Proxy stream | `/api/stream/hls` hanya meneruskan URL yang ditandatangani server ini (HMAC, `STREAM_SECRET`) dan host media di allowlist → bukan open proxy. Rate limit terpisah 900/menit/IP. **Memakai bandwidth Vercel** (±300–700 MB per episode 720p di Chrome/Firefox; Safari/iOS memutar langsung dari CDN) |
| Gambar | poster animexin dilindungi hotlink (403 + `Cross-Origin-Resource-Policy: same-origin`) → diganti poster **Kitsu** → **Bangumi** (judul Mandarin) → **MangaBaka**, hanya bila judul cocok persis (maks 2,5 dtk; sisanya dicari di belakang & respons diberi cache CDN 60 dtk). Poster Samehadaku boleh ditampilkan langsung. Tidak ada proxy gambar |

`npm run check:sources` mencetak laporan ini untuk setiap sumber (tambahkan `-- --live` untuk uji ambil data).

### Status sumber (dicek 21–22 Okt 2026)

| Sumber | Status | Catatan |
|---|---|---|
| **AnimeXin** | ✅ aktif, diverifikasi live | robots.txt mengizinkan semua; tidak ada ToS (DMCA & Privacy Policy tanpa larangan bot). Latest = beranda + `/anime/?order=update` (2 request, slug asli digabung lewat ID seri). 16 server per episode (Dailymotion, OK.ru, Odysee, Rumble, Mega, …) + link download Sub Indo/English |
| **Samehadaku** | 🟡 adapter & fixture teruji; baseline terbaru homepage di-challenge | robots.txt hanya melarang `/wp-admin/`; ToS tidak tertaut → `unknown` (konten hanya diakses bila robots.txt terbaca & mengizinkan). Adapter menyediakan anime terbaru, pencarian, detail, server Hardsub Indonesia, unduhan, dan jadwal; bila challenge, cooldown 30 mnt dan fallback dipakai |
| **Anichin** | 🟡 aktif, parser diverifikasi dgn HTML asli | (22 Okt 2026) robots.txt mengizinkan (kecuali /wp-admin/); tema AnimeStream (parser AnimeXin). Dari IP pusat data: request kadang lolos, kadang challenge Cloudflare (beranda & halaman episode paling sering) |
| **hianime.ro** | ✅ aktif, diverifikasi live | (22 Okt 2026) robots.txt hanya melarang /wp-admin/; tanpa Cloudflare challenge. Recently Updated, pencarian, detail, daftar episode & server lewat REST `wp-json/v1/otakuthemes` — server "Fast" & "mega" (Sub English) |
| **Otakudesu** | 🔴 adapter ada, diblokir | (22 Okt 2026) domain resmi `otakudesu.blog`: robots.txt, beranda, halaman anime/episode → 403 "Attention Required! \| Cloudflare" untuk IP pusat data; hanya pencarian yang lolos. Adapter mengklasifikasikan server Sub Indo sebagai Hardsub sesuai konfirmasi pemilik proyek; sumber tetap ditandai *blocked*, tanpa data palsu. Gunakan hanya bila pemilik sumber memberi akses/allowlist, selain itu fallback dipakai |
| **ReAnime** (penyedia stream) | 🟡 parser diverifikasi dgn JSON asli | (22 Okt 2026) robots.txt mengizinkan semua; `/api/flix/<id AniList>/<ep>` publik. Dari IP pusat data sering di-challenge Cloudflare |
| **AniZone** (penyedia stream) | 🟡 parser & proxy diverifikasi dgn data asli | (22 Okt 2026) robots.txt mengizinkan semua. Halaman episode → HLS + 17 subtitle (termasuk Indonesia). CDN video 200/206 tanpa Referer; halaman & berkas subtitle sering di-challenge dari IP pusat data |
| **Kuramanime** | ⚪ opt-in, nonaktif default | Stream player diklasifikasikan Hardsub Indonesia; grup unduhan tetap membedakan Hardsub/Softsub. Baseline sebelumnya: Cloudflare 403 termasuk `robots.txt`; adapter hanya aktif bila ditambahkan ke `SCRAPER_SOURCES` dan robots mengizinkan. Token player tidak dipecahkan |
| Bangumi · MangaBaka | ✅ poster pengganti | `api.bgm.tv` (robots hanya melarang /pic/ /img/ /js/) & `api.mangabaka.org/v1` (robots mengizinkan /v1/) |
| Kitsu | ✅ fallback utama | bisa dijangkau server; mapping id MAL/AniList; poster pengganti |
| AniList | ⚠️ fallback berikutnya | dari sandbox: AniList 403 "temporarily disabled" (juga dengan Referer) — di Vercel bisa berbeda; circuit breaker membuatnya cepat dilewati |
| ~~Jikan~~ | ❌ dihapus | 22 Okt 2026 atas permintaan pemilik proyek (frontend & backend) |

### Environment variable (semua opsional)
Lihat `.env.example`. Yang paling berguna: `BOT_CONTACT` (email/URL kontak di User-Agent),
`SCRAPER_SOURCES` (urutan/aktifkan sumber, default `animexin,samehadaku,anichin,otakudesu,hianime`; `kuramanime` opt-in),
`SAMEHADAKU_BASE_URL` / `ANICHIN_BASE_URL` / `OTAKUDESU_BASE_URL` / `KURAMANIME_BASE_URL` / `HIANIME_BASE_URL` (domain sering berganti),
`CACHE_*_SEC` (termasuk `CACHE_SCHEDULE_SEC`), `RATE_LIMIT_PER_MIN`, `METADATA_ORDER`, `METADATA_POSTER_SOURCES`.
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
2. Daftarkan di `FACTORIES` (`server/sources/index.js`) + base URL di `server/config.js`.
3. Tambahkan nama ke `SCRAPER_SOURCES`. **Frontend tidak perlu diubah sama sekali.**

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
satu GET `/` hanya jika robots.txt terbaca dan mengizinkan (termasuk `Crawl-delay`). Redirect tidak diikuti; tidak ada
fingerprint browser, cookie, proxy, retry, atau solver challenge. Hasilnya hanya menunjukkan akses biasa saat pemeriksaan,
bukan izin penggunaan konten atau cara untuk melewati proteksi.

Baseline terbaru (22 Okt 2026, 12:16 UTC; suffix `cf-ray` SJC): kedua `robots.txt` membalas 200, tetapi homepage AniZone
dan Samehadaku membalas 403 Cloudflare challenge. Cek ini hanya meminta `/`; endpoint katalog/episode tidak diuji.

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
    (allowlist/redirect, robots, proxy terkonfigurasi, cookies per sumber, throttle/concurrency, UA, timeout, retry terbatas).
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
- [x] Homepage data live: hero trending, ongoing, populer, baru rilis (episode yang benar-benar baru tayang), donghua (AniList CN)
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
- [x] Server streaming & link download per episode dari backend di `watch.html` (Sub Indo didahulukan)
- [x] Player memutar server hasil scraping **lebih dulu** untuk semua anime (pencocokan judul + judul alternatif), MegaPlay jadi cadangan otomatis
- [x] Host embed cadangan diganti `megaplay.buzz` (`animeplay.cfd` suspended) + Vidnest & TryEmbed
- [x] Samehadaku (Sub Indo) menggantikan Kuramanime sebagai sumber anime Jepang (adapter + fixture asli + 8 test)
- [x] Tombol server "Server 1, 2, …" + badge bahasa subtitle, tanpa nama penyedia/database
- [x] Jadwal Rilis live dari Samehadaku + AnimeXin (`/api/anime/schedule`), klik → episode terbaru (`ep=latest`)
- [x] Poster donghua: Kitsu → Bangumi (judul Mandarin) → MangaBaka; section Donghua bisa dari Kitsu tanpa backend; data cadangan bergambar
- [x] Frontend tetap normal di hosting statis tanpa backend (deteksi otomatis, tanpa pesan error)
- [x] Satu project Vercel: frontend CDN + Express sebagai Function (`api/index.js`)

### Belum / di luar cakupan
- [x] Adapter Kuramanime tetap tersedia tetapi nonaktif default; `requireExplicitRobots` wajib, token player tidak di-bypass; Samehadaku tetap sumber anime Jepang default

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
- **v20.kuramanime.ing**: Cloudflare memblokir bot ini ("Sorry, you have been blocked"), bahkan untuk
  `robots.txt` dan juga saat diuji dengan User-Agent browser (blokir IP/WAF). Sesuai aturan proyek
  (hormati robots/ToS, UA jelas), adapter **tidak** akan mem-bypass Cloudflare; sumber ditandai
  "blocked" (istirahat 30 menit) dan otomatis jatuh ke sumber lain / metadata.
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
