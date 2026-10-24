#!/usr/bin/env node
/**
 * PROBE SEMENTARA (tidak untuk produksi) — dipakai sekali lewat GitHub Actions untuk
 * memastikan apakah AnimeKu / Oploverz benar-benar punya halaman katalog "donghua".
 *
 * Aturan yang sama dengan adapter: User-Agent bot jujur, tanpa header browser, tanpa
 * cookie, tanpa proxy, tanpa retry, tanpa solver. Body tidak disimpan — hanya status,
 * URL akhir, jumlah kartu, dan judul/judul-genre yang terlihat.
 */
import * as cheerio from 'cheerio';

const UA = 'KazanimeBot/1.0 (+https://github.com/Kazaamii/Kazaanime)';
const TIMEOUT_MS = 15000;

const TARGETS = Object.freeze([
    // API aplikasi (dari APK Miku Moe) — diuji ulang dari IP GitHub Actions, bukan sandbox.
    { id: 'animekita-baru', url: 'https://apps.animekita.org/api/v1.2.5/baruupload.php?page=1' },
    { id: 'animekita-root', url: 'https://apps.animekita.org/api/v1.2.5/' },
    // Domain alternatif merek aplikasi.
    { id: 'animeku-tanpa-ww2', url: 'https://animeku.lol/' },
    { id: 'animeloverz-com', url: 'https://animeloverz.com/' },
    { id: 'animeloverz-id', url: 'https://animeloverz.id/' },
    { id: 'oploverz-biz', url: 'https://oploverz.biz/' },
]);

function uniq(list, limit = 40) {
    return [...new Set(list)].slice(0, limit);
}

async function probe(target) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(target.url, {
            headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
            redirect: 'follow',
            signal: controller.signal,
        });
        const type = res.headers.get('content-type') || '';
        const html = await res.text();
        if (!/html/i.test(type)) {
            return {
                id: target.id,
                status: res.status,
                finalUrl: res.url,
                type,
                snippet: html.slice(0, 220).replace(/\s+/g, ' '),
            };
        }
        const $ = cheerio.load(html);
        const cards = {
            article: $('article').length,
            akuSel: $('article.aku-sel').length,
            akuRel: $('article.aku-rel-sel').length,
            bs: $('article.bs').length,
        };
        const titles = uniq($('h3 a, h2[itemprop="headline"], .tt, .aku-rel-judul')
            .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get()
            .filter((t) => t && t.length > 1), 12);
        const genreLinks = uniq([
            ...$('a[href*="/genre/"]').map((_, el) => `${$(el).text().trim()} → ${$(el).attr('href')}`).get(),
            ...$('a[href*="/genres/"]').map((_, el) => `${$(el).text().trim()} → ${$(el).attr('href')}`).get(),
        ], 30);
        const mentions = (html.match(/donghua/gi) || []).length;
        return {
            id: target.id,
            status: res.status,
            finalUrl: res.url,
            type,
            bytes: html.length,
            cards,
            mentionsDonghua: mentions,
            titles,
            genreLinks,
        };
    } catch (err) {
        return { id: target.id, error: `${err?.name || 'Error'}: ${String(err?.message || err).slice(0, 120)}` };
    } finally {
        clearTimeout(timer);
    }
}

const results = [];
for (const target of TARGETS) {
    // Jeda sopan antar-request ke host yang sama (1 dtk/host, sama seperti adapter).
    if (results.length) await new Promise((r) => setTimeout(r, 1100));
    results.push(await probe(target));
}

const lines = results.map((r) => {
    if (r.error) return `${r.id} -> ERROR ${r.error}`;
    if (r.type && !/html/i.test(r.type)) return `${r.id} -> ${r.status} ${r.finalUrl} ${r.type} :: ${r.snippet}`;
    const cards = `article=${r.cards.article}/aku-sel=${r.cards.akuSel}/bs=${r.cards.bs}`;
    const titles = r.titles.slice(0, 5).map((t) => t.slice(0, 48)).join(' | ');
    const genres = r.genreLinks.slice(0, 10).map((g) => g.slice(0, 48)).join(' | ');
    return `${r.id} -> ${r.status} ${r.finalUrl} cards[${cards}] donghua=${r.mentionsDonghua} titles[${titles}] genres[${genres}]`;
});

for (const line of lines) console.log(line);

// Anotasi Actions: satu baris ringkas yang bisa dibaca lewat `gh run view`
// (log mentah tidak bisa diunduh dari sandbox ini). Maks 10 anotasi per langkah.
const compact = lines.join(' %0A ').replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, ' ');
console.log(`::error::${compact}`);
