/**
 * Kazanime — source adapter for AnimeIndo.
 *
 * Read-only metadata + episode-list adapter. It may read the observed same-origin
 * public JSON configuration endpoint, but forwards only explicitly typed HTTPS
 * embed/player pages. It never calls third-party resolvers or asks them for direct media.
 * AnimeIndo is opt-in until its current robots/terms policy has been independently checked.
 */
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import { absoluteUrl, cleanText, firstInt, parseDurationMinutes, parseStatus, parseYear } from '../lib/text.js';

export const ID = 'animeindo';
export const NAME = 'AnimeIndo';

export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'unknown',
    tos: Object.freeze({
        url: null,
        reviewedAt: '2026-10-23',
        verdict: 'unknown',
        note: 'ToS belum diverifikasi independen. Adapter opt-in; robots.txt harus terbaca dan mengizinkan setiap request.',
    }),
});

const DEFAULT_BASE = 'https://animeindo.cloud';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,118}$/;
const EPISODE_PATH_RE = /^\/nonton\/([a-z0-9][a-z0-9-]{0,118})\/([a-z0-9][a-z0-9-]{0,118})\/?$/i;
const LABEL_ALIASES = new Map([
    ['genre', 'genres'], ['genres', 'genres'], ['genre anime', 'genres'],
    ['studio', 'studios'], ['studios', 'studios'],
    ['status', 'status'], ['durasi', 'duration'], ['duration', 'duration'],
    ['episode', 'episodes'], ['episodes', 'episodes'], ['total episode', 'episodes'],
    ['jumlah episode', 'episodes'], ['tahun', 'year'], ['year', 'year'],
    ['rilis', 'year'], ['released', 'year'], ['tipe', 'format'], ['type', 'format'],
]);

export function parseEpisodeRef(url, base = DEFAULT_BASE) {
    try {
        const target = new URL(url, base);
        if (target.origin !== new URL(base).origin || !/^https?:$/.test(target.protocol)) return null;
        const match = EPISODE_PATH_RE.exec(target.pathname);
        if (!match) return null;
        return { seriesSlug: match[1].toLowerCase(), episodeSlug: match[2].toLowerCase(), url: target.href };
    } catch {
        return null;
    }
}

export function parseEpisodeNumber(value) {
    const match = /(?:episode|ep)[\s._-]*(\d{1,4})(?!\d)/i.exec(String(value || ''));
    if (!match) return null;
    const number = Number.parseInt(match[1], 10);
    return Number.isInteger(number) && number > 0 && number <= 5000 ? number : null;
}

function firstNonEmpty(...values) {
    return values.map((value) => cleanText(value)).find(Boolean) || '';
}

function metaContent($, selectors) {
    for (const selector of selectors) {
        const value = $(selector).first().attr('content');
        if (value) return cleanText(value);
    }
    return '';
}

function cleanAnimeTitle(value) {
    return cleanText(value)
        .replace(/^\s*nonton\s+/i, '')
        .replace(/\s*[|–—]\s*(?:animeindo|anime indo|subtitle indonesia|sub indo).*$/i, '')
        .replace(/\s*[-|–—]?\s*(?:episode|ep)[\s._-]*\d{1,4}\b.*$/i, '')
        .replace(/\s+(?:sub(?:title)?\s*indo(?:nesia)?|subtitle indonesia)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

function labelMap($) {
    const out = {};
    $('li, p, tr, dd, .info-item, .detail-item, .anime-info, .anime-detail, .meta-item').each((_, element) => {
        const node = $(element);
        const text = cleanText(node.text());
        if (!text || text.length > 260) return;
        const match = /^([^:：]{2,32})\s*[:：]\s*(.+)$/.exec(text);
        if (!match) return;
        const label = LABEL_ALIASES.get(cleanText(match[1]).toLowerCase());
        if (!label || out[label]) return;
        const links = node.find('a').map((__, a) => cleanText($(a).text())).get().filter(Boolean);
        out[label] = { text: cleanText(match[2]), links };
    });

    $('span, strong, b, dt, th').each((_, element) => {
        const labelText = cleanText($(element).text()).replace(/[:：]\s*$/, '').toLowerCase();
        const label = LABEL_ALIASES.get(labelText);
        if (!label || out[label]) return;
        const sibling = $(element).next();
        const value = cleanText(sibling.text());
        if (value) {
            out[label] = {
                text: value,
                links: sibling.find('a').map((__, a) => cleanText($(a).text())).get().filter(Boolean),
            };
        }
    });
    return out;
}

function splitValues(value) {
    return [...new Set(String(value || '').split(/[,、|/]+/).map((item) => cleanText(item)).filter(Boolean))].slice(0, 12);
}

function embeddedStructuredData($) {
    const rows = [];
    $('script[type="application/ld+json"]').each((_, node) => {
        try {
            const value = JSON.parse($(node).text() || 'null');
            for (const item of (Array.isArray(value) ? value : [value])) {
                if (item && typeof item === 'object') rows.push(item);
                if (Array.isArray(item?.['@graph'])) rows.push(...item['@graph'].filter((x) => x && typeof x === 'object'));
            }
        } catch {
            // Malformed optional JSON-LD is not a fatal parse error.
        }
    });
    return rows;
}

function parseEpisodes($, base, ref, currentTitle) {
    const byNumber = new Map();
    $('a[href]').each((_, element) => {
        const anchor = $(element);
        const href = absoluteUrl(anchor.attr('href'), base);
        const parsed = href ? parseEpisodeRef(href, base) : null;
        if (!parsed || parsed.seriesSlug !== ref.seriesSlug) return;
        const number = parseEpisodeNumber(parsed.episodeSlug + ' ' + anchor.text());
        if (!number) return;
        const title = firstNonEmpty(anchor.attr('title'), anchor.text(), 'Episode ' + number);
        if (!byNumber.has(number)) byNumber.set(number, { number, title: title.slice(0, 160), url: parsed.url });
    });

    const currentNumber = parseEpisodeNumber(ref.episodeSlug);
    if (currentNumber && !byNumber.has(currentNumber)) {
        byNumber.set(currentNumber, { number: currentNumber, title: currentTitle || ('Episode ' + currentNumber), url: ref.url });
    }
    return makeEpisodeList([...byNumber.values()]);
}

export function parseAnimePage($, base, pageUrl) {
    const ref = parseEpisodeRef(pageUrl, base);
    if (!ref) return null;

    const labels = labelMap($);
    const jsonLd = embeddedStructuredData($);
    const rawTitle = firstNonEmpty(
        $('h1').first().text(),
        metaContent($, ['meta[property="og:title"]', 'meta[name="twitter:title"]']),
        $('title').first().text(),
        jsonLd.find((item) => item.name)?.name,
    );
    const title = cleanAnimeTitle(rawTitle) || cleanAnimeTitle(ref.seriesSlug.replace(/-/g, ' '));
    if (!title) return null;

    const description = firstNonEmpty(
        metaContent($, ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']),
        $('[itemprop="description"]').first().text(),
        jsonLd.find((item) => item.description)?.description,
    );
    const image = firstNonEmpty(
        metaContent($, ['meta[property="og:image"]', 'meta[name="twitter:image"]']),
        $('img[itemprop="image"]').first().attr('src'),
        jsonLd.find((item) => item.image)?.image?.url,
        jsonLd.find((item) => item.image)?.image,
    );
    const genres = [
        ...(labels.genres?.links || []),
        ...splitValues(labels.genres?.text),
        ...$('a[href*="/genre/"], .genres a, .anime-genres a').map((_, node) => cleanText($(node).text())).get(),
        ...jsonLd.flatMap((item) => (Array.isArray(item.genre) ? item.genre : [item.genre]).filter(Boolean)),
    ].filter(Boolean);
    const studios = [
        ...(labels.studios?.links || []),
        ...splitValues(labels.studios?.text),
        ...jsonLd.flatMap((item) => {
            const value = item.productionCompany || item.studio;
            return (Array.isArray(value) ? value : [value]).map((v) => typeof v === 'string' ? v : v?.name).filter(Boolean);
        }),
    ].filter(Boolean);
    const episodeNumber = parseEpisodeNumber(ref.episodeSlug);
    const episodeList = parseEpisodes($, base, ref, 'Episode ' + (episodeNumber || ''));
    const episodeCounts = [
        firstInt(labels.episodes?.text),
        ...jsonLd.map((item) => firstInt(item.numberOfEpisodes || item.episodeCount)),
    ].filter((value) => Number.isInteger(value) && value > 0);
    const episodes = episodeCounts[0] || null;
    const latestEpisode = episodeList.length ? Math.max(...episodeList.map((entry) => entry.number)) : episodeNumber;
    const statusText = labels.status?.text || '';
    const slug = encodeSlug(ID, ref.seriesSlug, ref.episodeSlug);

    const anime = makeAnime({
        title,
        image: image ? absoluteUrl(image, base) : null,
        description,
        episodes: episodes || (String(statusText).toLowerCase().includes('complete') ? latestEpisode : null),
        latestEpisode,
        genres,
        status: parseStatus(statusText),
        format: labels.format?.text || '',
        year: parseYear(labels.year?.text || ''),
        studios,
        duration: parseDurationMinutes(labels.duration?.text || ''),
        slug,
        source: ID,
        url: ref.url,
    });
    return { anime, episodeList };
}

/**
 * Only explicitly typed HTTPS embed/player pages are forwarded to the browser.
 * The observed worker resolver and direct media URLs are deliberately not followed.
 */
export function parsePublicEmbedSources(payload, pageUrl) {
    const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    if (!body || !Array.isArray(body.sources)) return [];

    const results = [];
    const seen = new Set();
    for (const source of body.sources.slice(0, 12)) {
        const type = cleanText(source?.type).toLowerCase();
        if (!/(embed|iframe|player)/i.test(type)) continue;

        let url;
        try { url = new URL(String(source?.url || ''), pageUrl); } catch { continue; }
        if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
        if (url.hostname === 'animeindo.cloud' || url.hostname.endsWith('.workers.dev') || url.hostname.endsWith('.pages.dev')) continue;
        if (/\.(?:m3u8|mp4|m4v|mpd|ts|mkv|webm)(?:$|\/)/i.test(url.pathname)) continue;
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        results.push({
            name: cleanText(source.label || source.name || 'Public embed').slice(0, 40),
            url: url.href,
            lang: 'id',
            subtitleType: 'hard',
        });
    }
    return results;
}

export function createAnimeIndo({ network, createClient, baseUrl = DEFAULT_BASE, sourceConfig = {} }) {
    const base = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const host = new URL(base).hostname.toLowerCase();
    const client = createClient(network, {
        source: ID,
        allowedHosts: [host],
        requireExplicitRobots: POLICY.tos.verdict !== 'allowed',
        cookies: false,
        renderJavaScript: Boolean(sourceConfig.renderJavaScript),
    });

    function parseRef(parts) {
        if (parts.length !== 2) return null;
        const [seriesSlug, episodeSlug] = parts.map((value) => String(value).toLowerCase());
        if (!SLUG_RE.test(seriesSlug) || !SLUG_RE.test(episodeSlug) || !parseEpisodeNumber(episodeSlug)) return null;
        return { seriesSlug, episodeSlug, url: base + '/nonton/' + seriesSlug + '/' + episodeSlug };
    }

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        country: 'JP',
        policy: POLICY,
        supportsLatest: false,
        supportsSearch: false,

        parseRef,

        titleHint(ref) {
            return cleanAnimeTitle(ref.seriesSlug.replace(/-/g, ' '));
        },

        // Search/latest upstream routes have not been observed; do not guess them.
        async latest() { return []; },
        async search() { return []; },

        async getAnime(ref, ctx = {}) {
            const page = await client.html(ref.url, ctx);
            const parsed = parseAnimePage(page.$, base, page.url || ref.url);
            if (!parsed) throw new SourceError('Struktur halaman AnimeIndo tidak dikenali.', { kind: 'parse', source: ID });
            return { ...parsed.anime, episodeList: parsed.episodeList };
        },

        async getEpisode(ref, ep, ctx = {}) {
            const anime = ctx.anime || await this.getAnime(ref, ctx);
            const item = anime.episodeList?.find((entry) => entry.number === ep);
            if (!item?.url) throw notFound('Episode ' + ep + ' belum ditemukan pada halaman AnimeIndo.', ID);

            const page = await client.html(item.url, ctx);
            const dataRef = parseEpisodeRef(page.url || item.url, base);
            if (!dataRef) throw new SourceError('URL episode AnimeIndo tidak valid.', { kind: 'parse', source: ID });

            let servers = [];
            let notice = '';
            try {
                // Observed same-origin public JSON endpoint:
                // GET /api/anime-indo/sources/<episode-slug>
                const payload = await client.json(base + '/api/anime-indo/sources/' + encodeURIComponent(dataRef.episodeSlug), ctx);
                servers = parsePublicEmbedSources(payload, item.url);
                if (!servers.length) {
                    notice = 'Konfigurasi sumber episode tersedia, tetapi tidak ada embed HTTPS publik yang dikenali; resolver dan URL media langsung tidak digunakan.';
                }
            } catch (error) {
                if (ctx.signal?.aborted || error?.kind === 'abort') throw error;
                notice = 'Konfigurasi sumber episode tidak dapat dibaca; metadata episode tetap tersedia.';
            }

            return makeEpisode({
                episode: ep,
                title: cleanText(page.$('h1').first().text()) || item.title,
                released: item.released,
                url: item.url,
                servers,
                downloads: [],
                notice,
            });
        },
    };
}
