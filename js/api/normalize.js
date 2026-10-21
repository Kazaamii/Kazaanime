/**
 * Kazanime — api/normalize.js
 * KONTRAK FORMAT DATA. Semua sumber (AniList, Jikan/MAL, Kitsu, backend scraper,
 * data fallback) WAJIB diubah ke bentuk `Anime` di bawah lewat createAnime().
 * UI hanya mengenal bentuk ini — tidak pernah melihat respons mentah API.
 *
 * Di file asli ada 3 bentuk berbeda (raw AniList, hasil searchCombined, donghua)
 * dengan skor 0–100 vs "8.5" (string) vs 'N/A', genre array vs string, dst.
 *
 * @typedef {'ONGOING'|'COMPLETED'|'UPCOMING'|'UNKNOWN'} AnimeStatus
 *
 * @typedef {Object} Anime
 * @property {string}      id             Kunci stabil & unik: "anilist:154587", "mal:52991",
 *                                        "kitsu:46474", "animexin:<slug>", "title:<slug-judul>"
 * @property {string}      title          Judul utama (English → Romaji → apa pun)
 * @property {string}      titleAlt       Judul alternatif (romaji/native), '' jika tidak ada
 * @property {string|null} image          Poster potret (2:3)
 * @property {string|null} banner         Gambar lebar untuk hero (boleh null)
 * @property {string}      description    Sinopsis teks polos (tanpa HTML)
 * @property {number|null} episodes       Total episode (null = belum diketahui / masih tayang)
 * @property {number|null} latestEpisode  Episode terbaru yang sudah rilis (khusus ongoing)
 * @property {string[]}    genres
 * @property {number|null} score          Skala 0–10, 1 desimal (null = belum ada)
 * @property {AnimeStatus} status
 * @property {string}      format         TV | MOVIE | OVA | ONA | SPECIAL | MUSIC | DONGHUA
 * @property {number|null} year
 * @property {number|null} popularity     Angka relatif dari sumber (untuk sorting)
 * @property {string|null} country        'JP' | 'CN' | 'KR' | null
 * @property {{anilist:number|null, mal:number|null, kitsu:string|null}} ids
 * @property {string|null} slug           Slug di situs sumber (dipakai backend scraper)
 * @property {string}      source         'anilist' | 'mal' | 'kitsu' | 'backend:<nama>' | 'fallback'
 * @property {string|null} badge          (opsional) override label badge kartu
 * @property {string|null} quality        (opsional) override label kualitas kartu
 * @property {string|null} color          (opsional) warna placeholder bila gambar kosong
 *
 * Field detail (Tahap C, terisi di halaman nonton; di daftar biasanya kosong):
 * @property {string[]}    studios        Studio utama
 * @property {number|null} duration       Menit per episode
 * @property {'WINTER'|'SPRING'|'SUMMER'|'FALL'|null} season
 * @property {{episode:number|null, airingAt:number}|null} nextAiring  Episode berikutnya (airingAt = detik UNIX)
 * @property {number|null} firstAiredAt   Perkiraan waktu episode 1 tersedia (detik UNIX) dari tanggal mulai
 *                                        tayang (Kitsu/Jikan) — dasar perkiraan jumlah episode anime ongoing
 *                                        bila sumber tidak memberi jadwal episode (mis. AniList sedang mati)
 */

const STATUSES = new Set(['ONGOING', 'COMPLETED', 'UPCOMING', 'UNKNOWN']);
const SEASONS = new Set(['WINTER', 'SPRING', 'SUMMER', 'FALL']);

const toInt = (v) => {
    const n = typeof v === 'string' ? Number.parseInt(v, 10) : v;
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

/** Normalisasi skor dari skala apa pun ke 0–10 (1 desimal). */
export function toScore10(value, scale = 10) {
    const n = typeof value === 'string' ? Number.parseFloat(value) : value;
    if (!Number.isFinite(n) || n <= 0) return null;
    const s = (n / scale) * 10;
    return Math.round(Math.min(s, 10) * 10) / 10;
}

/** Hapus tag HTML & entity umum (sinopsis AniList berisi <br>, <i>, dll). */
export function stripHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Slug sederhana dari judul (untuk id fallback & pencocokan). */
export function slugify(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

/** Kunci pembanding judul (dedupe lintas sumber). */
export function titleKey(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Semua varian satu judul untuk dicocokkan lintas situs.
 * AnimeXin menulis "Yi Nian Yong Heng [A Will Eternal]" (pinyin [Inggris]), Kuramanime
 * "Black Clover 2nd Season (Black Clover Season 2)" → judul lengkap + bagian luar + bagian dalam kurung.
 * @param {string} text
 * @returns {string[]}
 */
export function titleVariants(text) {
    const full = String(text || '').replace(/\s+/g, ' ').trim();
    if (!full) return [];
    const out = [full];
    const m = /^(.*?)\s*[[(]([^\])]+)[\])]\s*$/.exec(full);
    if (m) out.push(m[1].trim(), m[2].trim());
    return [...new Set(out.filter(Boolean))];
}

const ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

/**
 * Kunci judul "longgar": penulisan season disamakan ("3rd Season" = "Season 3" = "S3",
 * "Season 1" = tanpa season), kata sandang & tanda baca diabaikan. Nomor season tetap
 * dibandingkan (season berbeda = anime berbeda). '' bila terlalu pendek untuk dipercaya.
 * @param {string} text
 * @returns {string}
 */
export function looseTitleKey(text) {
    let s = ` ${String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')} `;
    s = s
        .replace(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/g, ' s$1 ')
        .replace(/\bseason\s+(\d{1,2})\b/g, ' s$1 ')
        .replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b/g, (_, w) => ` s${ORDINAL_WORDS[w]} `)
        .replace(/\bs0*1\b/g, ' ')
        .replace(/\b(?:the|a|an)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, '');
    return s.length >= 4 ? s : '';
}

/**
 * Hanya terima URL http(s) absolut (data scraping / config bisa berisi javascript:, data:, dll).
 * @returns {string} URL yang sudah dinormalisasi, atau '' bila tidak aman
 */
export function toHttpUrl(url) {
    if (!url || typeof url !== 'string') return '';
    try {
        const u = new URL(url);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
    } catch {
        return '';
    }
}

/** Origin dari URL (mis. "https://contoh.com"), '' bila tidak valid. */
export function originOf(url) {
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
}

/** Waktu tayang berikutnya → { episode, airingAt } atau null. */
function toNextAiring(v) {
    if (!v || typeof v !== 'object') return null;
    const at = Number(v.airingAt);
    if (!Number.isFinite(at) || at <= 0) return null;
    return { episode: toInt(v.episode), airingAt: Math.trunc(at) };
}

/** Aturan id: ID sumber metadata dulu (AniList → MAL → Kitsu), lalu slug backend, lalu judul. */
function computeId(ids, { slug, source = '', title = '' } = {}) {
    if (ids.anilist) return `anilist:${ids.anilist}`;
    if (ids.mal) return `mal:${ids.mal}`;
    if (ids.kitsu) return `kitsu:${ids.kitsu}`;
    if (slug && source.startsWith('backend:')) return `${source.slice(8)}:${slug}`;
    return `title:${slugify(title)}`;
}

/**
 * Pabrik objek Anime. Semua field selalu ada dengan tipe yang benar,
 * jadi UI tidak perlu cek `?.` / `|| 'N/A'` di mana-mana.
 * @param {Partial<Anime> & {ids?: Partial<Anime['ids']>}} p
 * @returns {Anime}
 */
export function createAnime(p = {}) {
    const ids = {
        anilist: toInt(p.ids?.anilist),
        mal: toInt(p.ids?.mal),
        kitsu: p.ids?.kitsu != null && p.ids.kitsu !== '' ? String(p.ids.kitsu) : null,
    };
    const title = String(p.title || p.titleAlt || 'Tanpa Judul').trim();
    const source = p.source || 'fallback';
    const status = STATUSES.has(p.status) ? p.status : 'UNKNOWN';
    const score = typeof p.score === 'number' && Number.isFinite(p.score) ? Math.round(p.score * 10) / 10 : null;
    const season = String(p.season || '').toUpperCase();

    return {
        id: p.id || computeId(ids, { slug: p.slug, source, title }),
        title,
        titleAlt: String(p.titleAlt || '').trim(),
        image: p.image || null,
        banner: p.banner || null,
        description: stripHtml(p.description),
        episodes: toInt(p.episodes),
        latestEpisode: toInt(p.latestEpisode),
        genres: Array.isArray(p.genres) ? p.genres.filter(Boolean).map(String) : [],
        score,
        status,
        format: String(p.format || 'TV').toUpperCase(),
        year: toInt(p.year),
        popularity: Number.isFinite(p.popularity) ? p.popularity : null,
        country: p.country || null,
        ids,
        slug: p.slug || null,
        source,
        badge: p.badge || null,
        quality: p.quality || null,
        color: p.color || null,
        studios: Array.isArray(p.studios) ? p.studios.filter(Boolean).map(String) : [],
        duration: toInt(p.duration),
        season: SEASONS.has(season) ? season : null,
        nextAiring: toNextAiring(p.nextAiring),
        firstAiredAt: toInt(p.firstAiredAt),
    };
}

/**
 * Lengkapi ID yang KOSONG dengan ID lain (mis. dari URL atau mapping Kitsu),
 * lalu hitung ulang `id` dengan aturan yang sama seperti createAnime().
 * ID yang sudah ada tidak ditimpa.
 * @param {Anime} anime
 * @param {Partial<Anime['ids']>} extra
 * @returns {Anime}
 */
export function withIds(anime, extra = {}) {
    const ids = {
        anilist: anime.ids?.anilist || toInt(extra.anilist),
        mal: anime.ids?.mal || toInt(extra.mal),
        kitsu: anime.ids?.kitsu || (extra.kitsu != null && extra.kitsu !== '' ? String(extra.kitsu) : null),
    };
    return { ...anime, ids, id: computeId(ids, { slug: anime.slug, source: anime.source, title: anime.title }) };
}

/**
 * Apakah dua entri mewakili anime yang sama? (dipakai bookmark & riwayat tontonan)
 * ID sejenis yang sama-sama ada = penentu. Judul hanya dipakai bila tidak ada ID
 * yang bisa dibandingkan (mis. data lama, atau hasil Kitsu vs AniList).
 * @param {{id?:string, title?:string, ids?:object}} stored
 * @param {Anime} anime
 */
export function isSameAnime(stored, anime) {
    const a = stored?.ids || {};
    const b = anime?.ids || {};
    if (a.anilist && b.anilist) return Number(a.anilist) === Number(b.anilist);
    if (a.mal && b.mal) return Number(a.mal) === Number(b.mal);
    if (a.kitsu && b.kitsu) return String(a.kitsu) === String(b.kitsu);
    if (stored?.id && anime?.id && stored.id === anime.id) return true;
    const key = titleKey(stored?.title);
    return Boolean(key) && (key === titleKey(anime?.title) || key === titleKey(anime?.titleAlt));
}

/* ------------------------------------------------------------------ */
/* Helper label untuk UI (satu tempat, konsisten di semua halaman)    */
/* ------------------------------------------------------------------ */

/** "EP 12" / "Ongoing" / "Completed" / "Segera" — perilaku sama seperti file asli. */
export function episodeLabel(a) {
    if (a.latestEpisode) return `EP ${a.latestEpisode}`;
    if (a.episodes) return `EP ${a.episodes}`;
    if (a.status === 'ONGOING') return 'Ongoing';
    if (a.status === 'UPCOMING') return 'Segera';
    // Status tidak diketahui (mis. rekomendasi MAL yang hanya berisi judul + gambar):
    // jangan mengaku "Completed".
    if (a.status === 'UNKNOWN') return '';
    return 'Completed';
}

/** "8.7" atau "N/A". */
export function scoreLabel(a) {
    return a.score != null ? a.score.toFixed(1) : 'N/A';
}

/** Badge default kartu: ONGOING untuk yang tayang, HD untuk lainnya (sama seperti asli). */
export function statusBadge(a) {
    if (a.badge) return a.badge;
    if (a.status === 'ONGOING') return 'ONGOING';
    if (a.status === 'UPCOMING') return 'SOON';
    return 'HD';
}

/** Label status berbahasa Indonesia untuk halaman detail. */
export function statusLabel(a) {
    return { ONGOING: 'Sedang Tayang', COMPLETED: 'Tamat', UPCOMING: 'Segera Tayang', UNKNOWN: 'Status ?' }[a.status];
}

const FORMAT_LABELS = { TV: 'TV', MOVIE: 'Movie', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Special', MUSIC: 'Music', DONGHUA: 'Donghua' };
/** "TV" / "Movie" / "Special" ... */
export function formatLabel(a) {
    return FORMAT_LABELS[a.format] || a.format || 'TV';
}

const SEASON_LABELS = { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' };
/** "Fall 2026" / "2026" / "". */
export function seasonLabel(a) {
    return [SEASON_LABELS[a.season], a.year].filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/* Perkiraan jadwal tayang mingguan                                    */
/* ------------------------------------------------------------------ */
const DAY_SEC = 86400;
const WEEK_SEC = 7 * DAY_SEC;
const JST_OFFSET_SEC = 9 * 3600;
/** Jeda dari siaran Jepang sampai episode biasanya sudah ada (ber-subtitle) di server embed. */
const RELEASE_LAG_SEC = 2 * 3600;
/** Jam siaran tidak diketahui → episode dianggap ada keesokan harinya pukul 06:00 JST (konservatif). */
const UNKNOWN_TIME_OFFSET_SEC = 30 * 3600;
/** Perkiraan mingguan hanya dipercaya sampai ±2 cour; anime panjang sering libur sehingga meleset. */
const ESTIMATE_MAX_EPISODES = 26;
const BROADCAST_DAYS = { sundays: 0, mondays: 1, tuesdays: 2, wednesdays: 3, thursdays: 4, fridays: 5, saturdays: 6 };

/**
 * Perkiraan waktu episode 1 tersedia (detik UNIX) dari tanggal mulai tayang di Jepang.
 * @param {string|null|undefined} date  'YYYY-MM-DD…' (tanggal JST: Kitsu startDate / Jikan aired.from)
 * @param {{day?: string|null, time?: string|null, timezone?: string|null}|null} [broadcast]  jadwal siaran MAL
 * @returns {number|null}
 */
export function firstAiringAt(date, broadcast = null) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
    if (!m) return null;
    let midnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000 - JST_OFFSET_SEC; // 00:00 JST
    if (!Number.isFinite(midnight)) return null;
    const t = /^(\d{1,2}):(\d{2})$/.exec(String(broadcast?.time || ''));
    const tz = broadcast?.timezone;
    if (!t || (tz && tz !== 'Asia/Tokyo')) return midnight + UNKNOWN_TIME_OFFSET_SEC;
    // Siaran lewat tengah malam: MAL menulis "Saturdays at 01:00" padahal tanggal mulainya hari Jumat.
    const want = BROADCAST_DAYS[String(broadcast.day || '').toLowerCase()];
    const have = new Date((midnight + JST_OFFSET_SEC) * 1000).getUTCDay();
    if (want !== undefined && (want - have + 7) % 7 === 1) midnight += DAY_SEC;
    return midnight + Number(t[1]) * 3600 + Number(t[2]) * 60 + RELEASE_LAG_SEC;
}

/**
 * Perkiraan jumlah episode yang sudah tersedia, dengan asumsi tayang mingguan sejak firstAiredAt
 * (dibatasi total episode). null = tidak bisa diperkirakan dengan aman (tanpa tanggal mulai,
 * belum mulai, atau anime panjang > ESTIMATE_MAX_EPISODES minggu tanpa total episode).
 * @param {Anime} a
 * @param {number} [now] waktu sekarang (ms)
 * @returns {number|null}
 */
export function estimateAiredEpisodes(a, now = Date.now()) {
    const start = a?.firstAiredAt;
    if (!start) return null;
    const elapsed = Math.floor(now / 1000) - start;
    if (elapsed < 0) return null;
    const n = Math.floor(elapsed / WEEK_SEC) + 1;
    const total = a.episodes || null;
    if (n > ESTIMATE_MAX_EPISODES) return total && total <= ESTIMATE_MAX_EPISODES ? total : null;
    return total ? Math.min(n, total) : n;
}

/**
 * Jumlah episode yang SUDAH tayang (dasar tombol episode di watch.html).
 *  - 0    → belum tayang sama sekali
 *  - null → tidak diketahui (watch.html menampilkan input nomor episode manual)
 * Total episode milik anime yang masih tayang TIDAK dipakai (episode-episode itu belum ada).
 * Anime ongoing: angka dari sumber (episode terbaru / episode berikutnya − 1) digabung perkiraan
 * jadwal mingguan (estimateAiredEpisodes) — yang terbesar dipakai, karena daftar episode MAL
 * sering tertinggal untuk season baru dan Kitsu tidak memberi nomor episode sama sekali.
 * @param {Anime} a
 * @param {number} [now] waktu sekarang (ms)
 */
export function airedEpisodeCount(a, now = Date.now()) {
    if (a.status === 'UPCOMING') return 0;
    let known = null;
    if (a.latestEpisode) known = a.latestEpisode;
    else if (a.nextAiring?.episode) known = Math.max(0, a.nextAiring.episode - 1);
    if (a.status !== 'ONGOING') return known ?? (a.episodes || null);
    const estimate = estimateAiredEpisodes(a, now);
    if (known == null) return estimate;
    return estimate ? Math.max(known, estimate) : known;
}

/** Nama sumber data untuk keterangan di UI. */
export const SOURCE_LABELS = Object.freeze({
    anilist: 'AniList',
    mal: 'MyAnimeList',
    jikan: 'MyAnimeList',
    kitsu: 'Kitsu',
    backend: 'Backend',
    fallback: 'data cadangan',
});

/** "AniList" / "MyAnimeList" / "animexin" / ... */
export function sourceLabel(source) {
    if (!source) return '—';
    if (source.startsWith('backend:')) return source.slice('backend:'.length);
    return SOURCE_LABELS[source] || source;
}
