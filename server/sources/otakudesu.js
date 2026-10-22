/**
 * Kazanime backend — sources/otakudesu.js
 * Adapter Otakudesu (https://otakudesu.blog — domain resmi Okt 2026) — anime Jepang, Sub Indo.
 * Ditambahkan 22 Okt 2026 atas permintaan pemilik proyek.
 *
 * STATUS AKSES (diukur 22 Okt 2026 dari runner GitHub Actions, IP pusat data):
 *   - /?s=<kata kunci>&post_type=anime → 200 (fixture asli: server/test/fixtures/otakudesu-search.html)
 *   - robots.txt, beranda, /ongoing-anime/, /anime/<slug>/, /episode/<slug>/, /jadwal-rilis/ →
 *     403 "Attention Required! | Cloudflare" (blokir WAF untuk IP pusat data), baik dengan UA bot
 *     jujur maupun UA browser. Karena robots.txt tidak terbaca, fetcher menganggap sumber ini
 *     "blocked" → diistirahatkan; tidak ada data palsu. Adapter tetap tersedia supaya langsung
 *     bekerja bila deployment memakai IP/proxy yang tidak diblokir (lihat README: NODE_USE_ENV_PROXY).
 * Struktur halaman anime/episode diambil dari referensi publik (scraper otakudesu.blog Mei–Sep 2026);
 * fixture test untuk halaman itu adalah rekonstruksi struktur, BUKAN salinan halaman asli.
 *
 *   /ongoing-anime/       → .venz ul li .detpost (judul .jdlflm, episode .epz, hari .epztipe)
 *   /anime/<slug>/        → .infozingle (Judul, Japanese, Skor, Tipe, Status, Total Episode, Durasi,
 *                           Tanggal Rilis, Studio, Genre), .fotoanime img, .sinopc, .episodelist
 *   /episode/<slug>/      → server bawaan (.responsive-embed-stream iframe) + download (.download li)
 *                           Mirror lain (.mirrorstream) butuh nonce admin-ajax → tidak dipakai.
 *   /jadwal-rilis/        → .kgjdwl321 .kglist321 (h2 = hari, ul li a = judul)
 */
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import {
    absoluteUrl, cleanText, clip, isDonationUrl, normalizeQuality, parseDurationMinutes, parseEpisodeNumber,
    parseFormat, parseScore10, parseStatus, parseYear,
} from '../lib/text.js';

export const ID = 'otakudesu';
export const NAME = 'Otakudesu';

export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'allowed',
    tos: Object.freeze({
        url: 'https://otakudesu.blog/',
        reviewedAt: '2026-10-22',
        verdict: 'unknown',
        note: 'robots.txt & halaman utama diblokir Cloudflare untuk IP pusat data (403 "Attention Required!"), '
            + 'jadi kebijakan tidak bisa dibaca → fetcher tidak mengakses halaman konten selama robots.txt tidak terbaca.',
    }),
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,118}$/;
const DAY_ID = { minggu: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6, random: null };

/** "https://otakudesu.blog/<jenis>/<slug>/" → slug (jenis = anime | episode). */
export function slugFromUrl(url, base, kind = 'anime') {
    try {
        const u = new URL(url, base);
        if (u.hostname.replace(/^www\./, '') !== new URL(base).hostname.replace(/^www\./, '')) return null;
        const segs = u.pathname.split('/').filter(Boolean);
        if (segs.length !== 2 || segs[0] !== kind) return null;
        const s = decodeURIComponent(segs[1]).toLowerCase();
        return SLUG_RE.test(s) ? s : null;
    } catch {
        return null;
    }
}

/** "Kusuriya no Hitorigoto Season 3 Subtitle Indonesia" / "... Sub Indo" → tanpa akhiran. */
export const cleanTitle = (t) => cleanText(t).replace(/\s*(?:subtitle\s+indonesia|sub\s+indo)\s*$/i, '');

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

/** Hasil pencarian: ul.chivsrc li */
export function parseSearch($, base) {
    const out = [];
    $('ul.chivsrc li').each((_, el) => {
        const li = $(el);
        const a = li.find('h2 a').first();
        const url = absoluteUrl(a.attr('href'), base);
        const slug = url ? slugFromUrl(url, base) : null;
        if (!slug) return;
        const set = {};
        li.find('.set').each((__, s) => {
            const label = cleanText($(s).find('b').first().text()).toLowerCase();
            if (label) set[label] = cleanText($(s).text().replace(/^[^:]*:/, ''));
        });
        out.push({
            slug,
            url,
            title: cleanTitle(a.text()),
            image: imgSrc(li.find('img').first(), base),
            genres: (set.genres || '').split(',').map(cleanText).filter(Boolean),
            status: parseStatus(set.status),
            score: parseScore10(set.rating),
        });
    });
    return out;
}

/** Daftar ongoing (/ongoing-anime/ atau beranda): .venz ul li .detpost */
export function parseOngoing($, base) {
    const out = [];
    $('.venz ul li .detpost').each((_, el) => {
        const card = $(el);
        const a = card.find('a[href]').first();
        const url = absoluteUrl(a.attr('href'), base);
        const slug = url ? slugFromUrl(url, base) : null;
        if (!slug) return;
        out.push({
            slug,
            url,
            title: cleanTitle(card.find('.jdlflm').first().text()) || cleanTitle(a.attr('title')),
            image: imgSrc(card.find('img').first(), base),
            latestEpisode: parseEpisodeNumber(card.find('.epz').first().text()),
        });
    });
    return out;
}

/** Halaman anime: info + daftar episode (blok .episodelist yang judulnya "Episode List"). */
export function parseAnimePage($, base, slug) {
    const info = {};
    const genres = [];
    $('.infozingle p span').each((_, el) => {
        const span = $(el);
        const label = cleanText(span.find('b').first().text()).toLowerCase();
        if (!label || info[label] !== undefined) return;
        const clone = span.clone();
        clone.find('b').first().remove();
        info[label] = cleanText(clone.text()).replace(/^:\s*/, '');
        if (label === 'genre') span.find('a').each((__, g) => { genres.push(cleanText($(g).text())); });
    });
    const title = cleanTitle(info.judul || $('.jdlrx h1, h1').first().text());
    if (!title) return null;

    const raw = [];
    $('.episodelist').each((_, block) => {
        const head = cleanText($(block).find('.monktit').first().text());
        if (!/episode\s+list/i.test(head)) return; // lewati blok Batch & "Lengkap"
        $(block).find('ul li').each((__, li) => {
            const a = $(li).find('a[href]').first();
            const url = absoluteUrl(a.attr('href'), base);
            if (!url || !slugFromUrl(url, base, 'episode')) return;
            const number = parseEpisodeNumber(a.text());
            if (!number) return;
            raw.push({ number, title: cleanTitle(a.text()), released: cleanText($(li).find('.zeebr').first().text()), url });
        });
    });
    const episodeList = makeEpisodeList(raw);
    const latestEpisode = episodeList.length ? episodeList[episodeList.length - 1].number : null;
    const total = Number.parseInt(info['total episode'], 10);

    return {
        anime: makeAnime({
            title,
            titleAlt: info.japanese || '',
            image: imgSrc($('.fotoanime img').first(), base),
            description: $('.sinopc p').map((__, p) => cleanText($(p).text())).get().filter(Boolean).join('\n\n'),
            episodes: Number.isInteger(total) && total > 0 ? total : null,
            latestEpisode,
            genres,
            score: parseScore10(info.skor),
            status: parseStatus(info.status),
            format: parseFormat(info.tipe),
            year: parseYear(info['tanggal rilis']),
            country: 'JP',
            studios: info.studio ? info.studio.split(',') : [],
            duration: parseDurationMinutes(info.durasi),
            slug: encodeSlug(ID, slug),
            source: ID,
            url: `${base}/anime/${slug}/`,
        }),
        episodeList,
    };
}

/** Halaman episode: server bawaan + link download. */
export function parseEpisodePage($, base) {
    const servers = [];
    const def = absoluteUrl($('.responsive-embed-stream iframe, #pembed iframe').first().attr('src'), base);
    if (def) {
        let host = '';
        try { host = new URL(def).hostname.replace(/^www\./, ''); } catch { /* biarkan kosong */ }
        servers.push({ name: host.split('.')[0] || 'Otakudesu', url: def, lang: 'id' });
    }
    const downloads = [];
    $('.download ul li').each((_, el) => {
        const li = $(el);
        const head = cleanText(li.find('strong').first().text());
        const links = li.find('a[href]')
            .map((__, a) => ({ provider: cleanText($(a).text()), url: absoluteUrl($(a).attr('href'), base) }))
            .get()
            .filter((l) => l.url && !isDonationUrl(l.url));
        if (!links.length) return;
        downloads.push({
            quality: normalizeQuality(head),
            size: clip(li.find('i').first().text(), 20),
            format: /mkv/i.test(head) ? 'MKV' : /mp4/i.test(head) ? 'MP4' : '',
            subtitle: 'Sub Indo',
            links,
        });
    });
    return { title: cleanTitle($('h1.posttl, .venutama h1').first().text()), servers, downloads };
}

/** /jadwal-rilis/ → { hari: [{title, slug, url}] } */
export function parseSchedulePage($, base) {
    const out = {};
    $('.kglist321').each((_, el) => {
        const box = $(el);
        const name = cleanText(box.find('h2').first().text()).toLowerCase().replace(/[^a-z]/g, '');
        const day = DAY_ID[name];
        if (day == null) return;
        const seen = new Set();
        box.find('ul li a[href]').each((__, a) => {
            const url = absoluteUrl($(a).attr('href'), base);
            const slug = url ? slugFromUrl(url, base) : null;
            if (!slug || seen.has(slug)) return;
            seen.add(slug);
            (out[day] ||= []).push({ title: cleanTitle($(a).text()), slug, url });
        });
    });
    return out;
}

/**
 * @param {{network: any, createClient: Function, baseUrl: string}} deps
 */
export function createOtakudesu({ network, createClient, baseUrl, sourceConfig = {} }) {
    const base = String(baseUrl || 'https://otakudesu.blog').replace(/\/+$/, '');
    const host = new URL(base).hostname.replace(/^www\./, '');
    const client = createClient(network, {
        source: ID,
        allowedHosts: [host, `www.${host}`],
        cookies: sourceConfig.cookiesEnabled ?? true,
        renderJavaScript: Boolean(sourceConfig.renderJavaScript),
    });

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        country: 'JP',
        policy: POLICY,

        parseRef(parts) {
            const s = String(parts[0] || '').toLowerCase();
            return parts.length === 1 && SLUG_RE.test(s) ? { slug: s } : null;
        },

        titleHint(ref) {
            return ref.slug.replace(/-sub-indo$/, '').replace(/-/g, ' ');
        },

        async latest(ctx = {}) {
            const page = await client.html(`${base}/ongoing-anime/`, ctx);
            const items = parseOngoing(page.$, base);
            if (!items.length) throw new SourceError('Struktur halaman Ongoing Otakudesu berubah.', { kind: 'parse', source: ID });
            return items.map((it) => makeAnime({
                title: it.title,
                image: it.image,
                latestEpisode: it.latestEpisode,
                status: 'ONGOING',
                country: 'JP',
                slug: encodeSlug(ID, it.slug),
                source: ID,
                url: it.url,
            }));
        },

        async search(q, ctx = {}) {
            const url = new URL(`${base}/`);
            url.searchParams.set('s', q);
            url.searchParams.set('post_type', 'anime');
            const page = await client.html(url.href, ctx);
            return parseSearch(page.$, base).map((c) => makeAnime({
                title: c.title,
                image: c.image,
                genres: c.genres,
                status: c.status,
                score: c.score,
                country: 'JP',
                slug: encodeSlug(ID, c.slug),
                source: ID,
                url: c.url,
            }));
        },

        async getAnime(ref, ctx = {}) {
            const page = await client.html(`${base}/anime/${ref.slug}/`, ctx);
            const parsed = parseAnimePage(page.$, base, ref.slug);
            if (!parsed) throw new SourceError('Struktur halaman anime Otakudesu tidak dikenali.', { kind: 'parse', source: ID });
            return { ...parsed.anime, episodeList: parsed.episodeList };
        },

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
                servers: parsed.servers,
                downloads: parsed.downloads,
            });
        },

        /** Jadwal rilis per hari (tanpa jam). */
        async schedule(ctx = {}) {
            const page = await client.html(`${base}/jadwal-rilis/`, ctx);
            const days = parseSchedulePage(page.$, base);
            if (!Object.values(days).some((d) => d.length)) {
                throw new SourceError('Struktur halaman Jadwal Rilis Otakudesu berubah.', { kind: 'parse', source: ID });
            }
            const out = {};
            for (const [day, items] of Object.entries(days)) {
                out[day] = items.map((it) => ({ title: it.title, time: null, slug: encodeSlug(ID, it.slug), url: it.url, image: null, country: 'JP', source: ID }));
            }
            return out;
        },
    };
}
