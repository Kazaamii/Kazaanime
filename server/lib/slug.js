/**
 * Kazanime backend — lib/slug.js
 * Slug backend "self-describing": nama sumber + bagian path situs, dipisah "~".
 *   animexin~tales-of-demons-and-gods-season-10
 *   samehadaku~kusuriya-no-hitorigoto-season-3
 *
 * Kenapa: frontend hanya mengirim slug ke /api/anime/:slug (tanpa nama sumber),
 * dan routes.js di frontend hanya meloloskan [a-zA-Z0-9._~-] maks 160 karakter.
 * "~" tidak di-encode oleh encodeURIComponent dan tidak muncul di slug situs.
 */
const SEP = '~';
const MAX_LEN = 160;
const SOURCE_RE = /^[a-z][a-z0-9-]{1,30}$/;
const PART_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

/**
 * @param {string} source
 * @param {...(string|number)} parts
 * @returns {string|null} null bila ada bagian yang tidak valid / terlalu panjang
 */
export function encodeSlug(source, ...parts) {
    const p = parts.map((x) => String(x ?? '').trim());
    if (!SOURCE_RE.test(source) || !p.length || p.some((x) => !PART_RE.test(x))) return null;
    const slug = [source, ...p].join(SEP);
    return slug.length <= MAX_LEN ? slug : null;
}

/**
 * @param {unknown} slug
 * @returns {{source: string, parts: string[]}|null}
 */
export function decodeSlug(slug) {
    if (typeof slug !== 'string' || !slug || slug.length > MAX_LEN || !/^[a-zA-Z0-9._~-]+$/.test(slug)) return null;
    const [source, ...parts] = slug.split(SEP);
    const src = source.toLowerCase();
    if (!SOURCE_RE.test(src) || !parts.length || parts.some((x) => !PART_RE.test(x))) return null;
    return { source: src, parts };
}

/** Slug terakhir dari URL "https://situs/a/b/" → "b" (atau null). */
export function lastPathSegment(url) {
    try {
        const segs = new URL(url).pathname.split('/').filter(Boolean);
        return segs.length ? decodeURIComponent(segs[segs.length - 1]) : null;
    } catch {
        return null;
    }
}
