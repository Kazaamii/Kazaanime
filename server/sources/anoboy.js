/**
 * Kazanime backend — sources/anoboy.js
 * Adapter Anoboy (https://anoboy.be), berdasarkan halaman episode HTML yang diberikan pengguna.
 * Tidak ada live request selama pembuatan adapter; ToS/robots belum ditinjau di sandbox.
 * Semua halaman konten hanya diminta bila robots.txt kelak terbaca dan mengizinkan.
 *
 * Dari snapshot halaman episode diketahui: form pencarian WordPress `/?s=`, tautan seri
 * `/anime/<slug>/`, daftar episode `.episodelist`, dan server publik `.aspd-server[data-url]`.
 * Hanya URL server yang tercantum langsung di HTML digunakan; tidak ada endpoint/token yang ditebak.
 */
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import {
    absoluteUrl, cleanText, clip, firstInt, parseEpisodeNumber, parseFormat,
    parseScore10, parseStatus, parseYear,
} from '../lib/text.js';

export const ID = 'anoboy';
export const NAME = 'Anoboy';

export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'unknown',
    tos: Object.freeze({
        url: null,
        reviewedAt: '2026-10-22',
        verdict: 'unknown',
        note: 'Berdasarkan HTML episode yang diberikan pengguna; ToS dan robots.txt belum diverifikasi langsung. '
            + 'Semua request konten mensyaratkan robots.txt terbaca dan mengizinkan; challenge tidak dilewati.',
    }),
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,118}$/;

function siteUrl(value, base) {
    const url = absoluteUrl(value, base);
    if (!url) return null;
    try {
        return new URL(url).origin === new URL(base).origin ? url : null;
    } catch {
        return null;
    }
}

function imageSrc($img, base) {
    const value = $img.attr('src');
    return value && !value.startsWith('data:') ? absoluteUrl(value, base) || null : null;
}

/** URL seri `/anime/<slug>/` → slug (host dan prefix harus tepat). */
export function animeSlugFromUrl(value, base) {
    try {
        const url = new URL(value, base);
        if (url.origin !== new URL(base).origin) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 2 || parts[0] !== 'anime') return null;
        const slug = decodeURIComponent(parts[1]).toLowerCase();
        return SLUG_RE.test(slug) ? slug : null;
    } catch {
        return null;
    }
}

/** Kartu anime dari markup `.listupd article.bs` pada tema situs. */
export function parseCards($, base) {
    const out = [];
    $('.listupd article.bs').each((_, el) => {
        const card = $(el);
        const anchor = card.find('.bsx > a[href]').first();
        const url = siteUrl(anchor.attr('href'), base);
        const slug = url ? animeSlugFromUrl(url, base) : null;
        if (!slug) return;
        const epLabel = cleanText(card.find('.epx').first().text());
        out.push({
            slug,
            url,
            title: cleanText(card.find('.tt h2').first().text()) || cleanText(anchor.attr('title')) || cleanText(anchor.text()),
            image: imageSrc(card.find('img').first(), base),
            latestEpisode: parseEpisodeNumber(epLabel),
            format: parseFormat(card.find('.typez').first().text()),
        });
    });
    return out;
}

function parseEpisodeRows($, base) {
    const rows = [];
    $('.episodelist a[href]').each((_, el) => {
        const anchor = $(el);
        const url = siteUrl(anchor.attr('href'), base);
        if (!url) return;
        const title = cleanText(anchor.find('.playinfo h3').first().text())
            || cleanText(anchor.attr('title')) || cleanText(anchor.text());
        const dateLabel = cleanText(anchor.find('.playinfo span').first().text());
        const number = parseEpisodeNumber(title) || parseEpisodeNumber(dateLabel) || parseEpisodeNumber(url);
        if (!number) return;
        rows.push({
            number,
            title,
            released: dateLabel.replace(/^(?:eps?\.?\s*)?\d+\s*[-–—]?\s*/i, ''),
            url,
        });
    });
    return makeEpisodeList(rows);
}

function information($) {
    const values = {};
    $('.single-info .spe > span').each((_, el) => {
        const span = $(el);
        const key = cleanText(span.find('b').first().text()).replace(/:\s*$/, '').toLowerCase();
        if (!key || values[key]) return;
        const clone = span.clone();
        clone.find('b').first().remove();
        values[key] = cleanText(clone.text());
    });
    return values;
}

/** Halaman seri atau episode (snapshot Anoboy menampilkan info seri + seluruh eplist di keduanya). */
export function parseAnimePage($, base, slug) {
    const rows = parseEpisodeRows($, base);
    const title = cleanText($('.single-info [itemprop="partOfSeries"]').first().text())
        || cleanText($('.single-info .infolimit h2').first().text())
        || cleanText($('h1.entry-title').first().text()).replace(/\s+Episode\s+\d+.*$/i, '');
    if (!title || !rows.length) return null;
    const info = information($);
    const image = absoluteUrl($('meta[property="og:image"]').attr('content'), base)
        || imageSrc($('.single-info .thumb img').first(), base);
    const seriesUrl = siteUrl($('#sidebar #singlepisode .headlist .thumb a[href]').attr('href'), base)
        || `${base}/anime/${slug}/`;
    const latestEpisode = rows[rows.length - 1].number;
    const anime = makeAnime({
        title,
        titleAlt: cleanText($('.single-info .alter').first().text()),
        image,
        description: cleanText($('.single-info .desc').first().text()),
        genres: $('.single-info .genxed a').map((_, el) => cleanText($(el).text())).get(),
        studios: info.studio ? info.studio.split(',') : [],
        status: parseStatus(info.status),
        format: parseFormat(info.type),
        year: parseYear(info.released || info.year || ''),
        score: parseScore10($('.single-info .rating strong').first().text()),
        latestEpisode,
        episodes: info.episodes ? firstInt(info.episodes) : null,
        country: 'JP',
        slug: encodeSlug(ID, slug),
        source: ID,
        url: seriesUrl,
    });
    return { anime, episodeList: rows };
}

/** Halaman episode: hanya tombol server dengan URL eksplisit di `data-url` yang dipakai. */
export function parseEpisodePage($, base) {
    const servers = [];
    const seen = new Set();
    $('.aspd-server[data-url]').each((_, el) => {
        const button = $(el);
        const url = absoluteUrl(button.attr('data-url'), base);
        if (!url || seen.has(url)) return;
        seen.add(url);
        servers.push({
            name: clip(button.attr('data-label') || button.text(), 40) || `Server ${servers.length + 1}`,
            url,
            lang: 'id',
        });
    });

    const episodeTitle = cleanText($('h1.entry-title').first().text());
    const seriesUrl = siteUrl($('#sidebar #singlepisode .headlist .thumb a[href]').attr('href'), base);
    return {
        title: episodeTitle,
        episode: parseEpisodeNumber($('meta[itemprop="episodeNumber"]').attr('content')) || parseEpisodeNumber(episodeTitle),
        url: siteUrl($('link[rel="canonical"]').attr('href'), base),
        seriesUrl,
        servers,
        downloads: [],
        episodeList: parseEpisodeRows($, base),
    };
}

export function createAnoboy({ network, createClient, baseUrl }) {
    const base = String(baseUrl || 'https://anoboy.be').replace(/\/+$/, '');
    const host = new URL(base).hostname;
    const client = createClient(network, {
        source: ID,
        allowedHosts: [host],
        requireExplicitRobots: true,
        cookies: false,
    });

    const toAnime = (card) => makeAnime({
        title: card.title,
        image: card.image,
        status: card.status,
        latestEpisode: card.latestEpisode,
        format: card.format,
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
            return ref.slug.replace(/-/g, ' ');
        },

        // Anoboy's homepage/latest route was not included in the supplied snapshot; don't guess one.
        async latest() { return []; },

        async search(query, ctx = {}) {
            const url = new URL(`${base}/`);
            url.searchParams.set('s', query);
            const page = await client.html(url.href, ctx);
            return parseCards(page.$, base).map(toAnime);
        },

        async getAnime(ref, ctx = {}) {
            const page = await client.html(`${base}/anime/${ref.slug}/`, ctx);
            const parsed = parseAnimePage(page.$, base, ref.slug);
            if (!parsed) throw new SourceError('Struktur halaman seri Anoboy tidak dikenali.', { kind: 'parse', source: ID });
            return { ...parsed.anime, episodeList: parsed.episodeList };
        },

        async getEpisode(ref, episode, ctx = {}) {
            const entry = (ctx.anime?.episodeList || []).find((item) => item.number === episode);
            if (!entry?.url) throw notFound(`Episode ${episode} belum tersedia di ${NAME}.`, ID);
            const page = await client.html(entry.url, ctx);
            const parsed = parseEpisodePage(page.$, base);
            if (!parsed.servers.length) throw new SourceError('Halaman episode Anoboy tidak berisi URL server publik.', { kind: 'parse', source: ID });
            return makeEpisode({
                episode,
                title: parsed.title || entry.title,
                released: entry.released,
                url: parsed.url || page.url,
                servers: parsed.servers,
                downloads: parsed.downloads,
            });
        },
    };
}
