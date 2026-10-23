/**
 * Kazanime — source downloads/kusonime.js
 * Pencarian paket unduhan Kusonime berdasarkan judul Romaji; bukan katalog/player.
 *
 * Selector dan pola WordPress diamati dari scraper publik MIT:
 * https://github.com/Zmy71/Kusonime-Scraper/tree/8f8e7098f1161d6451471f5c28bdf32fa29aad49
 * Implementasi di sini ditulis ulang; URL mirror tidak di-resolve/decode dan tidak di-fetch.
 * Live markup, robots.txt, dan ToS Kusonime belum diverifikasi. Karena ToS unknown, setiap
 * akses halaman tetap wajib lolos robots.txt eksplisit; blokir/challenge langsung dihormati.
 */
import { absoluteUrl, bracketParts, cleanText, normalizeQuality, titleKey } from '../lib/text.js';

export const ID = 'kusonime-downloads';
export const NAME = 'Kusonime downloads';

export const POLICY = Object.freeze({
    robots: true,
    tos: Object.freeze({
        url: null,
        reviewedAt: null,
        verdict: 'unknown',
        note: 'ToS dan robots.txt belum diverifikasi live. Setiap halaman hanya boleh diakses bila robots.txt terbaca dan secara eksplisit mengizinkan.',
    }),
});

function titleKeys(value) {
    const title = cleanText(value);
    const parts = bracketParts(title);
    return [title, parts.main, parts.alt].map(titleKey).filter(Boolean);
}

function matchesTitle(value, expectedKeys) {
    return titleKeys(value).some((key) => expectedKeys.has(key));
}

function sameSiteUrl(href, base) {
    const url = absoluteUrl(href, base);
    if (!url) return '';
    try {
        const parsed = new URL(url);
        const origin = new URL(base).origin;
        return parsed.protocol === 'https:' && parsed.origin === origin && !parsed.username && !parsed.password
            ? parsed.href
            : '';
    } catch {
        return '';
    }
}

function publicHttpUrl(href, base) {
    const value = absoluteUrl(href, base);
    if (!value) return '';
    try {
        const url = new URL(value);
        return !url.username && !url.password ? url.href : '';
    } catch {
        return '';
    }
}

/**
 * Search cards observed as `div.detpost` with `h2.episodeye a` or `div.content h2 a`.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} base
 */
export function parseKusonimeSearch($, base) {
    const out = [];
    const seen = new Set();
    $('div.detpost').each((_, el) => {
        const card = $(el);
        const link = card.find('h2.episodeye a, div.content h2 a').first();
        const title = cleanText(link.text());
        const url = sameSiteUrl(link.attr('href'), base);
        if (!title || !url || seen.has(url)) return;
        seen.add(url);
        out.push({ title, url });
    });
    return out;
}

/**
 * Read groups from `div.dlbodz > div.smokeddlrh > div.smokeurlrh`.
 * External mirror URLs are returned exactly as public hrefs; nothing is fetched, followed,
 * base64-decoded, or guessed here.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} base
 * @param {string[]} expectedTitles
 */
export function parseKusonimeDownloads($, base, expectedTitles = []) {
    const title = cleanText($('h1.jdlz').first().text() || $('h1').first().text());
    const expected = new Set(expectedTitles.flatMap(titleKeys));
    if (!title || !expected.size || !matchesTitle(title, expected)) return null;

    const downloads = [];
    $('.dlbodz').first().find('.smokeddlrh .smokeurlrh').each((_, el) => {
        const row = $(el);
        const label = cleanText(row.find('strong').first().text());
        const quality = normalizeQuality(label) || label.slice(0, 40) || 'Download';
        const format = (/(?:^|\b)(MKV|MP4|WEBM|AVI)(?:\b|$)/i.exec(label) || [])[1]?.toUpperCase() || 'Tidak diketahui';
        const links = [];
        const seen = new Set();
        row.find('a[href]').each((__, a) => {
            const link = $(a);
            const url = publicHttpUrl(link.attr('href'), base);
            if (!url || seen.has(url)) return;
            seen.add(url);
            links.push({ provider: cleanText(link.text()).slice(0, 30) || 'Link', url });
        });
        if (links.length) {
            downloads.push({ quality, size: '', format, subtitle: 'Tidak diketahui', links: links.slice(0, 12) });
        }
    });
    return { matchedTitle: title, downloads };
}

function cleanTitleCandidates(titles) {
    const seen = new Set();
    return (Array.isArray(titles) ? titles : [titles])
        .map((value) => cleanText(value).slice(0, 100))
        .filter((value) => {
            const key = titleKey(value);
            if (value.length < 2 || !/\p{Script=Latin}/u.test(value)
                || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
                || !key || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 4);
}

/** Create a small, robots-gated downloader used only by the watch-page download section. */
export function createKusonimeDownloader({ network, createClient, baseUrl = 'https://kusonime.com' } = {}) {
    let base;
    try {
        const parsed = new URL(String(baseUrl || 'https://kusonime.com'));
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) throw new Error('invalid base');
        base = parsed.origin;
    } catch {
        throw new TypeError('KUSONIME_BASE_URL harus berupa origin HTTPS yang valid.');
    }
    const host = new URL(base).hostname;
    const client = createClient(network, {
        source: ID,
        allowedHosts: [host],
        requireExplicitRobots: true,
        blockedMs: 30 * 60 * 1000,
        renderJavaScript: false,
    });

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        policy: POLICY,

        async findDownloads(titles, ctx = {}) {
            const queries = cleanTitleCandidates(titles);
            if (!queries.length) return { query: '', matchedTitle: '', downloads: [] };
            const expectedKeys = new Set(queries.flatMap(titleKeys));

            for (const query of queries) {
                const searchUrl = new URL('/', base);
                searchUrl.searchParams.set('s', query);
                const page = await client.html(searchUrl.href, ctx);
                const candidate = parseKusonimeSearch(page.$, base)
                    .find((item) => matchesTitle(item.title, expectedKeys));
                if (!candidate) continue;

                const detail = await client.html(candidate.url, ctx);
                const parsed = parseKusonimeDownloads(detail.$, base, queries);
                if (parsed) return { query, ...parsed };
            }
            return { query: queries[0], matchedTitle: '', downloads: [] };
        },
    };
}
