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
    { id: 'animeku-home', url: 'https://ww2.animeku.lol/' },
    { id: 'animeku-genre-donghua', url: 'https://ww2.animeku.lol/genre/donghua/' },
    { id: 'animeku-genre-aksi', url: 'https://ww2.animeku.lol/genre/aksi/' },
    { id: 'animeku-negara-china', url: 'https://ww2.animeku.lol/negara/china-n5z6n97/' },
    { id: 'animeku-search-anhe', url: 'https://ww2.animeku.lol/?s=Anhe+Zhuan' },
    { id: 'animeku-search-aiyou', url: 'https://ww2.animeku.lol/?s=Aiyou+de+Mishi' },
    { id: 'oploverz-home', url: 'https://oploverz.ch/' },
    { id: 'oploverz-genres-donghua', url: 'https://oploverz.ch/genres/donghua/' },
    { id: 'oploverz-search-summer', url: 'https://oploverz.ch/?s=Summer+Punch' },
    { id: 'oploverz-search-divine', url: 'https://oploverz.ch/?s=Divine+Manifestation' },
    { id: 'oploverz-search-loose', url: 'https://oploverz.ch/?s=King+of+Loose+Cultivators' },
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
        const html = await res.text();
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

for (const r of results) {
    console.log(`\n=== ${r.id} ===`);
    if (r.error) {
        console.log(`error: ${r.error}`);
        continue;
    }
    console.log(`status: ${r.status} | final: ${r.finalUrl} | bytes: ${r.bytes} | "donghua" di HTML: ${r.mentionsDonghua}`);
    console.log(`kartu: article=${r.cards.article} aku-sel=${r.cards.akuSel} aku-rel-sel=${r.cards.akuRel} bs=${r.cards.bs}`);
    console.log(`judul: ${JSON.stringify(r.titles)}`);
    console.log(`genre link: ${JSON.stringify(r.genreLinks)}`);
}
