/**
 * Kazanime backend — sources/anichin.js
 * Adapter Anichin (https://anichin.moe) — situs donghua Sub Indo, tema WordPress "AnimeStream"
 * (tema yang sama dengan AnimeXin) → parser halaman daftar/seri/episode dipakai bersama dari
 * ./animexin.js. Ditambahkan 22 Okt 2026 atas permintaan pemilik proyek.
 *
 * Diverifikasi langsung 22 Okt 2026 dari runner GitHub Actions (fixture: server/test/fixtures/anichin-*):
 *   robots.txt : "User-agent: * / Allow: /" + "Disallow: /wp-admin/" (Content-Signal Cloudflare:
 *                search=yes, ai-train=no — Kazanime bukan pelatihan AI).
 *   /anime/?order=update  → kartu seri terbaru diperbarui (.listupd article.bs)
 *   /                     → blok "Latest Release" (nomor episode terbaru) — sering kena challenge
 *   /?s=<kata kunci>      → pencarian seri
 *   /<slug-seri>/         → detail + SEMUA episode (.eplister); sebagian tautan menu memakai
 *                           /anime/<slug-seri>/ (halaman yang sama)
 *   /<slug-episode>/      → server (select.mirror → iframe base64) + link download (.soraddlx)
 *   /schedule/            → jadwal per hari (.bixbox.schedulepage) + jam rilis perkiraan
 * Semua subtitle Anichin berbahasa Indonesia → server diberi lang 'id'.
 * Gambar /wp-content/uploads boleh ditampilkan di situs lain (200 tanpa Referer, tanpa CORP).
 * Cloudflare challenge → request dihentikan tanpa retry, circuit dibuka, dan aggregator memakai fallback.
 */
import { makeAnime, makeEpisode } from '../lib/anime.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import { absoluteUrl, cleanText, fixStatus, parseEpisodeNumber, parseStatus } from '../lib/text.js';
import {
    deriveSeriesSlug, parseEpisodePage, parseLatestHome, parseSeriesCards, parseSeriesPage,
    scheduleSlugFromUrl, seriesSlugFromUrl,
} from './animexin.js';

export const ID = 'anichin';
export const NAME = 'Anichin';

export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'allowed',
    tos: Object.freeze({
        url: 'https://anichin.moe/robots.txt',
        reviewedAt: '2026-10-22',
        verdict: 'unknown',
        note: 'Tidak ada halaman Terms of Service yang tertaut. robots.txt mengizinkan semua path kecuali /wp-admin/; '
            + 'Content-Signal Cloudflare melarang pelatihan AI (tidak relevan). Diakses hanya selama robots.txt mengizinkan.',
    }),
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,118}$/;
const DAY_CLASS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DAY_ID = { minggu: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6 };
const pad2 = (n) => String(n).padStart(2, '0');
const tod = (sec) => ((Math.round(sec) % 86400) + 86400) % 86400;
const clock = (sec) => `${pad2(Math.floor(tod(sec) / 3600))}:${pad2(Math.floor((tod(sec) % 3600) / 60))}`;

function imgSrc($img, base) {
    for (const attr of ['data-src', 'data-lazy-src', 'src']) {
        const v = $img.attr(attr);
        if (v && !v.startsWith('data:')) {
            const u = absoluteUrl(v, base);
            if (u) return u;
        }
    }
    return null;
}

/**
 * /schedule/ Anichin: blok `.bixbox.schedulepage.sch_<hari>` berisi kartu `.bsx`.
 * Jam rilis: teks "Jam HH:MM" (WIB, mutlak) untuk yang sudah rilis hari itu; yang lain hanya punya
 * hitung mundur `data-cndwn` (detik) RELATIF terhadap saat halaman di-render — halaman ini di-cache
 * situsnya (terukur ±2 jam), jadi waktu render dikalibrasi dari item ber-"Jam" (median), lalu
 * jam item lain = waktu render + hitung mundur. Tanpa item ber-"Jam" → jam = null (tidak ditebak).
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} base
 * @returns {Record<number, {title: string, slug: string, url: string, time: string|null, image: string|null, episode: number|null}[]>}
 */
export function parseSchedulePage($, base) {
    const raw = [];
    $('.bixbox.schedulepage').each((_, el) => {
        const box = $(el);
        const cls = /\bsch_([a-z]+)/.exec(box.attr('class') || '')?.[1];
        let day = DAY_CLASS[cls];
        if (day === undefined) {
            const name = cleanText(box.find('.releases h3').first().text()).toLowerCase().replace(/[^a-z]/g, '');
            day = DAY_ID[name];
        }
        if (day === undefined) return;
        box.find('.bsx').each((__, b) => {
            const card = $(b);
            const a = card.find('a[href]').first();
            const url = absoluteUrl(a.attr('href'), base);
            const slug = url ? scheduleSlugFromUrl(url, base) : null;
            if (!slug) return;
            const epx = card.find('.epx').first();
            const cd = Number.parseInt(epx.attr('data-cndwn'), 10);
            const jam = /\bjam\s+(\d{1,2})[:.](\d{2})\b/i.exec(cleanText(epx.text()));
            raw.push({
                day,
                slug,
                url,
                title: cleanText(card.find('.tt').first().text()) || cleanText(a.attr('title')),
                image: imgSrc(card.find('img').first(), base),
                episode: parseEpisodeNumber(`Episode ${cleanText(card.find('.sb').first().text())}`),
                cd: Number.isFinite(cd) && Math.abs(cd) < 8 * 86400 ? cd : null,
                jam: jam && Number(jam[1]) < 24 ? Number(jam[1]) * 3600 + Number(jam[2]) * 60 : null,
            });
        });
    });

    // Kalibrasi waktu render (detik sejak 00:00 WIB) dari item "Jam HH:MM" + hitung mundurnya.
    const offsets = raw.filter((r) => r.jam != null && r.cd != null).map((r) => tod(r.jam - r.cd)).sort((x, y) => x - y);
    const render = offsets.length ? offsets[Math.floor(offsets.length / 2)] : null;

    const out = {};
    const seen = new Map();
    for (const r of raw) {
        const key = `${r.day}:${r.slug}`;
        if (seen.has(key)) continue;
        seen.set(key, true);
        let time = null;
        if (r.jam != null) time = clock(r.jam);
        else if (r.cd != null && render != null) time = clock(render + r.cd);
        (out[r.day] ||= []).push({ title: r.title, slug: r.slug, url: r.url, time, image: r.image, episode: r.episode });
    }
    return out;
}

/** Bagian slug setelah "anichin~": "slug" atau "anime~slug" (tautan menu /anime/<slug>/). */
function refOf(parts) {
    const p = parts.map((x) => String(x || '').toLowerCase());
    if (p.length === 1 && SLUG_RE.test(p[0])) return { slug: p[0] };
    if (p.length === 2 && p[0] === 'anime' && SLUG_RE.test(p[1])) return { slug: p[1], prefixed: true };
    return null;
}

/**
 * @param {{network: any, createClient: Function, baseUrl: string}} deps
 */
export function createAnichin({ network, createClient, baseUrl }) {
    const base = String(baseUrl || 'https://anichin.moe').replace(/\/+$/, '');
    const host = new URL(base).hostname.replace(/^www\./, '');
    const client = createClient(network, {
        source: ID,
        allowedHosts: [host, `www.${host}`],
        blockedMs: 5 * 60 * 1000,
    });

    /** Anime hasil parser AnimeXin → milik Anichin (slug, sumber, URL). */
    const own = (anime, slug) => ({ ...anime, slug: encodeSlug(ID, slug), source: ID, country: anime.country || 'CN', url: `${base}/${slug}/` });

    async function loadSeries(slug, ctx, { prefixed = false } = {}) {
        const paths = prefixed ? [`anime/${slug}`, slug] : [slug, `anime/${slug}`];
        let lastErr = null;
        for (const p of paths) {
            try {
                const page = await client.html(`${base}/${p}/`, ctx);
                return { page, parsed: parseSeriesPage(page.$, base, slug) };
            } catch (err) {
                if (err?.kind !== 'not_found') throw err;
                lastErr = err;
            }
        }
        throw lastErr || notFound(`Seri tidak ditemukan di ${NAME}.`, ID);
    }

    const cardToAnime = (c) => makeAnime({
        title: c.title,
        image: c.image,
        latestEpisode: c.latestEpisode,
        status: parseStatus(c.statusText),
        format: c.format,
        country: 'CN',
        slug: encodeSlug(ID, c.slug),
        source: ID,
        url: c.url,
    });

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        country: 'CN',
        policy: POLICY,

        parseRef: refOf,

        titleHint(ref) {
            return ref.slug.replace(/-episode-\d+.*$/, '').replace(/-/g, ' ');
        },

        /** Donghua terbaru: blok "Latest Release" beranda (nomor episode) + kartu seri diurut update. */
        async latest(ctx = {}) {
            const [home, list] = await Promise.allSettled([
                client.html(`${base}/`, ctx),
                client.html(`${base}/anime/?status=&type=&order=update`, ctx),
            ]);
            const cards = list.status === 'fulfilled' ? parseSeriesCards(list.value.$, base) : [];
            const latest = home.status === 'fulfilled' ? parseLatestHome(home.value.$, base) : [];
            if (!latest.length && !cards.length) {
                if (home.status === 'rejected' && list.status === 'rejected') throw home.reason;
                throw new SourceError('Struktur halaman Anichin berubah (daftar rilis kosong).', { kind: 'parse', source: ID });
            }
            const byId = new Map(cards.filter((c) => c.seriesId).map((c) => [c.seriesId, c]));
            const seen = new Set();
            const items = [];
            for (const it of latest) {
                const card = it.seriesId ? byId.get(it.seriesId) : null;
                const slug = card?.slug || deriveSeriesSlug(it.episodeUrl, base)?.replace(/-subtitle-indonesia$/, '');
                if (!slug || seen.has(slug)) continue;
                seen.add(slug);
                items.push(makeAnime({
                    title: it.title || card?.title,
                    image: it.image || card?.image,
                    latestEpisode: it.latestEpisode,
                    format: it.format || card?.format,
                    status: fixStatus(card ? parseStatus(card.statusText) : 'ONGOING', it.latestEpisode),
                    country: 'CN',
                    slug: encodeSlug(ID, slug),
                    source: ID,
                    url: card?.url || `${base}/${slug}/`,
                }));
            }
            for (const c of cards) {
                if (seen.has(c.slug)) continue;
                seen.add(c.slug);
                items.push(cardToAnime(c));
            }
            return items;
        },

        async search(q, ctx = {}) {
            const url = new URL(`${base}/`);
            url.searchParams.set('s', q);
            const page = await client.html(url.href, ctx);
            return parseSeriesCards(page.$, base).map(cardToAnime);
        },

        async getAnime(ref, ctx = {}) {
            let { page, parsed } = await loadSeries(ref.slug, ctx, ref);
            let slug = ref.slug;
            if (!parsed) {
                // Slug ternyata halaman episode → ikuti tautan "Semua Episode" ke halaman seri.
                const ep = parseEpisodePage(page.$, base);
                const seriesSlug = ep.seriesUrl ? (seriesSlugFromUrl(ep.seriesUrl, base) || scheduleSlugFromUrl(ep.seriesUrl, base)) : null;
                if (seriesSlug && seriesSlug !== ref.slug) {
                    ({ parsed } = await loadSeries(seriesSlug, ctx));
                    slug = seriesSlug;
                }
            }
            if (!parsed) throw new SourceError('Struktur halaman seri Anichin tidak dikenali.', { kind: 'parse', source: ID });
            return { ...own(parsed.anime, slug), episodeList: parsed.episodeList };
        },

        /**
         * @param {{slug: string}} ref
         * @param {number} ep
         * @param {{anime?: {episodeList?: {number: number, url: string|null, title: string, released: string}[]}}} ctx
         */
        async getEpisode(ref, ep, ctx = {}) {
            const entry = (ctx.anime?.episodeList || []).find((e) => e.number === ep);
            if (!entry?.url) throw notFound(`Episode ${ep} belum tersedia di ${NAME}.`, ID);
            const page = await client.html(entry.url, ctx);
            const parsed = parseEpisodePage(page.$, base);
            return makeEpisode({
                episode: ep,
                title: parsed.title || entry.title,
                released: entry.released,
                url: page.url,
                // Anichin hanya merilis subtitle Indonesia.
                servers: parsed.servers.map((s) => ({ ...s, lang: s.lang || 'id' })),
                downloads: parsed.downloads.map((d) => ({ ...d, subtitle: d.subtitle || 'Sub Indo' })),
            });
        },

        /** Jadwal donghua per hari (0 = Minggu) + jam rilis perkiraan (WIB). */
        async schedule(ctx = {}) {
            const page = await client.html(`${base}/schedule/`, ctx);
            const days = parseSchedulePage(page.$, base);
            const total = Object.values(days).reduce((n, d) => n + d.length, 0);
            if (!total) throw new SourceError('Struktur halaman Schedule Anichin berubah.', { kind: 'parse', source: ID });
            const out = {};
            for (const [day, items] of Object.entries(days)) {
                out[day] = items.map((it) => ({
                    title: it.title,
                    time: it.time,
                    slug: encodeSlug(ID, it.slug),
                    url: it.url,
                    image: it.image,
                    country: 'CN',
                    source: ID,
                }));
            }
            return out;
        },
    };
}
