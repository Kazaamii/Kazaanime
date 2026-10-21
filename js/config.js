/**
 * Kazanime — config.js
 * Satu-satunya tempat konstanta aplikasi. Modul lain WAJIB import dari sini,
 * jangan menulis ulang string/angka ajaib di tempat lain.
 *
 * Tahap A : konstanta UI (app, storage key, tema, navigasi, genre, avatar, platform legal).
 * Tahap B : + API_CONFIG (AniList/Jikan/Kitsu/backend), timeout & TTL cache.
 * Tahap C : + daftar server streaming.
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

/** Kunci localStorage — SAMA dengan file asli agar data user lama tetap terbaca. */
export const STORAGE_KEYS = Object.freeze({
    theme: 'kazanime-theme',
    users: 'kazanime-users',
    currentUser: 'kazanime-current-user',
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
 * Genre di homepage. `anilistTag` dipakai untuk yang di AniList berupa TAG,
 * bukan GENRE (contoh: Isekai) — di file asli Isekai dikirim sebagai genre
 * sehingga hasilnya selalu kosong/salah.
 */
export const GENRES = Object.freeze([
    { label: 'Action' },
    { label: 'Romance' },
    { label: 'Comedy' },
    { label: 'Fantasy' },
    { label: 'Slice of Life' },
    { label: 'Horror' },
    { label: 'Mecha' },
    { label: 'Sports' },
    { label: 'Isekai', anilistTag: 'Isekai' },
    { label: 'Mystery' },
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

/** Pengaturan UI umum. */
export const UI = Object.freeze({
    heroInterval: 6000,      // ms, autoplay hero (sama seperti asli)
    heroMaxSlides: 8,
    toastDuration: 3500,
    skeletonCount: 6,
    searchMinChars: 2,
    searchDebounce: 350,
});
