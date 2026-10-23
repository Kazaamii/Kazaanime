/**
 * Kazanime backend — sources/animeku.js
 * Adapter AnimeKu (https://ww2.animeku.lol) — WordPress dengan tema kustom `aku-*`.
 *
 * Struktur diverifikasi dari HTML asli (23 Okt 2026) yang tersimpan sebagai fixture:
 *   server/test/fixtures/animeku-{home,list,series,episode}.html
 *
 *   - Beranda     : article.aku-rel-sel (rilis terbaru) → a[href="/play/<slug>-episode-N-<id>/"],
 *                   b.aku-rel-eps ("EP 6"), span.aku-rel-judul (judul seri);
 *                   article.aku-sel (kartu seri) → a.aku-bing[href="/<slug>-<id>/"], span.aku-eps,
 *                   span.aku-nilai (skor), h3 a (judul).
 *   - Halaman seri: h1 ("Nonton … Sub Indo HD"), .aku-cap span (jumlah episode/status/studio/skor),
 *                   .aku-fakta-b (kunci–nilai), .aku-cerita (sinopsis),
 *                   daftar episode .aku-epwrap .aku-eplist a[href].
 *   - Episode     : h1.aku-nama-eps ("Nonton … Episode N Sub Indo HD"),
 *                   player .aku-layar iframe[src], tautan "Semua episode" a.aku-link.
 *                   Tidak ada daftar unduhan → downloads: [].
 *
 * Situs memblokir User-Agent browser dari IP pusat data, tetapi menerima User-Agent bot
 * jujur (KazanimeBot). Tidak ada penyamaran UA, rotasi proxy, atau solver challenge.
 * Klaim Sub Indo hanya dari halaman episode itu sendiri (lib/subtitle-evidence.js).
 */
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { applySubtitleEvidence } from '../lib/subtitle-evidence.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import {
    absoluteUrl, cleanText, clip, firstInt, parseEpisodeNumber, parseFormat,
    parseScore10, parseStatus, parseYear, titleKey,
} from '../lib/text.js';

export const ID = 'animeku';
export const NAME = 'AnimeKu';

export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'unknown',
    tos: Object.freeze({
        url: null,
        reviewedAt: '2026-10-23',
        verdict: 'unknown',
        note: 'Belum ada halaman ToS/DMCA yang tertinjau; robots.txt kosong (izinkan semua) saat diperiksa 23 Okt 2026. '
            + 'Situs membalas 403 untuk User-Agent browser dari IP pusat data, tetapi menerima User-Agent bot jujur. '
            + 'Gerbang robots mengikuti SCRAPER_ROBOTS_MODE (default off); 403/429/challenge tidak diulang.',
    }),
});

/** Slug bagian path: huruf kecil, angka, titik, garis. Unicode (mis. "☆") tidak didukung. */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,118}$/;
const EPISODE_SLUG_RE = /-episode-\d+-[a-z0-9]+$/;

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
    const value = $img.attr('src') || $img.attr('data-src');
    return value && !value.startsWith('data:') ? absoluteUrl(value, base) || null : null;
}

/** "Nonton <judul> Sub Indo HD" → judul. */
function cleanTitle(value) {
    return cleanText(value)
        .replace(/^nonton\s+/i, '')
        .replace(/\s+(?:sub\s*indo|subtitle\s+indonesia)(?:\s+hd)?\s*$/i, '')
        .trim();
}

/** `/play/<slug>-episode-<n>-<id>/` → slug (host dan prefix harus tepat). */
export function episodeSlugFromUrl(value, base) {
    try {
        const url = new URL(value, base);
        if (url.origin !== new URL(base).origin) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 2 || parts[0] !== 'play') return null;
        const slug = decodeURIComponent(parts[1]).toLowerCase();
        return EPISODE_SLUG_RE.test(slug) && SLUG_RE.test(slug) ? slug : null;
    } catch {
        return null;
    }
}

/** `/<slug>-<id>/` (bukan /play/, /genre/, /page/) → slug seri. */
export function seriesSlugFromUrl(value, base) {
    try {
        const url = new URL(value, base);
        if (url.origin !== new URL(base).origin) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 1) return null;
        const slug = decodeURIComponent(parts[0]).toLowerCase();
        if (['abjad', 'genre', 'negara', 'page', 'contact', 'disclaimer', 'dmca', 'privacy-policy',
            'terms', 'favorit', 'film-anime', 'jalan', 'selesai', 'baru'].includes(slug)) return null;
        return SLUG_RE.test(slug) ? slug : null;
    } catch {
        return null;
    }
}

/**
 * Kartu beranda: rilis terbaru (episode) dan kartu seri.
 * @returns {{series: object[], episodes: object[]}}
 */
export function parseCards($, base) {
    const series = [];
    $('article.aku-sel').each((_, el) => {
        const card = $(el);
        const anchor = card.find('a.aku-bing[href]').first();
        const url = siteUrl(anchor.attr('href'), base);
        const slug = url ? seriesSlugFromUrl(url, base) : null;
        if (!slug) return;
        const title = cleanText(card.find('h3 a').first().text()) || cleanText(anchor.find('img').first().attr('alt'));
        if (!title) return;
        series.push({
            slug,
            kind: 'series',
            url,
            title,
            image: imageSrc(anchor.find('img').first(), base),
            latestEpisode: parseEpisodeNumber(cleanText(card.find('.aku-eps').first().text())),
            score: parseScore10(cleanText(card.find('.aku-nilai').first().text())),
        });
    });

    const episodes = [];
    $('article.aku-rel-sel').each((_, el) => {
        const card = $(el);
        const anchor = card.find('a[href*="/play/"]').first();
        const url = siteUrl(anchor.attr('href'), base);
        const slug = url ? episodeSlugFromUrl(url, base) : null;
        if (!slug) return;
        const title = cleanText(card.find('.aku-rel-judul').first().text()) || cleanText(anchor.find('img').first().attr('alt'));
        if (!title) return;
        episodes.push({
            slug,
            kind: 'episode',
            url,
            title,
            image: imageSrc(card.find('img').first(), base),
            latestEpisode: parseEpisodeNumber(cleanText(card.find('.aku-rel-eps').first().text())),
        });
    });
    return { series, episodes };
}

function parseEpisodeRows($, base) {
    const rows = [];
    $('.aku-epwrap .aku-eplist a[href]').each((_, el) => {
        const anchor = $(el);
        const url = siteUrl(anchor.attr('href'), base);
        if (!url) return;
        const label = cleanText(anchor.text());
        const number = (/^\d{1,4}$/.test(label) ? Number.parseInt(label, 10) : null)
            || parseEpisodeNumber(label) || parseEpisodeNumber(url);
        if (!number) return;
        rows.push({ number, title: label, url });
    });
    return makeEpisodeList(rows);
}

function facts($) {
    const values = {};
    $('.aku-fakta-b').each((_, el) => {
        const box = $(el);
        const key = cleanText(box.find('.aku-fakta-k').first().text()).toLowerCase();
        if (!key || values[key]) return;
        values[key] = cleanText(box.find('.aku-fakta-v').first().text());
    });
    return values;
}

/** Halaman seri → anime + daftar episode. */
export function parseSeriesPage($, base, ref) {
    const rows = parseEpisodeRows($, base);
    const title = cleanTitle($('h1').first().text());
    if (!title || !rows.length) return null;
    const info = facts($);
    const caps = $('.aku-cap span').map((_, el) => cleanText($(el).text())).get();
    const episodesLabel = caps.find((text) => /episode/i.test(text)) || '';
    const statusLabel = caps.find((text) => /airing|selesai|tamat|ongoing/i.test(text)) || info.status || '';
    const studioLabel = caps.find((text) => /studio|production|animation/i.test(text) && text !== statusLabel) || info.studio || '';
    const scoreLabel = caps.find((text) => /★|score/i.test(text)) || '';
    const anime = makeAnime({
        title,
        titleAlt: '',
        image: imageSrc($('.aku-kepala-gbr img').first(), base)
            || absoluteUrl($('meta[property="og:image"]').attr('content'), base),
        description: cleanText($('.aku-cerita').first().text()) || cleanText($('.aku-ringkas').first().text()),
        genres: info.genre ? info.genre.split(',').map((g) => cleanText(g)).filter(Boolean) : [],
        studios: studioLabel ? [studioLabel] : [],
        status: parseStatus(statusLabel),
        format: parseFormat(info.tipe || info.type || ''),
        year: parseYear(info.tahun || info.year || info.rilis || ''),
        score: parseScore10(scoreLabel) || parseScore10(caps.find((text) => /^\d+(?:[.,]\d+)?$/.test(text)) || ''),
        latestEpisode: rows[rows.length - 1].number,
        episodes: firstInt(episodesLabel) || rows.length,
        country: 'JP',
        slug: encodeSlug(ID, ref.slug),
        source: ID,
        url: `${base}/${ref.slug}/`,
    });
    if (!anime.slug) return null;
    return { anime, episodeList: rows };
}

/** Tautan "Semua episode" di halaman episode → URL seri. */
export function seriesUrlFromEpisode($, base) {
    let found = null;
    $('a.aku-link[href]').each((_, el) => {
        const anchor = $(el);
        if (!/semua episode/i.test(cleanText(anchor.text()))) return;
        found = siteUrl(anchor.attr('href'), base);
    });
    return found;
}

/** Halaman episode: player publik + bukti bahasa dari judul episode itu sendiri. */
export function parseEpisodePage($, base) {
    const servers = [];
    const seen = new Set();
    $('.aku-layar iframe[src], .aku-layar video source[src]').each((_, el) => {
        const node = $(el);
        const url = absoluteUrl(node.attr('src'), base);
        if (!url || seen.has(url)) return;
        seen.add(url);
        const label = cleanText(node.attr('title')) || `Server ${servers.length + 1}`;
        servers.push({ name: clip(label, 40), url });
    });

    const title = cleanText($('h1.aku-nama-eps').first().text()) || cleanText($('h1').first().text());
    const downloads = [];
    const evidence = applySubtitleEvidence(servers, {
        title,
        pageText: $('.aku-fakta').first().text(),
        labels: servers.map((server) => server.name),
        downloads,
    });
    return {
        title: cleanTitle(title),
        episode: parseEpisodeNumber(title) || parseEpisodeNumber($('link[rel="canonical"]').attr('href')),
        url: siteUrl($('link[rel="canonical"]').attr('href'), base),
        seriesUrl: seriesUrlFromEpisode($, base),
        servers: evidence.servers,
        subtitleEvidence: evidence.evidence,
        subtitleEvidenceDetail: evidence.detail,
        downloads,
        episodeList: parseEpisodeRows($, base),
    };
}

export function createAnimeku({ network, createClient, baseUrl }) {
    const base = String(baseUrl || 'https://ww2.animeku.lol').replace(/\/+$/, '');
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
        score: card.score,
        status: 'ONGOING',
        country: 'JP',
        slug: encodeSlug(ID, card.slug),
        source: ID,
        url: card.url,
    });

    /** Rilis terbaru: utamakan kartu episode, dipetakan ke slug seri bila judulnya cocok. */
    async function latest(ctx = {}) {
        const page = await client.html(`${base}/`, ctx);
        const { series, episodes } = parseCards(page.$, base);
        const byTitle = new Map(series.map((card) => [titleKey(card.title), card]));
        const seen = new Set();
        const out = [];
        for (const episode of episodes) {
            const match = byTitle.get(titleKey(episode.title));
            const card = match
                ? { ...episode, slug: match.slug, url: match.url, image: episode.image || match.image }
                : episode;
            if (seen.has(card.slug)) continue;
            seen.add(card.slug);
            const anime = toAnime(card);
            if (anime.slug && anime.latestEpisode) out.push(anime);
        }
        return out;
    }

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
            return ref.slug.replace(/-[a-z0-9]{5,12}$/, '').replace(/-episode-\d+.*$/, '').replace(/-/g, ' ');
        },

        latest,

        async search(query, ctx = {}) {
            const url = new URL(`${base}/`);
            url.searchParams.set('s', query);
            const page = await client.html(url.href, ctx);
            const seen = new Set();
            return parseCards(page.$, base).series
                .filter((card) => (seen.has(card.slug) ? false : seen.add(card.slug)))
                .map(toAnime)
                .filter((anime) => anime.slug);
        },

        async getAnime(ref, ctx = {}) {
            if (EPISODE_SLUG_RE.test(ref.slug)) {
                const page = await client.html(`${base}/play/${ref.slug}/`, ctx);
                const parsedEpisode = parseEpisodePage(page.$, base);
                if (parsedEpisode.seriesUrl) {
                    const seriesPage = await client.html(parsedEpisode.seriesUrl, ctx);
                    const seriesRef = { slug: seriesSlugFromUrl(parsedEpisode.seriesUrl, base) || ref.slug };
                    const parsed = parseSeriesPage(seriesPage.$, base, seriesRef);
                    if (parsed) return { ...parsed.anime, episodeList: parsed.episodeList };
                }
                // Fallback: halaman episode memuat tautan seri, tetapi halaman seri gagal diurai.
                const anime = makeAnime({
                    title: parsedEpisode.title || ref.slug.replace(/-/g, ' '),
                    image: null,
                    latestEpisode: parsedEpisode.episode,
                    country: 'JP',
                    slug: encodeSlug(ID, ref.slug),
                    source: ID,
                    url: page.url,
                });
                const list = parsedEpisode.episode ? makeEpisodeList([{
                    number: parsedEpisode.episode,
                    title: parsedEpisode.title,
                    url: page.url,
                }]) : [];
                return { ...anime, episodeList: list };
            }

            const page = await client.html(`${base}/${ref.slug}/`, ctx);
            const parsed = parseSeriesPage(page.$, base, ref);
            if (!parsed) throw new SourceError('Struktur halaman seri AnimeKu tidak dikenali.', { kind: 'parse', source: ID });
            return { ...parsed.anime, episodeList: parsed.episodeList };
        },

        async getEpisode(ref, episode, ctx = {}) {
            const entry = (ctx.anime?.episodeList || []).find((item) => item.number === episode);
            if (!entry?.url) throw notFound(`Episode ${episode} belum tersedia di ${NAME}.`, ID);
            const page = await client.html(entry.url, ctx);
            const parsed = parseEpisodePage(page.$, base);
            if (!parsed.servers.length) {
                throw new SourceError('Halaman episode AnimeKu tidak berisi iframe pemutar publik.', { kind: 'parse', source: ID });
            }
            return makeEpisode({
                episode,
                title: parsed.title || entry.title || '',
                released: entry.released || '',
                url: parsed.url || page.url,
                servers: parsed.servers,
                downloads: parsed.downloads,
            });
        },
    };
}
