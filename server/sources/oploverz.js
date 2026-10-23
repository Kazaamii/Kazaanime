/**
 * Kazanime backend — sources/oploverz.js
 * Adapter Oploverz (https://oploverz.ch) — WordPress tema dramastream/themesia.
 *
 * Struktur diverifikasi dari HTML asli (23 Okt 2026) yang tersimpan sebagai fixture:
 *   server/test/fixtures/oploverz-{home,series-list,series,episode}.html
 *
 *   - Kartu        : article.bs > .bsx > a[href]; URL episode berpola
 *                    /<judul>-episode-<n>-subtitle-indonesia/; judul seri di .tt,
 *                    judul episode di h2[itemprop=headline], nomor di .epx, penanda .sb ("Sub").
 *   - Halaman seri : h1.entry-title, .alter, .spe span (Status/Studio/Released/Season/Type),
 *                    daftar episode .eplister li a[href] (.epl-num/.epl-title/.epl-date).
 *   - Episode      : h1.entry-title ("… Episode N Subtitle Indonesia"),
 *                    server di .dsu-server[data-label][data-url] (fallback #embed_holder iframe),
 *                    daftar episode sidebar #singlepisode .episodelist.
 *                    Tidak ada tautan unduhan di halaman contoh → downloads: [].
 *
 * Klaim "Sub Indo" hanya bila halaman episode itu sendiri menyebutnya
 * (lib/subtitle-evidence.js); nama situs dan bahasa antarmuka tidak dipakai.
 */
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { applySubtitleEvidence } from '../lib/subtitle-evidence.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import {
    absoluteUrl, cleanText, clip, firstInt, parseEpisodeNumber, parseFormat,
    parseScore10, parseStatus, parseYear,
} from '../lib/text.js';

export const ID = 'oploverz';
export const NAME = 'Oploverz';

export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'allowed',
    tos: Object.freeze({
        url: null,
        reviewedAt: '2026-10-23',
        verdict: 'unknown',
        note: 'Belum ada halaman ToS/DMCA yang tertaut dari situs. robots.txt (Yoast, 23 Okt 2026) '
            + 'mengizinkan semua path. Gerbang robots mengikuti SCRAPER_ROBOTS_MODE (default off); '
            + '403/429/challenge tetap dihentikan tanpa retry atau bypass.',
    }),
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,158}$/;
const EPISODE_SLUG_RE = /-episode-\d+(?:-\d+)?(?:-subtitle-indonesia)?$/;

function siteUrl(value, base) {
    const url = absoluteUrl(value, base);
    if (!url) return null;
    try {
        const parsed = new URL(url);
        if (parsed.origin !== new URL(base).origin) return null;
        parsed.hash = '';
        return parsed.href;
    } catch {
        return null;
    }
}

function imageSrc($img, base) {
    const value = $img.attr('src') || $img.attr('data-src') || $img.attr('data-lazy-src');
    return value && !value.startsWith('data:') ? absoluteUrl(value, base) || null : null;
}

/** `/series/<slug>/` → slug. */
export function seriesSlugFromUrl(value, base) {
    try {
        const url = new URL(value, base);
        if (url.origin !== new URL(base).origin) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 2 || parts[0] !== 'series') return null;
        const slug = decodeURIComponent(parts[1]).toLowerCase();
        return SLUG_RE.test(slug) ? slug : null;
    } catch {
        return null;
    }
}

/** `/<slug>-episode-<n>-subtitle-indonesia/` → slug. */
export function episodeSlugFromUrl(value, base) {
    try {
        const url = new URL(value, base);
        if (url.origin !== new URL(base).origin) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 1) return null;
        const slug = decodeURIComponent(parts[0]).toLowerCase();
        return EPISODE_SLUG_RE.test(slug) && SLUG_RE.test(slug) ? slug : null;
    } catch {
        return null;
    }
}

/** Slug ini halaman episode (bukan seri)? */
export function isEpisodeSlug(slug) {
    return EPISODE_SLUG_RE.test(String(slug || ''));
}

/** Kartu dari beranda/daftar/pencarian. */
export function parseCards($, base) {
    const out = [];
    $('article.bs').each((_, el) => {
        const card = $(el);
        const anchor = card.find('.bsx > a[href]').first().length
            ? card.find('.bsx > a[href]').first()
            : card.find('a[href]').first();
        const url = siteUrl(anchor.attr('href'), base);
        if (!url) return;

        const episodeTitle = cleanText(card.find('h2[itemprop="headline"]').first().text())
            || cleanText(card.find('h2').first().text())
            || cleanText(anchor.attr('title'));
        const tt = card.find('.tt').first().clone();
        tt.find('h2').remove();
        const seriesTitle = cleanText(tt.text())
            || episodeTitle.replace(/\s+(?:Episode|Eps?\.?)\s*\d+.*$/i, '').trim();

        const label = cleanText(card.find('.epx').first().text());
        const episode = parseEpisodeNumber(label) || parseEpisodeNumber(episodeTitle) || parseEpisodeNumber(url);
        const seriesSlug = seriesSlugFromUrl(url, base);
        const slug = seriesSlug || episodeSlugFromUrl(url, base);
        if (!slug) return;

        out.push({
            slug,
            kind: seriesSlug ? 'series' : 'episode',
            url,
            title: seriesTitle || episodeTitle,
            episodeTitle,
            image: imageSrc(card.find('img').first(), base),
            latestEpisode: episode,
            format: parseFormat(card.find('.typez').first().text()),
            label,
        });
    });
    return out;
}

/** Baris episode dari halaman seri (.eplister) atau sidebar episode (.episodelist). */
export function parseEpisodeRows($, base) {
    const rows = [];
    $('.eplister li a[href], .episodelist li a[href]').each((_, el) => {
        const anchor = $(el);
        const url = siteUrl(anchor.attr('href'), base);
        if (!url) return;
        const title = cleanText(anchor.find('.epl-title').first().text())
            || cleanText(anchor.find('.playinfo h3').first().text())
            || cleanText(anchor.attr('title'));
        const numText = cleanText(anchor.find('.epl-num').first().text());
        const number = (/^\d{1,4}$/.test(numText) ? Number.parseInt(numText, 10) : null)
            || parseEpisodeNumber(title) || parseEpisodeNumber(url);
        if (!number) return;
        const dateLabel = cleanText(anchor.find('.epl-date').first().text())
            || cleanText(anchor.find('.playinfo span').first().text());
        rows.push({
            number,
            title,
            released: dateLabel.replace(/^(?:episode|eps?\.?)\s*\d+\s*[-–—]?\s*/i, '').replace(/^\d+\s*[-–—]?\s*/, ''),
            url,
        });
    });
    return makeEpisodeList(rows);
}

/** Entitas ganda dari sumber (mis. "&amp;#039;") → teks biasa. */
function decodeEntities(value) {
    return cleanText(value)
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&amp;/g, '&');
}

/** URL seri dari halaman episode/seri; hanya path /series/<slug>/ yang diterima. */
function seriesUrlFromPage($, base) {
    const direct = siteUrl($('#singlepisode .headlist h2 a[href]').first().attr('href'), base);
    if (direct && seriesSlugFromUrl(direct, base)) return direct;
    let found = null;
    $('a[href*="/series/"]').each((_, el) => {
        if (found) return;
        const url = siteUrl($(el).attr('href'), base);
        if (url && seriesSlugFromUrl(url, base)) found = url;
    });
    return found;
}

function information($) {
    const values = {};
    $('.spe > span').each((_, el) => {
        const span = $(el);
        const key = cleanText(span.find('b').first().text()).replace(/:\s*$/, '').toLowerCase();
        if (!key || values[key]) return;
        const clone = span.clone();
        clone.find('b').first().remove();
        values[key] = cleanText(clone.text());
    });
    return values;
}

function seriesMeta($, base) {
    const info = information($);
    const rows = parseEpisodeRows($, base);
    return {
        rows,
        info,
        title: cleanText($('h1.entry-title').first().text()),
        titleAlt: decodeEntities($('.alter').first().text()),
        image: absoluteUrl($('meta[property="og:image"]').attr('content'), base)
            || imageSrc($('.thumbook img').first(), base)
            || imageSrc($('.single-info .thumb img').first(), base),
        description: cleanText($('.mindesc').first().text()),
        genres: $('a[href*="/genres/"]').map((_, el) => cleanText($(el).text())).get().filter(Boolean),
        latestEpisode: rows.length ? rows[rows.length - 1].number : null,
    };
}

/**
 * Halaman seri ATAU halaman episode (dipakai `getAnime`).
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} base
 * @param {{slug: string}} ref
 */
export function parseAnimePage($, base, ref) {
    const meta = seriesMeta($, base);
    const isEpisodePage = isEpisodeSlug(ref.slug);
    const seriesVerse = cleanText($('#singlepisode .headlist h2 a[href]').first().text());
    const seriesUrl = seriesUrlFromPage($, base);

    const title = (isEpisodePage && seriesVerse) || meta.title
        || seriesVerse.replace(/\s+Subtitle Indonesia$/i, '').trim();
    if (!title || !meta.rows.length) return null;

    const anime = makeAnime({
        title,
        titleAlt: meta.titleAlt,
        image: meta.image,
        description: meta.description,
        genres: meta.genres,
        studios: meta.info.studio ? meta.info.studio.split(',').map((s) => cleanText(s)).filter(Boolean) : [],
        status: parseStatus(meta.info.status),
        format: parseFormat(meta.info.type),
        year: parseYear(meta.info.released || meta.info.year || ''),
        score: parseScore10($('.rating strong, .score').first().text()),
        latestEpisode: meta.latestEpisode,
        episodes: meta.info.episodes ? firstInt(meta.info.episodes) : meta.rows.length,
        country: 'JP',
        slug: encodeSlug(ID, ref.slug),
        source: ID,
        url: seriesUrl || `${base}/series/${ref.slug}/`,
    });
    return { anime, episodeList: meta.rows };
}

/** Halaman episode: server dari markup publik + bukti bahasa dari halaman itu sendiri. */
export function parseEpisodePage($, base) {
    const servers = [];
    const seen = new Set();
    const push = (name, value) => {
        const url = absoluteUrl(value, base);
        if (!url || seen.has(url)) return;
        seen.add(url);
        servers.push({ name: clip(name, 40) || `Server ${servers.length + 1}`, url });
    };

    $('.dsu-server[data-url]').each((_, el) => {
        const button = $(el);
        push(cleanText(button.attr('data-label')) || cleanText(button.text()), button.attr('data-url'));
    });
    $('#embed_holder iframe[src], .player-embed iframe[src]').each((_, el) => {
        push('Embed', $(el).attr('src'));
    });

    const title = cleanText($('h1.entry-title').first().text());
    const downloads = [];
    // Judul episode memuat "Subtitle Indonesia"; deskripsi episode ikut diperiksa.
    const evidence = applySubtitleEvidence(servers, {
        title,
        pageText: $('.entry-content').first().text(),
        labels: servers.map((server) => server.name),
        downloads,
    });
    const rows = parseEpisodeRows($, base);
    return {
        title,
        episode: parseEpisodeNumber(title) || parseEpisodeNumber($('link[rel="canonical"]').attr('href')),
        url: siteUrl($('link[rel="canonical"]').attr('href'), base),
        seriesUrl: seriesUrlFromPage($, base),
        servers: evidence.servers,
        subtitleEvidence: evidence.evidence,
        subtitleEvidenceDetail: evidence.detail,
        downloads,
        episodeList: rows,
    };
}

export function createOploverz({ network, createClient, baseUrl }) {
    const base = String(baseUrl || 'https://oploverz.ch').replace(/\/+$/, '');
    const host = new URL(base).hostname;
    const client = createClient(network, {
        source: ID,
        allowedHosts: [host],
        requireExplicitRobots: false,
        cookies: false,
    });

    const toAnime = (card) => makeAnime({
        title: card.title,
        image: card.image,
        latestEpisode: card.latestEpisode,
        format: card.format,
        status: 'ONGOING',
        country: 'JP',
        slug: encodeSlug(ID, card.slug),
        source: ID,
        url: card.url,
    });

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        country: 'JP',
        policy: POLICY,

        parseRef(parts) {
            const slug = String(parts[0] || '').toLowerCase();
            return parts.length === 1 && SLUG_RE.test(slug) ? { slug } : null;
        },

        titleHint(ref) {
            return ref.slug.replace(/-episode-\d+.*$/, '').replace(/-/g, ' ');
        },

        async latest(ctx = {}) {
            const page = await client.html(`${base}/`, ctx);
            const seen = new Set();
            return parseCards(page.$, base)
                .filter((card) => card.kind === 'episode' && card.latestEpisode)
                .filter((card) => (seen.has(card.slug) ? false : seen.add(card.slug)))
                .map(toAnime);
        },

        async search(query, ctx = {}) {
            const url = new URL(`${base}/`);
            url.searchParams.set('s', query);
            const page = await client.html(url.href, ctx);
            const seen = new Set();
            return parseCards(page.$, base)
                .filter((card) => (seen.has(card.slug) ? false : seen.add(card.slug)))
                .map(toAnime);
        },

        async getAnime(ref, ctx = {}) {
            const target = isEpisodeSlug(ref.slug) ? `${base}/${ref.slug}/` : `${base}/series/${ref.slug}/`;
            const page = await client.html(target, ctx);
            const parsed = parseAnimePage(page.$, base, ref);
            if (!parsed) throw new SourceError('Struktur halaman Oploverz tidak dikenali.', { kind: 'parse', source: ID });
            return { ...parsed.anime, episodeList: parsed.episodeList };
        },

        async getEpisode(ref, episode, ctx = {}) {
            const entry = (ctx.anime?.episodeList || []).find((item) => item.number === episode);
            const url = entry?.url
                || (isEpisodeSlug(ref.slug) && parseEpisodeNumber(ref.slug) === episode ? `${base}/${ref.slug}/` : null);
            if (!url) throw notFound(`Episode ${episode} belum tersedia di ${NAME}.`, ID);
            const page = await client.html(url, ctx);
            const parsed = parseEpisodePage(page.$, base);
            if (!parsed.servers.length) {
                throw new SourceError('Halaman episode Oploverz tidak berisi URL server publik.', { kind: 'parse', source: ID });
            }
            return makeEpisode({
                episode,
                title: parsed.title || entry?.title || '',
                released: entry?.released || '',
                url: parsed.url || page.url,
                servers: parsed.servers,
                downloads: parsed.downloads,
            });
        },
    };
}
