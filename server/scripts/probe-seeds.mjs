#!/usr/bin/env node
/**
 * PROBE SEMENTARA (dihapus sebelum PR) — mencari benih donghua yang BENAR-BENAR ada
 * di AnimeKu / HiAnime / AnimeXin, memakai API produksi Kazanime sendiri (bukan
 * scraping baru): `/api/anime/browse?source=<s>&q=<judul>`.
 */
const BASE = 'https://kazanime.vercel.app';
const UA = 'KazanimeBot/1.0 (+https://github.com/Kazaamii/Kazaanime)';

const QUERIES = [
    ['animeku', 'Douluo Dalu'],
    ['animeku', 'Soul Land'],
    ['animeku', 'Swallowed Star'],
    ['animeku', 'Perfect World'],
    ['animeku', 'Battle Through the Heavens'],
    ['hianime', 'Anhe Zhuan'],
    ['hianime', 'Aiyou de Mishi'],
    ['hianime', 'Douluo Dalu'],
    ['hianime', 'Soul Land'],
    ['hianime', 'Perfect World'],
    ['hianime', 'Battle Through the Heavens'],
    ['hianime', 'Throne of Seal'],
    ['hianime', 'Renegade Immortal'],
    ['animexin', 'Perfect World'],
];

function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const lines = [];
for (const [source, q] of QUERIES) {
    const url = `${BASE}/api/anime/browse?source=${source}&q=${encodeURIComponent(q)}`;
    try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        const json = await res.json();
        const items = (json?.data?.items || []).filter((i) => i.source === source);
        const wanted = norm(q);
        const matches = items.filter((i) => norm(i.title).includes(wanted) || norm(i.titleAlt).includes(wanted));
        const show = (matches.length ? matches : items).slice(0, 3).map((i) => i.title);
        lines.push(`${source} | "${q}" -> ${res.status} items=${items.length} match=${matches.length} :: ${show.join(' ; ')}`);
    } catch (err) {
        lines.push(`${source} | "${q}" -> ERROR ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 800));
}

for (const l of lines) console.log(l);
console.log(`::error::${lines.join(' %0A ').replace(/%/g, '%25')}`);
