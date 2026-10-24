# Anime X Nonton — sumber API dari APK Miku Moe 3.6

Status: **adapter terpasang, default `off`** — `server/sources/animexnonton.js`
Sumber: `https://api.wincamp.web.id/animexnonton` (atur lewat `ANX_BASE_URL`)
APK asal: `64bit.Miku Moe_3.6_R27_v2.apk` (`miku.moe.app`) — paket `Sumber APK.zip`
Terakhir diperiksa: **24 Oktober 2026**

Dokumen ini melanjutkan `docs/OPLOVERZ.md`: setelah peta Oploverz selesai, pertanyaannya
bergeser ke **sumber anime apa yang benar-benar dipakai APK itu**, dan mana yang bisa
diterapkan ke Kazanime.

---

## 1. Tiga sumber anime di APK — dan hanya satu yang mungkin

| # | Sumber | Endpoint di APK | Kondisi live 24 Okt 2026 | Keputusan |
|---|---|---|---|---|
| 1 | **Anime X Nonton** | `POST https://api.wincamp.web.id/animexnonton/new_api/*` (19 path, tanda tangan AnxGuard) | `GET get_config/` → **403 nginx**; root → 404 | **Diterapkan**, mode `capture` (default `off`) |
| 2 | **Animeku** | `GET https://apps.animekita.org/api/v1.2.5/*` (7 endpoint, tanpa tanda tangan) | **403 Apache** (http & https); root `apps.animekita.org` = halaman deface, `animekita.org` = "HALO DUNIA!" | **Tidak** — mati, dan datanya sudah tercakup adapter `animeku` (HTML `ww2.animeku.lol`) |
| 3 | **Pencarinafkah** | `GET https://pencarinafkah.xyz/vA6//api` (api_key tertanam) | `200` tapi **0 byte** di semua endpoint | **Tidak** — endpoint kosong |

`Crotpedia` juga disebut di string APK, tetapi itu situs **komik dewasa** (bukan anime) —
sudah dicek, tidak relevan untuk Kazanime.

Kesimpulan: satu-satunya kandidat nyata adalah **Anime X Nonton**, dan itu pun tidak bisa
dipanggil langsung (lihat §4).

---

## 2. Bentuk API (dibaca dari APK, bukan tebakan)

Base: `https://api.wincamp.web.id/animexnonton`
Metode: `POST` form-urlencoded. Respons JSON:

```json
{ "status": "success", "count": 30, "countTotal": 1200, "pages": 40,
  "posts": [ { "cid": 1001, "channelName": "...", "imgUrl": "...", "genre": "Action, Fantasy",
               "rating": "8.7", "years": "1999", "ongoing": 1, "countAnime": "1122", "...": "..." } ],
  "categories": [] }
```

Field `ApiAnimePost` berjumlah **26**; yang dipakai adapter:
`cid`/`categoryId`/`channelId` (id stabil → slug), `channelName`, `imgUrl`/`channelImage`,
`genre`, `rating` (string, koma desimal dinormalisasi), `years`, `ongoing` (1/0),
`countAnime` (jumlah episode), `channelType` (TV/Movie).

### Endpoint yang diketahui (19 path `new_api/`)

| Endpoint | Field | Dipakai adapter |
|---|---|---|
| `get_posts/` | `page`, `count`, `isAPKvalid` | ✅ `latest()` |
| `search_category_collection/` | `isAPKvalid`, `search`, `page`, `count`, `lang` | ✅ `search()` |
| `get_anime_genre_list/` | `isAPKvalid` | ✅ `genres()` |
| `get_category_ongoing/` · `get_category_not_ongoing/` | `page`, `count`, `lang`, `isAPKvalid` | — (belum ada kontrak respons yang aman) |
| `get_anime_by_genre/` | `+ genre1`, `genre2`, `sort` | — |
| `get_post_description/` | `channel_id`, `category_id`, `gone` | — (detail hanya dari snapshot) |
| `get_current_next_previous/`, `user_rating/`, `update_view/`, `count_views/`, `user_count/`, `home_info/`, `integrity_verify/`, `register_user/`, `device_status/`, `access_challenge/`, `get_category_posts_secure/`, `get_config/` | — | — |

---

## 3. Protokol AnxGuard — apa yang terbukti, apa yang tidak

`server/lib/anx-signer.js` mengimplementasikan bagian yang **terbukti** dari
`libmikumoe.so`:

| Bagian | Status | Nilai / bukti |
|---|---|---|
| `h91b(label, key, salt)` | ✅ | HKDF-HMAC-SHA256 dua langkah: `prk = HMAC(key, "anx-guard-v1-salt")`, `okm = HMAC(prk, label)`; label `master` & `sig` |
| `MASTER_HEX` | ✅ | `0f4be99c888e987925fad6650daae56e5fc002ee1286a6c24fead72f29365862` |
| Body | ✅ | AES-256-GCM, `AAD = "anx-req|<ts>"`, dikirim sebagai `anx=<base64>` |
| Header wajib | ✅ | `X-Anx-Ts`, `X-Anx-N` (nonce), `X-Anx-Ver: 25`, `X-Anx-Cert`, `X-Anx-Rsp`, `X-Anx-Sig` |
| `X-Anx-Cert` | ✅ | 16 hex pertama SHA-256 sertifikat APK. APK mengambilnya dari `pastebin.com/raw/Lfy0gjdU`; adapter **tidak** melakukan request ke host lain — nilai diambil dari `ANX_CERT` atau konstanta build (`1a70a8a890d82093`, build asli) |
| `X-Anx-Sig` | ✅ | `hex(HMAC-SHA256(kunci "sig", string kanonik))`, kanonik memuat literal `"\n25\n"` |
| **Urutan & pemisah string kanonik** | ❌ | komponennya terbaca (method, path, hash body, ts, nonce), urutannya tidak |
| **Konstruksi IV AES-GCM** | ❌ | 12 byte acak? potongan nonce? turunan `h91b`? tidak terbaca |

Karena dua hal terakhir, mode `live` **menolak jalan** sampai `ANX_CANONICAL_TEMPLATE` diisi.
Tidak ada tebakan yang dikirim ke server orang lain, dan **tidak ada request ke host ketiga**:
satu-satunya jalan keluar tetap `client.request()` milik repo (allowlist `api.wincamp.web.id`).

---

## 4. Tiga mode adapter

| Mode | Perilaku | Syarat |
|---|---|---|
| `off` (**default**) | factory mengembalikan `null` → adapter **tidak terdaftar**. `/api/health`, pencarian, dan `?source=animexnonton` persis seperti sebelum fitur ini ada | — |
| `capture` | membaca snapshot JSON hasil tangkapan perangkat sendiri; `latest`, `search`, `genres`, `getAnime`, `getEpisode` bekerja penuh dari snapshot | `ANX_MODE=capture` + `ANX_CAPTURE_FILE=…` + id di `SCRAPER_SOURCES` |
| `live` | memanggil API langsung untuk daftar/pencarian/genre; detail & episode tetap butuh snapshot | `ANX_CANONICAL_TEMPLATE` + akses jaringan dari server |

Mode tak dikenal (mis. `ANX_MODE=on`) diperlakukan sebagai `off` — fail closed, dengan
peringatan di log.

**Contoh mengaktifkan (capture):**

```bash
export SCRAPER_SOURCES=animexin,anoboy,hianime,animeku,oploverz,animexnonton
export ANX_MODE=capture
export ANX_CAPTURE_FILE=./data/anx-capture.json
npm start
```

---

## 5. Bentuk snapshot (`ANX_CAPTURE_FILE`)

```json
{
  "capturedAt": "2026-10-24T13:00:00Z",
  "source": "animexnonton",
  "posts": [ { "...": "ApiAnimePost apa adanya (26 field)" } ],
  "genres": ["Action", "Adventure", "Fantasy"],
  "episodes": {
    "1001": [
      { "number": 1, "title": "Judul episode 1", "released": "1999-10-20",
        "url": "",
        "servers": [ { "name": "Server 1", "url": "https://…", "kind": "hls", "lang": "id" } ] }
    ]
  }
}
```

* `posts` boleh ditempel apa adanya dari respons API — `toAnime()` memetakan field-nya.
* `episodes` di-key dengan `cid` yang sama seperti di `posts`.
* `servers[].kind` hanya `"hls"` atau kosong (embed biasa); URL harus absolut & publik.
* Contoh ada di `server/test/fixtures/animexnonton.capture.json` — **semua judul diawali
  `CONTOH`** supaya tidak tertukar dengan data asli.

### Cara menangkap dari HP sendiri (tanpa root)

`res/xml/network_security_config.xml` aplikasi mempercayai **CA pengguna**, jadi:

```bash
# PC
pip install mitmproxy
mitmdump -p 8080                      # atau dengan addon pencatat milik Anda

# HP (sekali saja)
#   Setelan → Keamanan → Enkripsi & kredensial → Pasang sertifikat → Sertifikat CA
#   Wi-Fi → Proxy → Manual → IP PC : 8080

# Buka aplikasi → jelajahi beranda, cari, dan halaman episode
#   → rangkai request/response menjadi bentuk snapshot di atas
```

Penyadapan hanya untuk perangkat & akun Anda sendiri; jangan menyebarkan hasil tangkapan.

---

## 6. Perilaku di Kazanime

| Method adapter | Rute | Mode capture | Mode live |
|---|---|---|---|
| `latest()` | `GET /api/anime/latest` (ikut agregasi) | semua `posts` snapshot | `new_api/get_posts/` |
| `search(q)` | `GET /api/anime/search?q=` | filter judul di snapshot | `new_api/search_category_collection/` |
| `genres()` | `GET /api/anime/genres` | daftar genre snapshot | `new_api/get_anime_genre_list/` |
| `getAnime(ref)` | `GET /api/anime/animexnonton~<cid>` | ✅ snapshot | ❌ butuh snapshot |
| `getEpisode(ref, n)` | `…/episode/<n>` | ✅ snapshot | ❌ butuh snapshot |
| `browse()` | `GET /api/anime/browse?source=animexnonton` | ❌ `supportsBrowse: false` | ❌ |

Slug selalu berprefix `animexnonton~` (mis. `animexnonton~1001`). Badge kartu:
**“Anime X Nonton”** (`js/ui/card.js`).

---

## 7. Batas yang tidak bisa ditutup

1. **API tertutup** — nginx 403 untuk `GET` dan untuk request tanpa tanda tangan; PHP menjawab
   `{"status":"error","message":"app only"}` untuk tanda tangan yang salah. Tidak ada bypass
   (tanpa headless/stealth, solver, proxy rotasi, atau impersonasi TLS) — sama seperti aturan
   adapter lain di repo ini.
2. **Tanpa capture, tidak ada data** — mode `capture` adalah snapshot: katalog membeku pada
   saat penangkapan. Itu trade-off yang disengaja daripada memalsukan tanda tangan.
3. **Tidak ada halaman web publik** — `animexnonton.com` hanya halaman marketing Play Store
   (`com.streamx.nontonanimex`), jadi `anime.url` dikosongkan, bukan diisi URL karangan.
4. **Sumber lain di APK mati** — `apps.animekita.org` (403, domain ter-deface) dan
   `pencarinafkah.xyz` (200 tapi 0 byte). Tidak ada gunanya menerapkannya.
5. **Isi konten tumpang tindih** dengan AnimeKu/Oploverz yang sudah berjalan; fitur baru dari
   API ini hanyalah kurasi katalognya.

---

## 8. Tes

```bash
npm test -- server/test/animexnonton.test.js     # 12 tes
```

Yang dikunci:

| Tes | Isi |
|---|---|
| mode off | factory → `null`; `/api/health` tidak memuat `animexnonton`; 5 sumber lama tetap ada |
| mode tak dikenal | diperlakukan `off` |
| metadata | `id`, `name`, `supportsBrowse: false`, `usable`, policy |
| latest | 3 item, slug, tahun, skor, status, genre, `url: null` |
| search/detail/episode | penyaringan, `episodeList`, server `hls`, `not_found` |
| genres | 6 genre dari snapshot |
| capture rusak | error `config` yang menyebut `ANX_CAPTURE_FILE` |
| live tanpa template | error `config`, **0 request** dikirim |
| live dengan template | memakai `createClient(network, …)` milik repo, `POST` ke path benar, header `X-Anx-*`, body `anx=` |
| signer | kunci turunan deterministik, `master ≠ sig`, IV 12 byte, `liveValid` |
| fixture | semua judul `CONTOH` (tidak ada data asli di repo) |

---

## 9. Riwayat

| Tanggal | Perubahan |
|---|---|
| 24 Okt 2026 | Adapter + signer diterapkan dari `kazanime-animexnonton.patch`. Perbaikan saat integrasi: `createClient(network, …)` (patch asli mengirim `null`), mode `off` mengembalikan `null` agar benar-benar tidak terdaftar, mode tak dikenal → `off`, `latest`/`search` memakai respons live (bukan snapshot), detail/episode menolak jelas di mode live, `url` tidak lagi diisi gambar. Fixture pindah ke `server/test/fixtures/`. |
