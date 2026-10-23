/**
 * Kazanime backend — sources/sakunime.js
 * Adapter Sakunime (https://sakunime.com), berdasarkan snapshot halaman episode yang diberikan pengguna.
 * Tidak ada live request selama pembuatan adapter; ToS/robots belum ditinjau di sandbox.
 * Semua halaman konten hanya diminta bila robots.txt kelak terbaca dan mengizinkan.
 *
 * Snapshot menunjukkan search route `/search/<query>/`, seri `/anime/<slug>`, daftar episode
 * `.watch-eprow`, dan URL player default pada `#playerShell[data-default]`. `serverId` di JSON
 * `data-server` adalah token opaque; adapter sengaja tidak mengurai atau mengirimkannya.
 */
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import { absoluteUrl, cleanText, parseEpisodeNumber } from '../lib/text.js';

export const ID = 'sakunime';
export const NAME = 'Sakunime';

export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'unknown',
    tos: Object.freeze({
        url: null,
        reviewedAt: '2026-10-22',
        verdict: 'unknown',
        note: 'Berdasarkan HTML episode yang diberikan pengguna; ToS dan robots.txt belum diverifikasi langsung. '
            + 'Semua request konten mensyaratkan robots.txt terbaca dan mengizinkan. ServerId opaque tidak digunakan.',
    }),
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,118}$/;
const SECTIONS = new Set(['ongoing', 'completed', 'genre', 'jadwal']);

function siteUrl(value, base) {
    const url = absoluteUrl(value, base);
    if (!url) return null;
    try {
        return new URL(url).origin === new URL(base).origin ? url : null;
    } catch {
        return null;
    }
}

function animeSlugFromUrl(value, base) {
    try {
        const url = new URL(value, base);
        if (url.origin !== new URL(base).origin) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 2 || parts[0] !== 'anime') return null;
        const slug = decodeURIComponent(parts[1]).toLowerCase();
        return SLUG_RE.test(slug) && !SECTIONS.has(slug) ? slug : null;
    } catch {
        return null;
    }
}

function watchSlugFromUrl(value, base) {
    try {
        const url = new URL(value, base);
        if (url.origin !== new URL(base).origin) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 2 || parts[0] !== 'watch') return null;
        const slug = decodeURIComponent(parts[1]).toLowerCase();
        return SLUG_RE.test(slug) ? slug : null;
    } catch {
        return null;
    }
}

function animeTitleFromEpisode(value) {
    return cleanText(value)
        .replace(/\s+episode\s+\d+(?:\s+subtitle\s+indonesia)?\s*$/i, '')
        .replace(/\s+subtitle\s+indonesia\s*$/i, '')
        .trim();
}

/**
 * Cari nomor episode terbaru dalam kartu yang juga memuat tautan seri.
 * Hanya menggunakan tautan watch publik yang tertulis dalam HTML; tidak menebak ID player.
 */
function latestEpisodeInCard($, anchor, base) {
    let node = anchor;
    for (let depth = 0; depth < 6 && node.length; depth++) {
        const links = node.find('a[href]').toArray();
        if (node.is('a[href]')) links.unshift(node[0]);

        const seriesCount = links.filter((el) => Boolean(animeSlugFromUrl($(el).attr('href'), base))).length;
        const episodeNumbers = links.map((el) => {
            const href = siteUrl($(el).attr('href'), base);
            const watchSlug = href ? watchSlugFromUrl(href, base) : null;
            if (!watchSlug) return null;
            return parseEpisodeNumber(watchSlug)
                || parseEpisodeNumber($(el).attr('title'))
                || parseEpisodeNumber($(el).text());
        }).filter((number) => Number.isInteger(number) && number > 0);

        // Tetap pada konteks kartu; jangan membaca seluruh halaman lalu salah memasangkan judul.
        if (seriesCount >= 1 && seriesCount <= 3 && episodeNumbers.length) {
            return Math.max(...episodeNumbers);
        }
        node = node.parent();
    }
    return null;
}

function episodeRows($, base, animeTitle = '') {
    const rows = [];
    $('a.watch-eprow[href]').each((_, el) => {
        const anchor = $(el);
        const url = siteUrl(anchor.attr('href'), base);
        const watchSlug = url ? watchSlugFromUrl(url, base) : null;
        if (!watchSlug) return;
        const label = cleanText(anchor.attr('title')) || cleanText(anchor.text());
        const number = parseEpisodeNumber(label) || parseEpisodeNumber(watchSlug);
        if (!number) return;
        rows.push({
            number,
            title: label && !/^eps?\.?\s*\d+$/i.test(label) ? label : `${animeTitle || 'Episode'} Episode ${number}`,
            released: '',
            url,
        });
    });
    return makeEpisodeList(rows);
}

/** Kandidat judul dari search `/search/<query>/` atau daftar `/anime/ongoing/`. */
export function parseAnimeLinks($, base) {
    const out = [];
    const seen = new Set();
    $('a[href]').each((_, el) => {
        const anchor = $(el);
        const url = siteUrl(anchor.attr('href'), base);
        const slug = url ? animeSlugFromUrl(url, base) : null;
        if (!slug || seen.has(slug)) return;
        const image = anchor.find('img').first().attr('src') || null;
        const title = cleanText(anchor.attr('title'))
            || cleanText(anchor.text())
            || cleanText(anchor.find('img').first().attr('alt'));
        if (!title) return;
        seen.add(slug);
        out.push({
            slug,
            url,
            title: animeTitleFromEpisode(title),
            image: absoluteUrl(image, base) || null,
            latestEpisode: latestEpisodeInCard($, anchor, base),
        });
    });
    return out;
}

/** Detail page or episode snapshot → normalized anime + episode list. */
export function parseAnimePage($, base, slug) {
    const titleText = cleanText($('h1').first().text())
        || cleanText($('#playerShell').attr('data-ep-title'))
        || cleanText($('meta[property="og:title"]').attr('content'));
    const title = animeTitleFromEpisode(titleText);
    const episodes = episodeRows($, base, title);
    if (!title || !episodes.length) return null;
    const image = absoluteUrl($('meta[property="og:image"]').attr('content'), base)
        || absoluteUrl($('meta[name="twitter:image"]').attr('content'), base);
    const anime = makeAnime({
        title,
        image,
        latestEpisode: episodes[episodes.length - 1].number,
        country: 'JP',
        slug: encodeSlug(ID, slug),
        source: ID,
        url: `${base}/anime/${slug}`,
    });
    return { anime, episodeList: episodes };
}

/** Page nonton → hanya URL default yang ditulis langsung di HTML; serverId tidak ditebak/di-resolve. */
export function parseEpisodePage($, base) {
    const shell = $('#playerShell').first();
    if (!shell.length) return null;
    const title = cleanText(shell.attr('data-ep-title')) || cleanText($('h1').first().text());
    const episode = parseEpisodeNumber(shell.attr('data-episode-id')) || parseEpisodeNumber(title);
    const defaultUrl = absoluteUrl(shell.attr('data-default'), base);
    const servers = defaultUrl ? [{ name: 'Sakunime', url: defaultUrl, lang: 'id' }] : [];
    const seriesAnchor = $('a.pg-circle[href]').first();
    const seriesUrl = siteUrl(seriesAnchor.attr('href'), base);
    const seriesSlug = seriesUrl ? animeSlugFromUrl(seriesUrl, base) : null;
    return {
        title,
        episode,
        episodeId: cleanText(shell.attr('data-episode-id')),
        animeId: cleanText(shell.attr('data-anime-id')),
        seriesSlug,
        seriesUrl,
        url: siteUrl($('link[rel="canonical"]').attr('href'), base),
        nextUrl: siteUrl(shell.attr('data-next'), base),
        episodeList: episodeRows($, base, animeTitleFromEpisode(title)),
        servers,
        downloads: [],
    };
}

export function createSakunime({ network, createClient, baseUrl }) {
    const base = String(baseUrl || 'https://sakunime.com').replace(/\/+$/, '');
    const host = new URL(base).hostname;
    const client = createClient(network, {
        source: ID,
        allowedHosts: [host],
        requireExplicitRobots: true,
        cookies: false,
    });

    const toAnime = (item) => makeAnime({
        title: item.title,
        image: item.image,
        latestEpisode: item.latestEpisode,
        status: item.latestEpisode ? 'ONGOING' : 'UNKNOWN',
        country: 'JP',
        slug: encodeSlug(ID, item.slug),
        source: ID,
        url: item.url,
    });

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        country: 'JP',
        policy: POLICY,

        parseRef(parts) {
            const slug = String(parts[0] || '').toLowerCase();
            return parts.length === 1 && SLUG_RE.test(slug) && !SECTIONS.has(slug) ? { slug } : null;
        },

        titleHint(ref) {
            return ref.slug.replace(/-sub-indo$/, '').replace(/-/g, ' ');
        },

        async latest(ctx = {}) {
            // Halaman publik /anime/ memuat bagian "Episode Terbaru". Ambil dari feed ini
            // agar nomor episode yang benar ikut terbawa ke verifikasi Sub Indo homepage.
            const page = await client.html(`${base}/anime/`, ctx);
            const items = parseAnimeLinks(page.$, base).map(toAnime);
            if (!items.length) {
                throw new SourceError('Feed Anime Terbaru Sakunime tidak berisi tautan seri yang dikenali.', {
                    kind: 'parse', source: ID,
                });
            }
            return items;
        },

        async search(query, ctx = {}) {
            const page = await client.html(`${base}/search/${encodeURIComponent(query)}/`, ctx);
            return parseAnimeLinks(page.$, base).map(toAnime);
        },

        async getAnime(ref, ctx = {}) {
            const page = await client.html(`${base}/anime/${ref.slug}`, ctx);
            const parsed = parseAnimePage(page.$, base, ref.slug);
            if (!parsed) throw new SourceError('Struktur halaman seri Sakunime tidak dikenali.', { kind: 'parse', source: ID });
            return { ...parsed.anime, episodeList: parsed.episodeList };
        },

        async getEpisode(ref, episode, ctx = {}) {
            const entry = (ctx.anime?.episodeList || []).find((item) => item.number === episode);
            if (!entry?.url) throw notFound(`Episode ${episode} belum tersedia di ${NAME}.`, ID);
            const page = await client.html(entry.url, ctx);
            const parsed = parseEpisodePage(page.$, base);
            if (!parsed?.servers.length) throw new SourceError('Halaman episode Sakunime tidak menyediakan URL server default.', { kind: 'parse', source: ID });
            return makeEpisode({
                episode: parsed.episode || episode,
                title: parsed.title || entry.title,
                url: parsed.url || page.url,
                servers: parsed.servers,
                downloads: parsed.downloads,
            });
        },
    };
}
