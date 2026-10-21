/**
 * Kazanime — data/fallback.js
 * Data statis cadangan, dipakai saat SEMUA sumber API gagal (atau di Tahap A
 * sebagai data pratinjau). Isinya sama dengan fallback di file asli, tetapi
 * sudah dalam format Anime yang dinormalisasi (lihat api/normalize.js).
 *
 * Perbaikan: 9 dari 10 gambar hero fallback di file asli 404 (hash URL AniList
 * karangan). Diganti poster/banner dari Kitsu yang sudah dicek HTTP 200.
 */
import { createAnime } from '../api/normalize.js';

/** Helper ringkas untuk item kartu fallback. */
const item = (title, genre, ep, rating, quality, badge, color, extra = {}) => {
    const epNum = /^EP\s*(\d+)/i.exec(ep)?.[1];
    const ongoing = Boolean(epNum) || ep === 'Ongoing';
    return createAnime({
        title,
        genres: [genre],
        latestEpisode: epNum ? Number(epNum) : null,
        status: ongoing ? 'ONGOING' : 'COMPLETED',
        score: Number.parseFloat(rating),
        quality,
        badge,
        color,
        source: 'fallback',
        ...extra,
    });
};

export const FALLBACK_ONGOING = Object.freeze([
    item('Solo Leveling S2', 'Action', 'EP 13', '9.2', '1080p', 'NEW', '#6366f1'),
    item('One Piece', 'Adventure', 'EP 1122', '9.0', '720p', 'SUB', '#ef4444'),
    item('Dandadan', 'Action', 'EP 8', '8.8', '1080p', 'HOT', '#f59e0b'),
    item('Jujutsu Kaisen S3', 'Supernatural', 'EP 5', '9.1', '1080p', 'NEW', '#8b5cf6'),
    item('Blue Lock S2', 'Sports', 'EP 11', '8.5', '720p', 'SUB', '#06b6d4'),
    item('Frieren S2', 'Fantasy', 'EP 4', '9.4', '1080p', 'HOT', '#10b981'),
]);

export const FALLBACK_POPULAR = Object.freeze([
    item('Attack on Titan', 'Action', 'Completed', '9.5', '1080p', 'HD', '#dc2626'),
    item('Demon Slayer S4', 'Action', 'Completed', '9.3', '1080p', 'HD', '#059669'),
    item('Spy x Family S2', 'Comedy', 'Completed', '8.9', '1080p', 'HD', '#d946ef'),
    item('Chainsaw Man', 'Action', 'Completed', '9.0', '1080p', 'HD', '#f97316'),
    item('Oshi no Ko', 'Drama', 'Completed', '8.8', '720p', 'SUB', '#ec4899'),
    item('Mushoku Tensei S2', 'Isekai', 'Completed', '9.1', '1080p', 'HD', '#8b5cf6'),
]);

export const FALLBACK_NEW = Object.freeze([
    item('Dragon Ball Daima', 'Action', 'EP 18', '8.4', '1080p', 'NEW', '#f97316'),
    item('Sakamoto Days', 'Action', 'EP 6', '8.7', '720p', 'NEW', '#14b8a6'),
    item('Kimi wa Meido-sama', 'Romance', 'EP 9', '8.2', '720p', 'SUB', '#f472b6'),
    item('Re:Zero S3', 'Fantasy', 'EP 12', '9.0', '1080p', 'HOT', '#818cf8'),
    item('Wind Breaker', 'Action', 'EP 10', '8.3', '720p', 'SUB', '#22d3ee'),
    item('Dr. Stone S4', 'Sci-Fi', 'EP 3', '8.6', '1080p', 'NEW', '#a3e635'),
]);

export const FALLBACK_DONGHUA = Object.freeze([
    item('Battle Through the Heavens', 'Donghua', 'Ongoing', '8.5', '1080p', 'ONGOING', '#ef4444', { format: 'DONGHUA', country: 'CN' }),
    item('Soul Land', 'Donghua', 'Ongoing', '8.8', '1080p', 'ONGOING', '#3b82f6', { format: 'DONGHUA', country: 'CN' }),
    item('Martial Universe', 'Donghua', 'Completed', '8.3', '1080p', 'HD', '#10b981', { format: 'DONGHUA', country: 'CN' }),
    item("The King's Avatar", 'Donghua', 'Completed', '8.7', '1080p', 'HD', '#f59e0b', { format: 'DONGHUA', country: 'CN' }),
    item('Stellar Transformations', 'Donghua', 'Ongoing', '8.4', '1080p', 'ONGOING', '#8b5cf6', { format: 'DONGHUA', country: 'CN' }),
    item('Coiling Dragon', 'Donghua', 'Ongoing', '8.2', '1080p', 'ONGOING', '#ec4899', { format: 'DONGHUA', country: 'CN' }),
]);

const KITSU = 'https://media.kitsu.app/anime';

/** 10 slide hero cadangan (deskripsi sama dengan file asli). */
export const FALLBACK_HERO = Object.freeze([
    createAnime({
        title: 'Solo Leveling Season 2', ids: { kitsu: '48671' }, year: 2025, latestEpisode: 13, status: 'ONGOING', score: 9.2,
        genres: ['Action', 'Fantasy', 'Adventure'],
        description: 'Sung Jinwoo melanjutkan perjalanannya sebagai Shadow Monarch. Dengan kekuatan yang semakin besar, ia menghadapi ancaman baru yang mengancam seluruh umat manusia.',
        image: `${KITSU}/48671/poster_image/large-6156a7475d03dbb788ab1a9ce6c7f962.jpeg`,
        banner: `${KITSU}/48671/cover_image/large-e4edb994223d3451a023d5dd8c64e0be.jpeg`,
    }),
    createAnime({
        title: 'Jujutsu Kaisen Season 3', ids: { kitsu: '42765' }, year: 2025, latestEpisode: 5, status: 'ONGOING', score: 9.1,
        genres: ['Action', 'Supernatural', 'School'],
        description: 'Pertempuran epic antara penyihir jujutsu dan kutukan berlanjut. Yuji Itadori dan teman-temannya menghadapi ancaman yang lebih berbahaya.',
        image: `${KITSU}/42765/poster_image/large-5ce19551c1a6cf995b378205b9149b5c.jpeg`,
        banner: `${KITSU}/cover_images/42765/large.jpg`,
    }),
    createAnime({
        title: "Frieren: Beyond Journey's End", ids: { kitsu: '46474' }, year: 2024, latestEpisode: 4, status: 'ONGOING', score: 9.4,
        genres: ['Fantasy', 'Adventure', 'Drama'],
        description: 'Kisah seorang elf mage yang memulai perjalanan baru setelah petualangan bersama para pahlawan berakhir.',
        image: `${KITSU}/46474/poster_image/large-ec9b98dd5fbf8f92532d1edb45f9e882.jpeg`,
        banner: `${KITSU}/46474/cover_image/large-167edf3e01fac59ce6aacfeb47df5634.jpeg`,
    }),
    createAnime({
        title: 'Attack on Titan: The Final Season', ids: { kitsu: '42422' }, year: 2023, status: 'COMPLETED', score: 9.5,
        genres: ['Action', 'Drama', 'Fantasy'],
        description: 'Pertempuran terakhir melawan Titan dan rahasia dunia akhirnya terungkap. Eren Yeager menghadapi pilihan yang akan mengubah segalanya.',
        image: `${KITSU}/poster_images/42422/large.jpg`,
        banner: `${KITSU}/cover_images/42422/large.jpg`,
    }),
    createAnime({
        title: 'Demon Slayer: Hashira Training Arc', ids: { kitsu: '47635' }, year: 2024, latestEpisode: 8, status: 'ONGOING', score: 9.3,
        genres: ['Action', 'Supernatural', 'Historical'],
        description: 'Tanjiro dan teman-temannya menjalani pelatihan intensif bersama para Hashira untuk menghadapi pertempuran terakhir.',
        image: `${KITSU}/47635/poster_image/large-4211877e3a64e0f5beacfaca550aae16.jpeg`,
        banner: `${KITSU}/47635/cover_image/large-81f8f53b9f4af4239e8a7923d4a8535e.jpeg`,
    }),
    createAnime({
        title: 'One Piece', ids: { kitsu: '12' }, year: 1999, latestEpisode: 1122, status: 'ONGOING', score: 9.0,
        genres: ['Adventure', 'Action', 'Comedy'],
        description: 'Petualangan Monkey D. Luffy dan kru Topi Jerami berlanjut dalam mencari harta karun legendaris One Piece.',
        image: `${KITSU}/poster_images/12/large.jpg`,
        banner: `${KITSU}/12/cover_image/large-3e72f400a87b5241780c5082f0582611.jpeg`,
    }),
    createAnime({
        title: 'Dandadan', ids: { kitsu: '48269' }, year: 2024, latestEpisode: 8, status: 'ONGOING', score: 8.8,
        genres: ['Action', 'Comedy', 'Supernatural'],
        description: 'Kisah unik tentang pertemuan antara pecinta alien dan pecinta hantu yang harus menghadapi fenomena supranatural.',
        image: `${KITSU}/48269/poster_image/large-589c017798b98c69e3a615ca4191f49d.jpeg`,
        banner: `${KITSU}/48269/cover_image/large-2a78bed2943524035cc0146c6633d1bf.jpeg`,
    }),
    createAnime({
        title: 'Blue Lock Season 2', ids: { kitsu: '47245' }, year: 2024, latestEpisode: 11, status: 'ONGOING', score: 8.5,
        genres: ['Sports', 'Drama'],
        description: 'Kompetisi sepak bola paling intens berlanjut. Siapa yang akan menjadi striker terbaik di Jepang?',
        image: `${KITSU}/47245/poster_image/large-553f0cd6fec3c4cd29b79940feca45f7.jpeg`,
        banner: null,
    }),
    createAnime({
        title: 'Chainsaw Man', ids: { kitsu: '43806' }, year: 2022, status: 'COMPLETED', score: 9.0,
        genres: ['Action', 'Supernatural', 'Horror'],
        description: 'Denji, pemuda yang bergabung dengan iblis chainsaw, bekerja sebagai pemburu iblis untuk melunasi hutangnya.',
        image: `${KITSU}/43806/poster_image/large-815d6008fb3b56f4291b9f0ffa05cd8f.jpeg`,
        banner: `${KITSU}/43806/cover_image/large-964674a0f11524f62d65dde845ad8e1f.jpeg`,
    }),
    createAnime({
        title: 'Spy x Family Season 3', ids: { kitsu: '45398' }, year: 2024, latestEpisode: 12, status: 'ONGOING', score: 8.9,
        genres: ['Action', 'Comedy', 'Slice of Life'],
        description: 'Keluarga Forger melanjutkan misi rahasia mereka. Loid, Yor, dan Anya menghadapi tantangan baru dalam kehidupan ganda mereka.',
        image: `${KITSU}/45398/poster_image/large-c26c1e0b77e881fcd66475af6bd22c57.jpeg`,
        banner: `${KITSU}/45398/cover_image/large-1e81255ff9bde22c072c555cc5998805.jpeg`,
    }),
]);

/**
 * Jadwal statis (sama dengan HTML asli). Kunci = Date#getDay() (0 = Minggu).
 * Bug lama: "Rabu ✨" di-hardcode sebagai hari ini. Sekarang hari ini dihitung.
 * Tahap B: diganti jadwal tayang asli (AniList airingSchedules), ini jadi cadangan.
 */
export const FALLBACK_SCHEDULE = Object.freeze({
    1: [['18:00', 'Solo Leveling S2'], ['20:00', 'One Piece']],
    2: [['17:00', 'Dandadan'], ['21:00', 'Blue Lock S2']],
    3: [['18:00', 'Jujutsu Kaisen'], ['19:30', 'Frieren'], ['22:00', 'Oshi no Ko S2']],
    4: [['17:30', 'My Hero Academia'], ['20:00', 'Chainsaw Man']],
    5: [['18:00', 'Spy x Family S3'], ['21:00', 'Demon Slayer']],
    6: [['16:00', 'Dragon Ball Daima'], ['19:00', 'Mushoku Tensei'], ['22:00', 'Vinland Saga']],
    0: [['10:00', 'Boruto: TBV'], ['17:00', 'Dr. Stone S4']],
});
