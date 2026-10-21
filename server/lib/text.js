/**
 * Kazanime backend — lib/text.js
 * Helper murni (tanpa I/O) untuk mengurai teks hasil scraping. Dipakai semua adapter
 * supaya hasilnya seragam: status, format, angka episode, URL, judul.
 */

/** Rapikan spasi. */
export const cleanText = (s) => String(s ?? '').replace(/[\s\u00a0]+/g, ' ').trim();

/** Potong teks ke n karakter. */
export const clip = (s, n) => {
    const t = cleanText(s);
    return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** "Shingeki no Kyojin: The Final Season" → "shingeki-no-kyojin-the-final-season" (sama dengan frontend). */
export function slugify(text) {
    return String(text || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

/** Kunci pembanding judul: huruf kecil + alfanumerik saja (sama dengan titleKey di frontend). */
export function titleKey(text) {
    return String(text || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

/** "Yi Nian Yong Heng [A Will Eternal]" → { main: "Yi Nian Yong Heng", alt: "A Will Eternal" } */
export function bracketParts(title) {
    const t = cleanText(title);
    const m = /^(.*?)\s*[[(]([^\])]+)[\])]\s*$/.exec(t);
    return m && m[1] ? { main: cleanText(m[1]), alt: cleanText(m[2]) } : { main: t, alt: '' };
}

/** Buang penanda season/part di akhir judul: "Swallowed Star Season 5" → "Swallowed Star". */
export function stripSeason(title) {
    return cleanText(String(title || '')
        .replace(/\s*[:\-–]?\s*\b(?:season|s)\s*\d+\s*$/i, '')
        .replace(/\s*\d+(?:st|nd|rd|th)\s+season\s*$/i, '')
        .replace(/\s*(?:part|cour)\s*\d+\s*$/i, '')
        .replace(/\s+\d{1,2}\s*$/, ''));
}

/** URL absolut http(s) dari href (mendukung "//host/path" & path relatif). '' bila tidak valid. */
export function absoluteUrl(href, base) {
    const raw = cleanText(href);
    if (!raw || /^(javascript|data|mailto|tel|about|blob):/i.test(raw)) return '';
    try {
        const u = new URL(raw.startsWith('//') ? `https:${raw}` : raw, base);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
    } catch {
        return '';
    }
}

/** Angka bulat pertama dalam teks, atau null. */
export function firstInt(text) {
    const m = /\d+/.exec(String(text ?? ''));
    return m ? Number.parseInt(m[0], 10) : null;
}

/**
 * Nomor episode dari label: "Episode 34 [466]" → 34 · "34 [466]" → 34 · "Ep 5 / 12" → 5.
 * Episode pecahan ("10.5", spesial) → null supaya tidak bentrok dengan episode 10.
 */
export function parseEpisodeNumber(text) {
    const s = cleanText(text);
    const m = /(?:episode|eps?\.?)\s*(\d+)([.,]\d+)?/i.exec(s) || /^(\d+)([.,]\d+)?/.exec(s);
    if (!m || m[2]) return null;
    const n = Number.parseInt(m[1], 10);
    return n >= 1 && n <= 5000 ? n : null;
}

/** "Ep 5 / 12" → 12 · "Ep 5 / ?" → null */
export function parseTotalEpisodes(text) {
    const m = /\/\s*(\d+)/.exec(String(text || ''));
    return m ? Number.parseInt(m[1], 10) : null;
}

/** Status dalam bahasa apa pun → ONGOING | COMPLETED | UPCOMING | UNKNOWN (sama dengan frontend). */
export function parseStatus(text) {
    const s = cleanText(text).toLowerCase();
    if (!s) return 'UNKNOWN';
    if (/upcoming|not yet|belum tayang|coming soon|\btba\b|segera/.test(s)) return 'UPCOMING';
    if (/ongoing|on-going|airing|sedang tayang|currently|berlangsung|current/.test(s)) return 'ONGOING';
    if (/complete|finished|tamat|selesai|ended|end\b/.test(s)) return 'COMPLETED';
    return 'UNKNOWN';
}

/** Situs kadang menulis "Upcoming" padahal episode sudah ada → anggap sedang tayang. */
export function fixStatus(status, latestEpisode) {
    return status === 'UPCOMING' && latestEpisode > 0 ? 'ONGOING' : status;
}

/** "ONA" / "Movie" / "TV Series" → TV | MOVIE | ONA | OVA | SPECIAL | MUSIC | '' */
export function parseFormat(text) {
    const s = cleanText(text).toLowerCase();
    if (!s) return '';
    if (/movie|film/.test(s)) return 'MOVIE';
    if (/\bona\b/.test(s)) return 'ONA';
    if (/\bova\b|\boad\b/.test(s)) return 'OVA';
    if (/special|\bsp\b/.test(s)) return 'SPECIAL';
    if (/music/.test(s)) return 'MUSIC';
    if (/\btv\b|series/.test(s)) return 'TV';
    return '';
}

/** "China" → CN · "Japan"/"Jepang" → JP · "Korea" → KR */
export function parseCountry(text) {
    const s = cleanText(text).toLowerCase();
    if (/china|chinese|tiongkok|cina|\bcn\b/.test(s)) return 'CN';
    if (/japan|jepang|\bjp\b/.test(s)) return 'JP';
    if (/korea|\bkr\b/.test(s)) return 'KR';
    return null;
}

/** Tahun 4 digit pertama yang masuk akal. */
export function parseYear(text) {
    const m = /\b(19[6-9]\d|20\d{2})\b/.exec(String(text || ''));
    return m ? Number.parseInt(m[1], 10) : null;
}

/** "8 Minute" / "24 min. per ep" / "1 hr. 30 min." / "23 menit" → menit. */
export function parseDurationMinutes(text) {
    const s = cleanText(text).toLowerCase();
    if (!s) return null;
    const h = /(\d+)\s*(?:hr|hour|jam)/.exec(s);
    const m = /(\d+)\s*(?:min|menit|mnt|m\b)/.exec(s);
    const total = (h ? Number.parseInt(h[1], 10) * 60 : 0) + (m ? Number.parseInt(m[1], 10) : 0);
    if (total) return total;
    const n = firstInt(s);
    return n && n < 400 ? n : null;
}

/** Skor ke skala 0–10 ("Rating 8.50" → 8.5; "85" → 8.5). 0 / kosong → null. */
export function parseScore10(text) {
    const m = /(\d+(?:[.,]\d+)?)/.exec(String(text ?? ''));
    if (!m) return null;
    let n = Number.parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n > 10) n /= 10;
    return n > 10 ? null : Math.round(n * 100) / 100;
}

/** Kualitas video: "1080" → "1080p" · "720P" → "720p" · "4K" → "4K". */
export function normalizeQuality(text) {
    const s = cleanText(text);
    const m = /(2160|1440|1080|720|540|480|360|240)\s*p?/i.exec(s);
    if (m) return `${m[1]}p`;
    if (/4k/i.test(s)) return '4K';
    return clip(s, 12);
}

/** base64 → teks UTF-8 ('' bila bukan base64 valid). */
export function decodeBase64(value) {
    const s = String(value || '').trim();
    if (!s || s.length > 20000 || !/^[A-Za-z0-9+/=\s_-]+$/.test(s)) return '';
    try {
        return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch {
        return '';
    }
}

/** Domain donasi/membership yang bukan link download. */
const DONATION_HOSTS = /(^|\.)(ko-fi\.com|trakteer\.id|saweria\.co|patreon\.com|buymeacoffee\.com|sociabuzz\.com|paypal\.me|teespring\.com)$/i;

export function isDonationUrl(url) {
    try {
        return DONATION_HOSTS.test(new URL(url).hostname);
    } catch {
        return true;
    }
}
