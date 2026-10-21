/**
 * Kazanime — config.js
 * Satu-satunya tempat konstanta aplikasi. Modul lain WAJIB import dari sini,
 * jangan menulis ulang string/angka ajaib di tempat lain.
 *
 * Tahap A : konstanta UI (app, storage key, tema, navigasi, genre, avatar, platform legal).
 * Tahap B : + API_CONFIG (AniList/Jikan/Kitsu/backend), timeout, TTL cache, jadwal WIB.
 * Tahap C : + STREAMING_SERVERS & PLAYER (watch.html), CACHE_TTL.detail, kunci riwayat/auto-next.
 * Tahap D : API_CONFIG.backend aktif (backend scraper Express di server/, endpoint /api/anime/*).
 * Perbaikan pasca-D (22 Okt 2026): player mendahulukan server hasil scraping backend
 *           (AnimeXin, Kuramanime) untuk SEMUA anime — PLAYER.serverOrder; host embed
 *           cadangan animeplay.cfd (suspended) → megaplay.buzz.
 */

export const APP = Object.freeze({
    name: 'Kazanime',
    tagline: 'Platform streaming & download anime subtitle Indonesia terbaik. Kualitas HD hingga 1080p.',
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
    currentUser: 'kazanime-current-user',
    apiCachePrefix: 'kz:cache:',            // sessionStorage — cache respons API (sudah dinormalisasi)
    apiHealth: 'kz:health',                 // sessionStorage — status & circuit breaker tiap sumber
    apiStatusShown: 'kz:status-shown',      // sessionStorage — widget status API sudah tampil di sesi ini
    anilistNoBatch: 'kz:anilist-nobatch',   // localStorage  — waktu saat query gabungan AniList ditolak
    history: 'kz:history',                  // localStorage  — episode yang sudah dibuka per anime (Tahap C)
    autoNext: 'kz:autonext',                // localStorage  — preferensi auto-next ('1' / '0') (Tahap C)
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
export const NAV_LINKS = Object.freeze([
    { label: 'Beranda',  section: null },
    { label: 'Ongoing',  section: 'ongoing' },
    { label: 'Populer',  section: 'popular' },
    { label: 'Donghua',  section: 'donghua' },
    { label: 'Bookmark', section: 'bookmarks', authOnly: true },
    { label: 'Genre',    section: 'genre' },
    { label: 'Jadwal',   section: 'jadwal' },
]);

/**
 * Genre di homepage + pemetaan ke tiap sumber data.
 *  - anilistTag : dipakai jika di AniList berupa TAG, bukan GENRE (contoh: Isekai).
 *                 Di file asli Isekai dikirim sebagai genre → hasil selalu kosong.
 *  - mal        : ID genre MyAnimeList (filter `genres` di Jikan).
 *  - kitsu      : slug kategori Kitsu (filter[categories], sudah dicek valid).
 */
export const GENRES = Object.freeze([
    { label: 'Action',        mal: 1,  kitsu: 'action' },
    { label: 'Romance',       mal: 22, kitsu: 'romance' },
    { label: 'Comedy',        mal: 4,  kitsu: 'comedy' },
    { label: 'Fantasy',       mal: 10, kitsu: 'fantasy' },
    { label: 'Slice of Life', mal: 36, kitsu: 'slice-of-life' },
    { label: 'Horror',        mal: 14, kitsu: 'horror' },
    { label: 'Mecha',         mal: 18, kitsu: 'mecha' },
    { label: 'Sports',        mal: 30, kitsu: 'sports' },
    { label: 'Isekai',        mal: 62, kitsu: 'isekai', anilistTag: 'Isekai' },
    { label: 'Mystery',       mal: 7,  kitsu: 'mystery' },
]);

/** Nama hari (index = Date#getDay(): 0 = Minggu). */
export const DAY_NAMES = Object.freeze(['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']);

/**
 * 25 avatar. Di file asli SEMUA url-nya 404 (selalu jatuh ke emoji).
 * 16 diganti gambar valid dari Kitsu (sudah dicek HTTP 200).
 * `img: null` = karakter belum ada di database Kitsu → otomatis pakai avatar emoji
 * (perilaku sama seperti sebelumnya). Isi dengan URL valid kapan saja.
 */
const KITSU_CHAR = (id) => `https://media.kitsu.app/characters/images/${id}/original.jpg`;
export const AVATARS = Object.freeze([
    { id: 1,  name: 'Rem',      img: KITSU_CHAR(62134) },
    { id: 2,  name: 'Emilia',   img: KITSU_CHAR(62258) },
    { id: 3,  name: 'Zero Two', img: null },
    { id: 4,  name: 'Mai S.',   img: KITSU_CHAR(66744) },
    { id: 5,  name: 'Marin K.', img: null },
    { id: 6,  name: 'Yor F.',   img: null },
    { id: 7,  name: 'Makima',   img: null },
    { id: 8,  name: 'Power',    img: null },
    { id: 9,  name: 'Nezuko',   img: KITSU_CHAR(74558) },
    { id: 10, name: 'Mikasa',   img: KITSU_CHAR(38505) },
    { id: 11, name: 'Hinata',   img: KITSU_CHAR(350) },
    { id: 12, name: 'Asuna',    img: KITSU_CHAR(35731) },
    { id: 13, name: 'Megumin',  img: KITSU_CHAR(59254) },
    { id: 14, name: 'Aqua',     img: KITSU_CHAR(88093) },
    { id: 15, name: 'Chika',    img: KITSU_CHAR(76736) },
    { id: 16, name: 'Gojo',     img: null },
    { id: 17, name: 'Levi',     img: KITSU_CHAR(39556) },
    { id: 18, name: 'Tanjiro',  img: KITSU_CHAR(75716) },
    { id: 19, name: 'Goku',     img: KITSU_CHAR(4119) },
    { id: 20, name: 'Naruto',   img: KITSU_CHAR(221) },
    { id: 21, name: 'Anya',     img: null },
    { id: 22, name: 'Frieren',  img: null },
    { id: 23, name: 'Ai H.',    img: null },
    { id: 24, name: 'Yumeko',   img: KITSU_CHAR(92508) },
    { id: 25, name: 'Kurumi',   img: KITSU_CHAR(38200) },
]);
/** Emoji + warna gradient untuk avatar fallback (index = id - 1) — identik dengan getFallbackAvatar asli. */
export const AVATAR_EMOJIS = Object.freeze(['🌸','🎭','💜','🎪','🌺','🎨','🌙','✨','🎀','💫','🌟','🎯','🔮','💎','🎪','🌈','🎭','💝','🌸','💖','🎀','🌺','💫','🎨','✨']);
export const AVATAR_COLORS = Object.freeze(['#ff6b9d','#c084fc','#67e8f9','#f59e0b','#10b981','#ec4899','#8b5cf6','#06b6d4','#ef4444','#f97316','#d946ef','#14b8a6','#6366f1','#a855f7','#22d3ee','#e67e22','#f472b6','#34d399','#fbbf24','#818cf8','#fb7185','#2dd4bf','#c084fc','#fb923c','#a78bfa']);
export const AVATAR_UPLOAD = Object.freeze({ maxBytes: 2 * 1024 * 1024, size: 200, quality: 0.8 });

/** Aturan akun (sama dengan file asli: username ≥ 3, password ≥ 6). */
export const AUTH_RULES = Object.freeze({ usernameMin: 3, usernameMax: 24, passwordMin: 6 });

/** Platform streaming legal (link pencarian, tanpa scraping). */
export const LEGAL_PLATFORMS = Object.freeze([
    { id: 'bstation', name: 'Bstation',       icon: '🅱️', description: 'Platform resmi Bilibili dengan sub Indo',
      url: (t) => `https://www.bilibili.tv/search?keyword=${encodeURIComponent(t)}` },
    { id: 'muse',     name: 'Muse Indonesia', icon: '🎬', description: 'YouTube channel resmi anime sub Indo',
      url: (t) => `https://www.youtube.com/@MuseIndonesia/search?query=${encodeURIComponent(t)}` },
    { id: 'anione',   name: 'Ani-One Asia',   icon: '🎭', description: 'Anime legal dengan subtitle Indonesia',
      url: (t) => `https://www.youtube.com/@AniOneAsia/search?query=${encodeURIComponent(t)}` },
    { id: 'vidio',    name: 'Vidio',          icon: '📺', description: 'Platform streaming Indonesia',
      url: (t) => `https://www.vidio.com/search?q=${encodeURIComponent(t)}` },
]);

/* ========================================================================== */
/* TAHAP B — Sumber data                                                      */
/* ========================================================================== */

/**
 * Sumber data metadata. Urutan fallback: AniList → Jikan (MAL) → Kitsu → data statis.
 *
 * Catatan penting (hasil pengecekan, Okt 2026):
 *  - AniList menolak request TANPA header Referer (HTTP 403). Browser mengirimnya
 *    otomatis — karena itu situs WAJIB dibuka lewat http(s)://, bukan file://.
 *    Batas sementara AniList: 30 request/menit → homepage memakai SATU query gabungan.
 *  - Jikan: maks ±3 request/detik & 60/menit → diberi jeda antar-request (minInterval).
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
    jikan: Object.freeze({ name: 'Jikan', url: 'https://api.jikan.moe/v4', timeout: 7000, minInterval: 400 }),
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
    perDay: 8,
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
    suggestLimits: Object.freeze({ mal: 4, kitsu: 3, anilist: 3 }), // sama seperti dropdown asli
    apiStatusHideDelay: 5000,
});

/* ========================================================================== */
/* TAHAP C — Player & server streaming                                        */
/* ========================================================================== */

/**
 * Server streaming STATIS (embed iframe) = CADANGAN. URUTAN = urutan fallback otomatis.
 *  - needs    : ID yang wajib ada ('anilist' | 'mal' | 'kitsu'). Tanpa ID itu server
 *               ditampilkan terkunci 🔒 dan dilewati otomatis.
 *  - url(ctx) : ctx = { anilist, mal, kitsu, ep, title } → URL embed (http/https).
 *  - lang     : bahasa subtitle ('id' | 'en' | 'multi') — tampil di status player.
 *  - origins  : origin TAMBAHAN yang boleh mengirim postMessage (auto-next & progres),
 *               mis. bila player asli berada di iframe bersarang domain lain.
 *               Origin dari URL embed itu sendiri selalu diizinkan.
 *  - enabled  : false = disembunyikan tanpa menghapus definisinya.
 *
 * Server UTAMA datang dari backend scraper (server/sources/: AnimeXin, Kuramanime) per
 * episode — lihat PLAYER.serverOrder. Server di bawah hanya dipakai bila situs sumber tidak
 * punya anime/episode itu atau semua servernya gagal. Ingin HANYA server hasil scraping?
 * Set `enabled: false` pada kedua server di bawah (anime yang tidak ada di situs sumber
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
 * Ganti host: ubah STREAM_HOST (pola path sama) atau tambah entri baru di bawah.
 */
const STREAM_HOST = 'https://megaplay.buzz';
export const STREAMING_SERVERS = Object.freeze([
    Object.freeze({
        id: 'megaplay-anilist',
        flag: '🇯🇵',
        name: 'Server 1 (MegaPlay - AniList)',
        description: 'Cadangan - MegaPlay via AniList ID (subtitle Inggris)',
        needs: 'anilist',
        lang: 'en',
        enabled: true,
        origins: Object.freeze([]),
        url: ({ anilist, ep }) => `${STREAM_HOST}/stream/ani/${anilist}/${ep}/sub`,
    }),
    Object.freeze({
        id: 'megaplay-mal',
        flag: '🇺🇸',
        name: 'Server 2 (MegaPlay - MAL)',
        description: 'Cadangan - MegaPlay via MAL ID (subtitle Inggris)',
        needs: 'mal',
        lang: 'en',
        enabled: true,
        origins: Object.freeze([]),
        url: ({ mal, ep }) => `${STREAM_HOST}/stream/mal/${mal}/${ep}/sub`,
    }),
]);

/** Pengaturan player watch.html. */
export const PLAYER = Object.freeze({
    /**
     * Urutan sumber video:
     *  - 'scrape-first' (default): untuk SEMUA anime, player mencari episode itu di situs
     *    sumber backend (AnimeXin / Kuramanime — dicocokkan lewat judul) dan memutar server
     *    hasil scraping lebih dulu. STREAMING_SERVERS hanya cadangan otomatis.
     *  - 'static-first': perilaku Tahap D — server statis dulu, server scraping sebagai
     *    tambahan (kecuali anime yang dibuka dari kartu backend / URL ber-slug).
     * Tanpa backend (situs statis / backend nonaktif) keduanya sama: hanya server statis.
     */
    serverOrder: 'scrape-first',
    /** Maks. menunggu hasil scraping sebelum memutar server cadangan (ms). Hasil yang datang
     *  belakangan tetap ditambahkan sebagai tombol server tanpa memutus video. */
    scrapeWaitMs: 8000,
    /** Nama situs sumber scraping untuk pesan di player. */
    scrapeLabel: 'AnimeXin & Kuramanime',
    /** iframe tidak selesai dimuat dalam waktu ini (ms) → otomatis pindah ke server berikutnya. */
    loadTimeout: 15000,
    /** Auto-next default (user bisa mengubahnya; pilihan tersimpan di localStorage). */
    autoNextDefault: true,
    /** Tombol episode per tab rentang (One Piece 1000+ episode → 1–100, 101–200, ...). */
    episodesPerRange: 100,
    /** Batas aman nomor episode dari URL / input manual. */
    maxEpisode: 3000,
    /** Izin iframe. Tanpa camera/microphone/display-capture (dulu diberikan tanpa perlu). */
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen',
    /** Sebagian penyedia embed memeriksa Referer (cukup origin) — MegaPlay WAJIB ada Referer. */
    referrerPolicy: 'origin',
    /**
     * Atribut sandbox iframe. Kosong = tanpa sandbox (sama seperti asli).
     * Contoh pemblokir pop-up: 'allow-scripts allow-same-origin allow-presentation allow-forms'
     * — tetapi banyak player embed (termasuk MegaPlay) menolak diputar bila di-sandbox.
     */
    sandbox: '',
    /** Jumlah kartu rekomendasi. */
    recommendationCount: 12,
});
