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
import { applySubtitleEvidence, textShowsIndonesianSubtitle } from '../lib/subtitle-evidence.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import {
    absoluteUrl, cleanText, clip, firstInt, parseEpisodeNumber, parseFormat,
    parseScore10, parseStatus, parseYear, stripSeason, titleKey,
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

const NAV_TTL_MS = 6 * 60 * 60 * 1000;
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

        const episodeTitle = decodeEntities(card.find('h2[itemprop="headline"]').first().text())
            || decodeEntities(card.find('h2').first().text())
            || decodeEntities(anchor.attr('title'));
        const tt = card.find('.tt').first().clone();
        tt.find('h2').remove();
        const seriesTitle = decodeEntities(tt.text())
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
            status: parseStatus(label),
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
            // Judul baris daftar episode memuat "Episode N Subtitle Indonesia" → bukti bahasa
            // per episode tanpa permintaan tambahan (24 Okt 2026). Tanpa frasa itu, episode
            // ditandai '' (sudah diperiksa, belum ada bukti) supaya badge tidak dikarang.
            ...(title ? { sub: textShowsIndonesianSubtitle(title) ? 'id' : '' } : {}),
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

/**
 * Urutan/filter yang benar-benar diterima `/series/` (form filter situs, 23 Okt 2026):
 * order=update|popular|rating, status=ongoing|completed|upcoming, type=movie|drama|...
 * "Upcoming" tidak dipakai: saat dicek, halaman `?status=upcoming` tidak berisi kartu.
 */
/** Jumlah judul donghua yang dicari & batas hasil per permintaan (24 Okt 2026). */
const DONGHUA_QUERIES = 3;
const DONGHUA_LIMIT = 24;

export const BROWSE_FILTERS = Object.freeze([
    { id: 'update', label: 'Terbaru', params: { order: 'update' } },
    { id: 'popular', label: 'Populer', params: { order: 'popular' } },
    { id: 'rating', label: 'Rating Tertinggi', params: { order: 'rating' } },
    { id: 'ongoing', label: 'Ongoing', params: { status: 'ongoing' } },
    { id: 'completed', label: 'Complete', params: { status: 'completed' } },
    { id: 'movie', label: 'Movie', params: { type: 'movie' } },
]);

/** Genre dari form filter `/series/` (80 genre) — id dipakai apa adanya di `?genre[]=`. */
export function parseGenreOptions($) {
    const out = [];
    const seen = new Set();
    $('input[name="genre[]"][value]').each((_, el) => {
        const input = $(el);
        const id = cleanText(input.attr('value')).toLowerCase();
        if (!/^[a-z0-9-]{2,40}$/.test(id) || seen.has(id)) return;
        const label = cleanText($(`label[for="${input.attr('id')}"]`).first().text()) || id;
        seen.add(id);
        out.push({ id, label });
    });
    return out;
}

/**
 * Musim dari form filter `/series/` (`input[name="season[]"]`, nilai `summer-2026`).
 * Oploverz tidak punya field tahun terpisah — tahun dibaca dari nilai musim.
 * @returns {{id: string, label: string, season: string, year: number}[]}
 */
export function parseSeasonOptions($) {
    const out = [];
    const seen = new Set();
    const LABELS = { winter: 'Winter', spring: 'Spring', summer: 'Summer', fall: 'Fall' };
    $('input[name="season[]"][value]').each((_, el) => {
        const input = $(el);
        const id = cleanText(input.attr('value')).toLowerCase();
        const m = /^(winter|spring|summer|fall)-(\d{4})$/.exec(id);
        if (!m || seen.has(id)) return;
        seen.add(id);
        const label = cleanText($(`label[for="${input.attr('id')}"]`).first().text())
            || `${LABELS[m[1]]} ${m[2]}`;
        out.push({ id, label, season: m[1], year: Number(m[2]) });
    });
    const order = { winter: 0, spring: 1, summer: 2, fall: 3 };
    return out.sort((a, b) => b.year - a.year || order[b.season] - order[a.season]);
}

/** URL halaman berikutnya dari `<link rel=next>` / `a.next.page-numbers`. */
export function nextPageHref($, base) {
    return siteUrl($('link[rel="next"]').attr('href'), base)
        || siteUrl($('a.next.page-numbers').first().attr('href'), base);
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
    /** Daftar genre dari form filter situs; dimuat sekali lalu dipakai ulang. */
    let genreCache = null;
    /** Daftar musim (`summer-2026`, …) dari form filter yang sama. */
    let seasonCache = null;

    const toAnime = (card) => makeAnime({
        title: card.title,
        image: card.image,
        latestEpisode: card.latestEpisode,
        format: card.format,
        status: card.latestEpisode ? 'ONGOING' : parseStatus(card.label),
        country: card.country || 'JP',
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
        supportsBrowse: true,

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

        /** Opsi urutan + genre + musim dari form `/series/` (di-cache 6 jam). */
        browseOptions() {
            return {
                filters: BROWSE_FILTERS.map(({ id, label }) => ({ id, label })),
                genres: genreCache?.list || [],
                seasons: (seasonCache?.list || []).map(({ id, label, season, year }) => ({ id, label, season, year })),
            };
        },

        /**
         * Daftar genre + musim untuk panel Jelajah (permintaan 24 Okt 2026).
         * Satu permintaan `/series/` mengisi kedua cache.
         */
        async genres(ctx = {}) {
            const fresh = genreCache && seasonCache && Date.now() - genreCache.at < NAV_TTL_MS;
            if (!fresh) {
                const res = await client.html(`${base}/series/`, ctx);
                const list = parseGenreOptions(res.$);
                const seasons = parseSeasonOptions(res.$);
                if (list.length) genreCache = { at: Date.now(), list };
                if (seasons.length) seasonCache = { at: Date.now(), list: seasons };
            }
            return {
                genres: (genreCache?.list || []).map(({ id, label }) => ({ id, label })),
                seasons: (seasonCache?.list || []).map(({ id, label, season, year }) => ({ id, label, season, year })),
            };
        },

        /**
         * Halaman daftar `/series/`: filter = id urutan/status/tipe, genre = id genre,
         * `year` + `season` = musim (nilai `season[]` berbentuk `summer-2026`).
         * @param {{filter?: string, genre?: string, page?: number, year?: number|string, season?: string}} opts
         */
        async browse({ filter = '', genre = '', page = 1, year = '', season = '' } = {}, ctx = {}) {
            const chosen = BROWSE_FILTERS.find((item) => item.id === filter) || BROWSE_FILTERS[0];
            const params = new URLSearchParams(chosen.params);
            if (genre) params.append('genre[]', genre);
            // Musim: satu nilai bila musim dipilih; empat nilai bila hanya tahun dipilih.
            const seasonName = /^(winter|spring|summer|fall)$/.test(String(season || '').toLowerCase())
                ? String(season).toLowerCase()
                : '';
            const seasonYear = /^\d{4}$/.test(String(year || '')) ? String(year) : '';
            if (seasonYear) {
                // Format nilai diambil dari form filter & tautan arsip situs (`fall-2026`). Semua nilai
                // diminta apa adanya: menyaring ke daftar cache akan diam-diam mempersempit hasil
                // (mis. tahun yang hanya sebagian ada di form) sehingga filter tahun jadi menyesatkan.
                const values = seasonName
                    ? [`${seasonName}-${seasonYear}`]
                    : ['winter', 'spring', 'summer', 'fall'].map((name) => `${name}-${seasonYear}`);
                for (const value of values) params.append('season[]', value);
            }
            const path = page > 1 ? `/series/page/${page}/` : '/series/';
            const query = params.toString();
            const res = await client.html(`${base}${path}${query ? `?${query}` : ''}`, ctx);
            if (!genreCache || Date.now() - genreCache.at > NAV_TTL_MS) {
                const list = parseGenreOptions(res.$);
                if (list.length) genreCache = { at: Date.now(), list };
            }
            if (!seasonCache || Date.now() - seasonCache.at > NAV_TTL_MS) {
                const list = parseSeasonOptions(res.$);
                if (list.length) seasonCache = { at: Date.now(), list };
            }
            const seen = new Set();
            const items = parseCards(res.$, base)
                .filter((card) => card.kind === 'series')
                .filter((card) => (seen.has(card.slug) ? false : seen.add(card.slug)))
                .map(toAnime)
                .filter((anime) => anime.slug);
            return {
                items,
                page,
                hasNext: Boolean(nextPageHref(res.$, base)),
                filters: BROWSE_FILTERS.map(({ id, label }) => ({ id, label })),
                genres: genreCache?.list || [],
                seasons: (seasonCache?.list || []).map(({ id, label, season: name, year: seasonYearValue }) => ({
                    id, label, season: name, year: seasonYearValue,
                })),
                filter: chosen.id,
                genre,
                year: seasonYear,
                season: seasonName,
            };
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

        /**
         * Donghua di Oploverz (24 Okt 2026, permintaan pengguna: donghua harus ada di
         * Oploverz DAN AnimeKu). Situs tidak punya kategori donghua, jadi judul donghua yang
         * sedang tayang (metadata AniList, negara CN) dicari lewat `?s=`, lalu hanya kartu
         * seri yang judulnya cocok yang dipakai. Tidak ada klaim Sub Indo per judul.
         *
         * @param {string[]} titles judul donghua dari metadata
         * @param {object} ctx
         */
        async browseDonghua(titles = [], ctx = {}) {
            const queries = [...new Set((Array.isArray(titles) ? titles : [])
                .map((title) => cleanText(title))
                .filter((title) => title.length >= 4))]
                .slice(0, DONGHUA_QUERIES);
            const items = [];
            const seen = new Set();
            for (const query of queries) {
                const key = titleKey(stripSeason(query));
                if (!key) continue;
                const url = new URL(`${base}/`);
                url.searchParams.set('s', query);
                let cards = [];
                try {
                    const page = await client.html(url.href, ctx);
                    cards = parseCards(page.$, base).filter((card) => card.kind === 'series');
                } catch (error) {
                    // Satu kueri gagal: pakai hasil kueri lain bila sudah ada.
                    if (items.length) break;
                    throw error;
                }
                for (const card of cards) {
                    const cardKey = titleKey(stripSeason(card.title));
                    const related = cardKey === key
                        || (key.length >= 5 && cardKey.includes(key))
                        || (cardKey.length >= 5 && key.includes(cardKey));
                    if (!related) continue;
                    const slug = encodeSlug(ID, card.slug);
                    if (!slug || seen.has(slug)) continue;
                    seen.add(slug);
                    items.push(toAnime({ ...card, country: 'CN' }));
                }
            }
            return items.slice(0, DONGHUA_LIMIT);
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
