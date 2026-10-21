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
 */

const STATUSES = new Set(['ONGOING', 'COMPLETED', 'UPCOMING', 'UNKNOWN']);

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

    let id = p.id;
    if (!id) {
        if (ids.anilist) id = `anilist:${ids.anilist}`;
        else if (ids.mal) id = `mal:${ids.mal}`;
        else if (ids.kitsu) id = `kitsu:${ids.kitsu}`;
        else if (p.slug && source.startsWith('backend:')) id = `${source.slice(8)}:${p.slug}`;
        else id = `title:${slugify(title)}`;
    }

    return {
        id,
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
    };
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

/** Jumlah episode yang aman dipakai untuk membuat tombol episode. */
export function playableEpisodeCount(a) {
    return a.latestEpisode || a.episodes || null;
}
