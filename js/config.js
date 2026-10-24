/**
 * Kazanime — config.js
 * Satu-satunya tempat konstanta aplikasi. Modul lain WAJIB import dari sini,
 * jangan menulis ulang string/angka ajaib di tempat lain.
 *
 * Tahap A : konstanta UI (app, storage key, tema, navigasi, genre, avatar, platform legal).
 * Tahap B : + API_CONFIG (AniList/Kitsu/backend — Jikan dihapus 22 Okt 2026), timeout, TTL cache, jadwal WIB.
 * Tahap C : + STREAMING_SERVERS & PLAYER (watch.html), CACHE_TTL.detail, kunci riwayat/auto-next.
 * Tahap D : API_CONFIG.backend aktif (backend scraper Express di server/, endpoint /api/anime/*).
 * Perbaikan pasca-D (22 Okt 2026): player mendahulukan server hasil scraping backend
 *           (AnimeXin, Samehadaku) untuk SEMUA anime — PLAYER.serverOrder; host embed
 *           cadangan animeplay.cfd (suspended) → megaplay.buzz (+ Vidnest & TryEmbed, pustaka
 *           HiAnime). Tombol server tampil "Server 1, 2, …" (nama penyedia tidak ditampilkan).
 */

export const APP = Object.freeze({
    name: 'Kazanime',
    tagline: 'Streaming anime Multi Sub dan bahasa lain sesuai ketersediaan tiap judul dan server. Kualitas hingga 1080p.',
    copyrightYear: 2025,
    credit: 'M Rully Febriansyah',
    /*
     * URL logo lama (cdn.myanimelist.net/images/characters/2/357667.jpg) ternyata 404,
     * sehingga di file asli yang selalu tampil hanyalah emoji 🎴.
     * Diganti gambar Yumeko Jabami dari Kitsu (sudah dicek: HTTP 200).
     * Kosongkan ('') jika ingin kembali ke emoji saja.
     */
    logoImage: 'https://media.kitsu.app/characters/images/92508/original.jpg',
    logoFallback: '🎴',
});

/**
 * Kunci penyimpanan.
 * 3 kunci pertama SAMA dengan file asli agar akun, bookmark & tema user lama tetap terbaca.
 * Kunci "kz:*" baru di Tahap B (cache & status API, aman dihapus kapan saja).
 */
export const STORAGE_KEYS = Object.freeze({
    theme: 'kazanime-theme',
    users: 'kazanime-users',
    /** Salinan cadangan otomatis (putaran 10): dipakai bila data utama korup/hilang. */
    usersBackup: 'kazanime-users-backup',
    /** Penghitung versi data akun — mendeteksi perubahan dari tab/perangkat lain. */
    usersVersion: 'kazanime-users-version',
    currentUser: 'kazanime-current-user',
    /** Token sesi server akun opsional (lihat js/services/account-sync.js). */
    accountToken: 'kazanime-account-token',
    apiCachePrefix: 'kz:cache:',            // sessionStorage — cache respons API (sudah dinormalisasi)
    apiHealth: 'kz:health',                 // sessionStorage — status & circuit breaker tiap sumber
    apiStatusShown: 'kz:status-shown',      // sessionStorage — widget status API sudah tampil di sesi ini
    anilistNoBatch: 'kz:anilist-nobatch',   // localStorage  — waktu saat query gabungan AniList ditolak
    history: 'kz:history',                  // localStorage  — episode yang sudah dibuka per anime (Tahap C)
    autoNext: 'kz:autonext',                // localStorage  — preferensi auto-next ('1' / '0') (Tahap C)
    /** Sisa kunci mode sandbox lama (24 Okt 2026). Sandbox sudah dihapus total di putaran 8 —
     *  kuncinya hanya dipakai untuk membersihkan pilihan lama di perangkat pengguna. */
    popupGuard: 'kz:popup-guard',
});

/** 7 tema. 'sakura' = default (:root), sisanya pakai [data-theme]. */
export const DEFAULT_THEME = 'sakura';
export const THEMES = Object.freeze([
    { id: 'sakura',   name: 'Sakura',   icon: '🌸', desc: 'Pink & ungu manis',     particle: 'sakura-petal' },
    { id: 'autumn',   name: 'Autumn',   icon: '🍂', desc: 'Hangat oranye gugur',   particle: 'autumn-leaf' },
    { id: 'winter',   name: 'Winter',   icon: '❄️', desc: 'Biru dingin elegan',    particle: 'winter-snow' },
    { id: 'summer',   name: 'Summer',   icon: '☀️', desc: 'Cerah kuning tropis',   particle: 'summer-bubble' },
    { id: 'midnight', name: 'Midnight', icon: '🌙', desc: 'Gelap misterius',       particle: 'midnight-star' },
    { id: 'neon',     name: 'Neon',     icon: '💜', desc: 'Cyberpunk vibrant',     particle: 'neon-particle' },
    { id: 'forest',   name: 'Forest',   icon: '🌿', desc: 'Hijau natural',         particle: 'forest-leaf' },
]);
export const THEME_PARTICLE_COUNT = 20;

/**
 * Link navbar. `section` = id elemen di index.html.
 * Di halaman lain link otomatis menjadi index.html#section.
 */
/* 24 Okt 2026 (permintaan pengguna): Bookmark keluar dari daftar navbar yang sempit.
 * Aksesnya lewat menu profil (Bookmark Saya) + footer, dan isinya kini halaman sendiri
 * (bookmark.html) — bukan section di beranda. */
export const NAV_LINKS = Object.freeze([
    { label: 'Beranda',  section: null },
    { label: 'Ongoing',  section: 'ongoing' },
    { label: 'Populer',  section: 'popular' },
    { label: 'Donghua',  section: 'donghua' },
    { label: 'Genre',    section: 'genre' },
    { label: 'Jelajah',  page: 'katalog.html' },
    { label: 'Jadwal',   section: 'jadwal' },
]);

/**
 * Genre di homepage + pemetaan ke tiap sumber data.
 *  - anilistTag : dipakai jika di AniList berupa TAG, bukan GENRE (contoh: Isekai).
 *                 Di file asli Isekai dikirim sebagai genre → hasil selalu kosong.
 *  - kitsu      : slug kategori Kitsu (filter[categories], sudah dicek valid).
 */
/**
 * Genre yang ditampilkan di beranda & search.html.
 *
 * 24 Okt 2026 (permintaan pengguna): daftar lama hanya 10 genre (subset). Sekarang
 * memuat SELURUH genre AniList (18) + tag Isekai, dengan padanan slug Kitsu.
 * `label` harus sama persis dengan nama genre AniList (mis. "Sci-Fi", "Slice of Life");
 * `anilistTag` dipakai untuk Isekai karena di AniList ia tag, bukan genre.
 */
export const GENRES = Object.freeze([
    { label: 'Action',        kitsu: 'action' },
    { label: 'Adventure',     kitsu: 'adventure' },
    { label: 'Comedy',        kitsu: 'comedy' },
    { label: 'Drama',         kitsu: 'drama' },
    { label: 'Ecchi',         kitsu: 'ecchi' },
    { label: 'Fantasy',       kitsu: 'fantasy' },
    { label: 'Horror',        kitsu: 'horror' },
    { label: 'Mahou Shoujo',  kitsu: 'mahou-shoujo' },
    { label: 'Mecha',         kitsu: 'mecha' },
    { label: 'Music',         kitsu: 'music' },
    { label: 'Mystery',       kitsu: 'mystery' },
    { label: 'Psychological', kitsu: 'psychological' },
    { label: 'Romance',       kitsu: 'romance' },
    { label: 'Sci-Fi',        kitsu: 'sci-fi' },
    { label: 'Slice of Life', kitsu: 'slice-of-life' },
    { label: 'Sports',        kitsu: 'sports' },
    { label: 'Supernatural',  kitsu: 'supernatural' },
    { label: 'Thriller',      kitsu: 'thriller' },
    { label: 'Isekai',        kitsu: 'isekai', anilistTag: 'Isekai' },
]);

/** Nama hari (index = Date#getDay(): 0 = Minggu). */
export const DAY_NAMES = Object.freeze(['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']);

/**
 * 25 avatar preset.
 *
 * Sejarah: di file asli SEMUA url-nya 404 (selalu jatuh ke emoji). Sekarang:
 *  - 14 karakter memakai foto resmi dari CDN Kitsu (URL diverifikasi lewat
 *    `GET /api/edge/characters/<id>?fields[characters]=image` — 24 Okt 2026).
 *  - 7 karakter yang tidak punya foto resmi di Kitsu memakai **kartu avatar lokal**
 *    (`assets/avatars/*.svg`, ikut repo) — selalu tampil, tanpa request jaringan,
 *    jadi tidak pernah jatuh ke ikon emoji bawaan.
 *  - `fallback` = URL kedua yang dicoba bila gambar utama gagal dimuat sebelum
 *    akhirnya memakai kartu lokal/emoji (lihat installImageFallback di ui/dom.js).
 */
/**
 * Foto avatar preset.
 *
 * Putaran 10 (24 Okt 2026) — keluhan "beberapa foto profil tidak terdeteksi, hanya icon
 * bawaan". Penyebabnya: URL disusun otomatis (`.../characters/images/<id>/original.jpg`)
 * padahal Kitsu memakai akhiran berbeda per karakter (Zero Two `.jpeg`, Marin ber-hash) dan
 * beberapa ID tidak ada → 404 → yang tampil hanya emoji bawaan.
 *
 * Aturan sekarang:
 *  - SETIAP URL di bawah sudah diverifikasi lewat `GET /api/edge/characters?filter[id]=…`
 *    pada 24 Okt 2026 dan memakai berkas yang benar-benar dilayani Kitsu (`large`, 500×600).
 *  - Karakter yang tidak ada di basis data Kitsu memakai ilustrasi lokal 320×320 di
 *    `assets/avatars/` (tanpa jaringan, selalu tampil) + kartu SVG sebagai cadangan.
 *  - `card` = cadangan lokal bila foto gagal dimuat (js/ui/dom.js: rantai data-fallback).
 *  - Jangan menyusun URL Kitsu secara otomatis; salin dari respons API.
 */
const LOCAL_AVATAR = (file) => `assets/avatars/${file}`;
export const AVATARS = Object.freeze([
    // ——— Kitsu (terverifikasi) ———
    { id: 1,  name: 'Rem',      img: 'https://media.kitsu.app/character/62134/image/large-f77b2d0e41882fd1d8759058674fb650.jpeg' },
    { id: 2,  name: 'Emilia',   img: 'https://media.kitsu.app/character/62258/image/large-9a5a8386582d090e711082bbb3708c03.jpeg' },
    { id: 3,  name: 'Zero Two', img: 'https://media.kitsu.app/character/95090/image/large-1aa59bd3aec687fa1cf98fa146c0a97d.jpeg' },
    { id: 4,  name: 'Mai S.',   img: 'https://media.kitsu.app/character/66744/image/large-8b5546c063483445771deeebe6aed791.jpeg' },
    { id: 5,  name: 'Marin K.', img: 'https://media.kitsu.app/character/105861/image/large-1ce67f1b9cd796d8d61d824bf0f9430e.jpeg' },
    // ——— Ilustrasi lokal (tidak ada di Kitsu; selalu tampil, juga offline) ———
    { id: 6,  name: 'Yor F.',   img: LOCAL_AVATAR('photo-6-yor-forger.jpg'),   card: LOCAL_AVATAR('6-yor-forger.svg') },
    { id: 7,  name: 'Makima',   img: LOCAL_AVATAR('photo-7-makima.jpg'),       card: LOCAL_AVATAR('7-makima.svg') },
    { id: 8,  name: 'Power',    img: LOCAL_AVATAR('photo-8-power.jpg'),        card: LOCAL_AVATAR('8-power.svg') },
    // ——— Kitsu (terverifikasi) ———
    { id: 9,  name: 'Nezuko',   img: 'https://media.kitsu.app/character/74558/image/large-7ef0358ec024b712f60d79a5bd81d6d2.jpeg' },
    { id: 10, name: 'Mikasa',   img: 'https://media.kitsu.app/character/38505/image/large-b5f914a557b487179e3b93fbc73f4371.jpeg' },
    { id: 11, name: 'Hinata',   img: 'https://media.kitsu.app/character/350/image/large-6def4b9973b90cfa20f54e7f7e7fd020.jpeg' },
    { id: 12, name: 'Asuna',    img: 'https://media.kitsu.app/character/35731/image/large-f362af0c8e6552a4e11e5c418a4e4f81.jpeg' },
    { id: 13, name: 'Megumin',  img: 'https://media.kitsu.app/character/59254/image/large-120a12666549b7ca668cab18e38a89bd.jpeg' },
    { id: 14, name: 'Aqua',     img: 'https://media.kitsu.app/character/88093/image/large-fe7bc459b184bc6ea71d9800c4b7bb23.jpeg' },
    { id: 15, name: 'Chika',    img: 'https://media.kitsu.app/character/76736/image/large-adbbdb42ef3cf7cdd6154b445e6117cd.jpeg' },
    { id: 16, name: 'Gojo',     img: LOCAL_AVATAR('photo-16-satoru-gojo.jpg'), card: LOCAL_AVATAR('16-satoru-gojo.svg') },
    { id: 17, name: 'Levi',     img: 'https://media.kitsu.app/character/39556/image/large-a9a0df71df0655fc58450f17a97b9f41.jpeg' },
    { id: 18, name: 'Tanjiro',  img: 'https://media.kitsu.app/character/75716/image/large-ae410f9ef35db0c5c7b3947a0512c5ae.jpeg' },
    { id: 19, name: 'Goku',     img: 'https://media.kitsu.app/character/4119/image/large-caa42df1ee38c94427d3a3b764b567c9.jpeg' },
    { id: 20, name: 'Naruto',   img: 'https://media.kitsu.app/character/221/image/large-c1fc8267b7061dfbef126d7f30110fe9.jpeg' },
    { id: 21, name: 'Anya',     img: LOCAL_AVATAR('photo-21-anya-forger.jpg'), card: LOCAL_AVATAR('21-anya-forger.svg') },
    { id: 22, name: 'Frieren',  img: LOCAL_AVATAR('photo-22-frieren.jpg'),      card: LOCAL_AVATAR('22-frieren.svg') },
    { id: 23, name: 'Ai H.',    img: LOCAL_AVATAR('photo-23-ai-hoshino.jpg'),   card: LOCAL_AVATAR('23-ai-hoshino.svg') },
    { id: 24, name: 'Yumeko',   img: 'https://media.kitsu.app/character/92508/image/large-4504521426907174cd6f0123c1f9eb6b.jpeg' },
    { id: 25, name: 'Kurumi',   img: 'https://media.kitsu.app/character/38200/image/large-ab5874eff98c5bbf1dec2ab729fc1485.jpeg' },
]);


/** Gambar utama satu avatar preset: foto → kartu lokal → null (emoji). */
export function avatarImage(avatar) {
    return avatar?.img || avatar?.card || null;
}
export const AVATAR_EMOJIS = Object.freeze(['🌸','🎭','💜','🎪','🌺','🎨','🌙','✨','🎀','💫','🌟','🎯','🔮','💎','🎪','🌈','🎭','💝','🌸','💖','🎀','🌺','💫','🎨','✨']);
export const AVATAR_COLORS = Object.freeze(['#ff6b9d','#c084fc','#67e8f9','#f59e0b','#10b981','#ec4899','#8b5cf6','#06b6d4','#ef4444','#f97316','#d946ef','#14b8a6','#6366f1','#a855f7','#22d3ee','#e67e22','#f472b6','#34d399','#fbbf24','#818cf8','#fb7185','#2dd4bf','#c084fc','#fb923c','#a78bfa']);
/** Batas upload avatar. Foto kamera ponsel 3–12 MB diterima lalu DIKECILKAN otomatis
 *  (putaran 10) — dulu >2 MB langsung ditolak sehingga pengguna berakhir dengan avatar
 *  bawaan tanpa sadar. */
export const AVATAR_UPLOAD = Object.freeze({ maxBytes: 12 * 1024 * 1024, size: 200, quality: 0.82, maxDataUrlBytes: 180 * 1024 });

/** Aturan akun (sama dengan file asli: username ≥ 3, password ≥ 6). */
export const AUTH_RULES = Object.freeze({ usernameMin: 3, usernameMax: 24, passwordMin: 6 });

/** Platform streaming legal (link pencarian, tanpa scraping). `icon` = nama ikon di js/ui/icons.js. */
export const LEGAL_PLATFORMS = Object.freeze([
    { id: 'bstation', name: 'Bstation',       icon: 'monitor-play', description: 'Platform resmi; bahasa subtitle bergantung pada judul',
      url: (t) => `https://www.bilibili.tv/search?keyword=${encodeURIComponent(t)}` },
    { id: 'muse',     name: 'Muse Indonesia', icon: 'clapperboard', description: 'Kanal resmi; judul dan bahasa subtitle yang tersedia bervariasi',
      url: (t) => `https://www.youtube.com/@MuseIndonesia/search?query=${encodeURIComponent(t)}` },
    { id: 'anione',   name: 'Ani-One Asia',   icon: 'film', description: 'Anime legal; pilihan bahasa bergantung pada judul dan region',
      url: (t) => `https://www.youtube.com/@AniOneAsia/search?query=${encodeURIComponent(t)}` },
    { id: 'vidio',    name: 'Vidio',          icon: 'tv', description: 'Platform streaming Indonesia',
      url: (t) => `https://www.vidio.com/search?q=${encodeURIComponent(t)}` },
]);

/* ========================================================================== */
/* TAHAP B — Sumber data                                                      */
/* ========================================================================== */

/**
 * Sumber data metadata. Urutan fallback: AniList → Kitsu → data statis.
 * (Jikan/MyAnimeList dihapus 22 Okt 2026 atas permintaan pemilik proyek.)
 *
 * Catatan penting (hasil pengecekan, Okt 2026):
 *  - AniList menolak request TANPA header Referer (HTTP 403). Browser mengirimnya
 *    otomatis — karena itu situs WAJIB dibuka lewat http(s)://, bukan file://.
 *    Batas sementara AniList: 30 request/menit → homepage memakai SATU query gabungan.
 *  - Kitsu: kitsu.app menolak preflight CORS (OPTIONS → 403), jadi request dikirim
 *    sebagai "simple GET" tanpa header kustom. `page[offset]` saat ini diabaikan
 *    server (halaman 2 = halaman 1) → Kitsu hanya dipakai untuk halaman pertama.
 *  - backend: server scraper milik sendiri (Tahap D, folder server/). baseUrl '' = origin
 *    yang sama (Vercel / `npm run dev`). Bila situs dibuka dari server statis tanpa backend
 *    (mis. Live Server), /api membalas 404 → backend otomatis dimatikan untuk halaman itu.
 *    `enabled: false` = frontend tidak pernah memanggil /api/... sama sekali.
 */
export const API_CONFIG = Object.freeze({
    anilist: Object.freeze({ name: 'AniList', url: 'https://graphql.anilist.co', timeout: 8000 }),
    kitsu: Object.freeze({ name: 'Kitsu', url: 'https://kitsu.app/api/edge', timeout: 7000 }),
    backend: Object.freeze({ name: 'Backend', enabled: true, baseUrl: '', timeout: 12000 }),
    /** Timeout khusus autocomplete (lebih pendek: saran yang lambat tidak berguna). */
    suggestTimeout: 6000,
    /** Jumlah percobaan ulang untuk error jaringan/5xx/429 (timeout tidak diulang). */
    retries: 1,
    /** Sumber yang gagal dilewati sementara selama ini (ms) agar fallback instan. */
    circuitMs: 90 * 1000,
    /** "Baru Rilis": utamakan anime dengan popularitas AniList ≥ nilai ini. */
    recentMinPopularity: 3000,
});

/** Umur cache (ms). Cache disimpan di Map + sessionStorage (hilang saat tab ditutup). */
export const CACHE_TTL = Object.freeze({
    home: 15 * 60 * 1000,
    browse: 10 * 60 * 1000,
    search: 10 * 60 * 1000,
    schedule: 60 * 60 * 1000,
    detail: 30 * 60 * 1000,  // Tahap C: detail anime, jumlah episode, rekomendasi (watch.html)
});

/** Jadwal rilis — selalu ditampilkan dalam WIB (UTC+7, tanpa DST). */
export const SCHEDULE = Object.freeze({
    label: 'WIB',
    utcOffsetHours: 7,
    /** Maks. anime berjam per hari (jadwal rilis Sub Indo / jadwal tayang). */
    perDay: 8,
    /** Maks. donghua per hari (AnimeXin tanpa jam; Anichin dengan jam perkiraan). */
    perDayDonghua: 5,
});

/**
 * Feed "Anime Jepang Sub Indo" di beranda (dipisah per situs sumber).
 *
 * 24 Okt 2026: verifikasi per episode dihapus. AnimeKu & Oploverz sudah situs Sub Indo,
 * jadi katalognya ditampilkan apa adanya — beranda tidak memeriksa episode, tidak
 * menunggu batas waktu, dan tidak menyembunyikan judul.
 */
export const SUB_INDO = Object.freeze({
    /** Maks. judul yang dipakai per panel (backend mengirim 24 per situs). */
    resultLimit: 24,
    /** Kartu yang dirender sebelum tombol "Tampilkan lebih banyak" ditekan. */
    previewLimit: 6,
});

/** Pengaturan UI umum. */
export const UI = Object.freeze({
    heroInterval: 6000,      // ms, autoplay hero (sama seperti asli)
    heroMaxSlides: 8,
    toastDuration: 3500,
    skeletonCount: 6,
    sectionSize: 12,         // jumlah kartu per section homepage
    searchMinChars: 2,
    searchDebounce: 350,
    searchPerPage: 20,       // maks Kitsu = 20, jadi semua sumber disamakan
    suggestFetch: 6,         // item yang diminta per sumber untuk autocomplete
    suggestLimits: Object.freeze({ anilist: 5, kitsu: 5 }), // total 10 seperti dropdown asli (kuota MAL dibagi)
    apiStatusHideDelay: 5000,
});

/* ========================================================================== */
/* TAHAP C — Player & server streaming                                        */
/* ========================================================================== */

/**
 * Server streaming STATIS (embed iframe) = CADANGAN. URUTAN = urutan fallback otomatis.
 *  - name     : nama internal (log & dokumentasi). Di halaman nonton SEMUA tombol server tampil
 *               "Server 1, 2, …" sesuai urutan putar — nama penyedia tidak ditampilkan.
 *  - needs    : ID yang wajib ada ('anilist' | 'mal' | 'kitsu'). Tanpa ID itu server
 *               ditampilkan terkunci dan dilewati otomatis.
 *  - url(ctx) : ctx = { anilist, mal, kitsu, ep, title } → URL embed (http/https).
 *  - provider : (22 Okt 2026) slot yang diisi server dari backend GET /api/stream/servers
 *               ('reanime' | 'anizone'). Tanpa url(); posisinya di daftar tetap (nomor server
 *               tidak bergeser) — tampil "mencari…" lalu tersedia / tidak tersedia.
 *  - lang     : bahasa subtitle ('id' | 'en' | 'multi') — tampil di status player.
 *  - origins  : origin TAMBAHAN yang boleh mengirim postMessage (auto-next & progres),
 *               mis. bila player asli berada di iframe bersarang domain lain.
 *               Origin dari URL embed itu sendiri selalu diizinkan.
 *  - enabled  : false = disembunyikan tanpa menghapus definisinya.
 *
 * Server UTAMA datang dari backend scraper (server/sources/: AnimeXin, Samehadaku) per
 * episode — lihat PLAYER.serverOrder. Server di bawah hanya dipakai bila situs sumber tidak
 * punya anime/episode itu atau semua servernya gagal. Ingin HANYA server hasil scraping?
 * Set `enabled: false` pada setiap server di bawah (anime yang tidak ada di situs sumber
 * lalu tidak bisa diputar).
 *
 * Host embed (dicek 22 Okt 2026):
 *  - `animeplay.cfd` (host di file asli) hanyalah mirror MegaPlay dan kini di-suspend:
 *    SEMUA URL dialihkan ke /cgi-sys/suspendedpage.cgi → iframe hanya menampilkan
 *    "Account Suspended".
 *  - Diganti domain utama MegaPlay, `megaplay.buzz` — pola path SAMA:
 *    /stream/ani/{anilist}/{ep}/sub dan /stream/mal/{mal}/{ep}/sub.
 *  - MegaPlay = pustaka HiAnime → "sub" berarti subtitle INGGRIS (bukan Indonesia).
 *  - MegaPlay hanya memutar bila request iframe membawa header Referer (tanpa Referer
 *    → halaman "Error - MegaPlay"). Karena itu PLAYER.referrerPolicy = 'origin' —
 *    jangan diubah ke 'no-referrer'.
 *  - Episode yang belum tayang / belum dipetakan MegaPlay menampilkan "Oops! Something
 *    went wrong" DI DALAM iframe. Browser tidak bisa membacanya → pakai "⟳ Server Lain".
 *  - Vidnest (vidnest.fun) & TryEmbed (tryembed.us.cc): embed lain berbasis id AniList yang dipakai
 *    hianime.ro untuk pustaka HiAnime yang sama (dicek: bisa di-embed, tanpa X-Frame-Options/CSP).
 *    Subtitle Inggris. Ketersediaan per episode tidak bisa dicek dari luar → pakai "⟳ Server Lain".
 *  - 22 Okt 2026 (permintaan pemilik proyek): server cadangan #2 (MegaPlay via id MAL) diganti
 *    ReAnime (embed flixcloud dari API publik reanime.to, subtitle Inggris), dan ditambah satu
 *    tombol AniZone "Multi Sub" (HLS + banyak subtitle termasuk Indonesia bila tersedia, diputar
 *    player bawaan lewat proxy /api/stream/hls — lihat server/routes/stream.js).
 * Ganti host: ubah STREAM_HOST (pola path sama) atau tambah entri baru di bawah.
 */
const STREAM_HOST = 'https://megaplay.buzz';
export const STREAMING_SERVERS = Object.freeze([
    // Utamakan player Multi Sub jika tersedia, lalu server bahasa tunggal sebagai cadangan.
    Object.freeze({
        id: 'anizone',
        provider: 'anizone',
        name: 'AniZone - Multi Sub',
        description: 'AniZone - banyak pilihan subtitle (bahasa Indonesia bila tersedia)',
        lang: 'multi',
        enabled: true,
        origins: Object.freeze([]),
    }),
    Object.freeze({
        id: 'megaplay-anilist',
        flag: '🇯🇵',
        name: 'MegaPlay - AniList',
        description: 'Cadangan - MegaPlay via AniList ID (subtitle Inggris)',
        needs: 'anilist',
        lang: 'en',
        enabled: true,
        origins: Object.freeze([]),
        url: ({ anilist, ep }) => `${STREAM_HOST}/stream/ani/${anilist}/${ep}/sub`,
    }),
    Object.freeze({
        id: 'reanime',
        provider: 'reanime',
        name: 'ReAnime',
        description: 'Cadangan - ReAnime (subtitle Inggris)',
        lang: 'en',
        enabled: true,
        origins: Object.freeze([]),
    }),
    Object.freeze({
        id: 'vidnest-anilist',
        flag: '🌐',
        name: 'Vidnest - AniList',
        description: 'Cadangan - Vidnest via AniList ID (subtitle Inggris)',
        needs: 'anilist',
        lang: 'en',
        enabled: true,
        origins: Object.freeze([]),
        url: ({ anilist, ep }) => `https://vidnest.fun/anime/${anilist}/${ep}/sub`,
    }),
    Object.freeze({
        id: 'tryembed-anilist',
        flag: '🌐',
        name: 'TryEmbed - AniList',
        description: 'Cadangan - TryEmbed via AniList ID (subtitle Inggris)',
        needs: 'anilist',
        lang: 'en',
        enabled: true,
        origins: Object.freeze([]),
        url: ({ anilist, ep }) => `https://tryembed.us.cc/embed/anime/${anilist}/${ep}/sub`,
    }),
]);

/** Pengaturan player watch.html. */
export const PLAYER = Object.freeze({
    /**
     * Urutan sumber video:
     *  - 'scrape-first' (default): untuk SEMUA anime, player mencari episode itu di situs
     *    sumber backend (AnimeXin / Samehadaku — dicocokkan lewat judul) dan memutar server
     *    hasil scraping lebih dulu. STREAMING_SERVERS hanya cadangan otomatis.
     *  - 'static-first': perilaku Tahap D — server statis dulu, server scraping sebagai
     *    tambahan (kecuali anime yang dibuka dari kartu backend / URL ber-slug).
     * Tanpa backend (situs statis / backend nonaktif) keduanya sama: hanya server statis.
     */
    serverOrder: 'scrape-first',
    /** Maks. menunggu hasil scraping sebelum memutar server cadangan (ms). Hasil yang datang
     *  belakangan tetap ditambahkan sebagai tombol server tanpa memutus video. */
    scrapeWaitMs: 8000,
    /** iframe tidak selesai dimuat dalam waktu ini (ms) → otomatis pindah ke server berikutnya. */
    loadTimeout: 15000,
    /** Auto-next default (user bisa mengubahnya; pilihan tersimpan di localStorage). */
    autoNextDefault: true,
    /** Tombol episode per tab rentang (One Piece 1000+ episode → 1–100, 101–200, ...). */
    episodesPerRange: 100,
    /** Batas aman nomor episode dari URL / input manual. */
    maxEpisode: 3000,
    /**
     * Pemeriksaan Sub Indo per episode di daftar episode (24 Okt 2026, putaran 3).
     * Backend memeriksa halaman episode satu per satu (maks 3 permintaan bersamaan), jadi
     * jumlahnya dibatasi. Episode >24 tetap bisa ditonton; badge-nya menyusul saat dibuka.
     */
    subtitleMapLimit: 24,
    /** Izin iframe. Tanpa camera/microphone/display-capture (dulu diberikan tanpa perlu). */
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen',
    /** Sebagian penyedia embed memeriksa Referer (cukup origin) — MegaPlay WAJIB ada Referer. */
    referrerPolicy: 'origin',
    /**
     * Lapisan anti-iklan di atas iframe player — 24 Okt 2026 (putaran 8).
     *
     * Sandbox iframe DIHAPUS (banyak embed menolak: "Sandboxed our player is not allowed",
     * video tidak muncul). Sebagai gantinya, satu lapisan transparan menutup area player
     * sampai diklik sekali: klik pertama tidak diteruskan ke iframe sehingga popunder
     * yang dipicu klik pertama tidak terjadi. Pemutaran tidak terpengaruh sesudahnya.
     * Set `false` untuk mematikan lapisan ini.
     */
    adShield: true,
    /** Label singkat situs untuk tombol server Sub Indo (dipakai js/watch.js). */
    siteLabels: Object.freeze({ animeku: 'AnimeKu', oploverz: 'Animeloverz' }),
    /** Jumlah kartu rekomendasi. */
    recommendationCount: 12,
    /**
     * Player HLS bawaan (server AniZone "Multi Sub"). hls.js disimpan lokal (js/vendor/, lisensi
     * Apache-2.0) dan baru dimuat saat server HLS diputar. Safari/iOS memakai HLS native langsung
     * dari CDN (tanpa proxy); browser lain lewat proxy /api/stream/hls (CORS CDN dikunci ke anizone.to).
     */
    hlsScript: '/js/vendor/hls.min.js',
    /** Urutan subtitle yang dipilih otomatis (kode bahasa). */
    subtitlePriority: Object.freeze(['id', 'en']),
    /**
     * "Subtitle Indonesia (AI)" (22 Okt 2026). Bila episode di player bawaan tidak punya subtitle Indonesia DAN
     * backend menawarkannya (`server.ai`, hanya bila GEMINI_API_KEY diisi di server), subtitle Inggris
     * diterjemahkan Gemini per bagian saat video mulai diputar. Key tidak pernah ada di frontend.
     */
    aiSubtitle: Object.freeze({
        enabled: true,
        /** Satu bagian bisa butuh puluhan detik (batas fungsi Vercel 60 dtk). */
        requestTimeout: 65000,
        /** Jeda sebelum mengulang bagian yang gagal sementara (ms); Retry-After server dihormati (maks 2 menit). */
        retryDelays: Object.freeze([5000, 20000]),
    }),
});
