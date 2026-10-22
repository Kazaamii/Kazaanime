/**
 * Kazanime backend — providers/match.js
 * Pencocokan judul anime (AniList/Kitsu di frontend) dengan entri di situs penyedia stream.
 * Dua tahap, sama seperti matchBackendItem di js/api/streams.js:
 *   1. kunci persis (huruf kecil + alfanumerik)
 *   2. kunci longgar: "2nd Season" = "Season 2" = "S2", tanpa kata sandang — ANGKA tetap harus
 *      sama, jadi season lain tidak ikut tercocokkan.
 * Tahun tayang (bila diketahui) dipakai sebagai pemutus seri.
 */
import { titleKey } from '../lib/text.js';

const ORDINAL = /\b(\d+)(?:st|nd|rd|th)\s+season\b/gi;
/** Angka Romawi penanda season ("Tensei Shitara Ken Deshita II" di AniZone). HANYA huruf kapital,
 *  supaya kata romaji biasa ("ii", "vi") tidak ikut berubah. */
const ROMAN = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
const ROMAN_RE = /(^|[\s:([-])(II|III|IV|VI|VII|VIII|IX|X|V)(?=$|[\s:)\]!?.,-])/g;
const ROMAN_CHARS = { 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6 };

export function looseKey(text) {
    return String(text || '')
        .replace(/[ⅡⅢⅣⅤⅥ]/g, (c) => ` ${ROMAN_CHARS[c]} `)
        .replace(ROMAN_RE, (m, pre, r) => `${pre}${ROMAN[r]}`)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(ORDINAL, 'season $1')
        .replace(/\b(?:season|s)\s*(\d+)\b/g, ' $1 ')
        .replace(/\b(?:the|a|an|no|wa|ga|wo|season|part|cour|tv|series)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, '');
}

/**
 * @template T
 * @param {T[]} candidates
 * @param {(c: T) => string[]} titlesOf judul-judul satu kandidat
 * @param {string[]} wanted judul yang dicari
 * @param {{year?: number|null, yearOf?: (c: T) => number|null}} [opts]
 * @returns {T|null}
 */
export function bestTitleMatch(candidates, titlesOf, wanted, { year = null, yearOf = () => null } = {}) {
    const strict = new Set(wanted.map(titleKey).filter(Boolean));
    const loose = new Set(wanted.map(looseKey).filter((k) => k.length >= 3));
    const score = (c) => {
        const ts = titlesOf(c).filter(Boolean);
        if (ts.some((t) => strict.has(titleKey(t)))) return 2;
        if (ts.some((t) => loose.has(looseKey(t)))) return 1;
        return 0;
    };
    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
        const s = score(c);
        if (!s) continue;
        const y = yearOf(c);
        const bonus = year && y && Number(y) === Number(year) ? 0.5 : 0;
        if (s + bonus > bestScore) {
            best = c;
            bestScore = s + bonus;
        }
    }
    return best;
}

/** Judul unik (maks n) untuk dipakai sebagai kata kunci pencarian. */
export function uniqueTitles(list, n = 4) {
    const seen = new Set();
    const out = [];
    for (const t of list) {
        const s = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        const k = titleKey(s);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(s);
        if (out.length >= n) break;
    }
    return out;
}
