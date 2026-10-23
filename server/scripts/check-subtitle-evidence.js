#!/usr/bin/env node
/**
 * Kazanime — server/scripts/check-subtitle-evidence.js
 * Bukti "Sub Indo" **per episode**, bukan asumsi bahwa situsnya situs Indonesia.
 *
 * Skrip ini mengurai halaman episode yang tersimpan di `server/test/fixtures/`
 * lewat parser adapter asli, lalu menampilkan bukti bahasa yang ditemukan:
 * kutipan judul/deskripsi episode, label download, atau label server.
 *
 *   npm run check:subindo                    → semua halaman contoh
 *   npm run check:subindo -- samehadaku      → satu sumber saja
 *
 * Tanpa internet dan tanpa menyentuh situs mana pun. Untuk halaman asli, pakai
 * `npm run check:sources -- --live`: baris `subtitle` di sana menampilkan bukti
 * yang sama dari halaman episode live.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import { parseEpisodePage as parseSamehadaku } from '../sources/samehadaku.js';
import { parseEpisodePage as parseOtakudesu } from '../sources/otakudesu.js';
import { parseEpisodePage as parseSakunime } from '../sources/sakunime.js';
import { parseEpisodePage as parseKuramanime } from '../sources/kuramanime.js';
import { parseEpisodePage as parseAnoboy } from '../sources/anoboy.js';
import { parseEpisodePage as parseAnimexin } from '../sources/animexin.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

/**
 * Halaman contoh. `expect` hanya dokumentasi untuk pembaca laporan; skrip tetap
 * mencetak apa pun yang benar-benar ditemukan parser.
 *
 * Bukti terakhir (`episode-page`) berasal dari blok deskripsi episode itu sendiri.
 * Teks tagline situs (mis. "Samehadaku - Nonton Streaming Anime Sub Indo" di footer
 * atau header) tidak ikut dikirim parser, jadi tidak bisa meloloskan judul.
 */
export const CASES = Object.freeze([
    { source: 'samehadaku', file: 'samehadaku-episode.html', base: 'https://v2.samehadaku.how/', parse: parseSamehadaku },
    {
        source: 'samehadaku', file: 'samehadaku-fx-senshi-episode.html', base: 'https://v2.samehadaku.how/', parse: parseSamehadaku,
        note: 'kontrol negatif — situs yang sama, halaman tanpa penanda',
    },
    { source: 'otakudesu', file: 'otakudesu-episode.html', base: 'https://otakudesu.blog/', parse: parseOtakudesu },
    { source: 'sakunime', file: 'sakunime-episode.html', base: 'https://sakunime.com/', parse: parseSakunime },
    { source: 'kuramanime', file: 'kuramanime-episode.html', base: 'https://v9.kuramanime.work/', parse: parseKuramanime },
    {
        source: 'kuramanime', file: 'kuramanime-episode-public.html', base: 'https://v9.kuramanime.work/', parse: parseKuramanime,
        note: 'server publik; halaman tidak menyebut bahasa',
    },
    { source: 'anoboy', file: 'anoboy-episode.html', base: 'https://anoboy07.com/', parse: parseAnoboy },
    { source: 'animexin', file: 'animexin-episode.html', base: 'https://animexin.dev/', parse: parseAnimexin },
    {
        source: 'animexin', file: 'animexin-mirror-variants.html', base: 'https://animexin.dev/', parse: parseAnimexin,
        note: 'label "Direct (Sub Indo)" vs mirror tanpa label',
    },
    // Anichin memakai parser AnimeStream yang sama dengan AnimeXin.
    { source: 'anichin', file: 'anichin-episode.html', base: 'https://anichin.moe/', parse: parseAnimexin },
]);

const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

/**
 * Urai satu halaman contoh dan ringkas buktinya.
 * @param {typeof CASES[number]} item
 */
export function evidenceRow({ source, file, base, parse, note = '' }) {
    const page = parse(load(read(file)), base);
    const servers = Array.isArray(page.servers) ? page.servers : [];
    const proven = servers.filter((server) => server.subtitleEvidence && server.lang === 'id');
    const unproven = servers.length - proven.length;
    const types = [...new Set(proven.map((server) => server.subtitleEvidence))];
    const downloads = Array.isArray(page.downloads) ? page.downloads : [];
    return {
        source,
        file,
        note,
        title: String(page.title || ''),
        servers: servers.length,
        proven: proven.length,
        unproven,
        evidence: types.join(', '),
        detail: String(page.subtitleEvidenceDetail || ''),
        provenNames: proven.map((server) => String(server.name || '')).filter(Boolean).slice(0, 3),
        downloadLabel: [...new Set(downloads.map((row) => row.subtitle).filter(Boolean))].join(', '),
    };
}

/** Ringkasan satu baris: berapa halaman terbukti, berapa tidak. */
export function summarize(rows) {
    const proven = rows.filter((row) => row.proven > 0).length;
    return {
        pages: rows.length,
        proven,
        unproven: rows.length - proven,
        servers: rows.reduce((sum, row) => sum + row.servers, 0),
        provenServers: rows.reduce((sum, row) => sum + row.proven, 0),
    };
}

export function evidenceReport(cases = CASES) {
    return cases.map(evidenceRow);
}

function main() {
    const only = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
    const cases = only ? CASES.filter((item) => item.source === only) : CASES;
    if (!cases.length) {
        console.log(`Sumber "${only}" tidak punya halaman contoh. Pilihan: ${[...new Set(CASES.map((c) => c.source))].join(', ')}`);
        process.exitCode = 1;
        return;
    }

    const rows = evidenceReport(cases);
    console.log('Kazanime — bukti Sub Indo per episode (halaman contoh offline)');
    console.log('Bukti dibaca dari halaman episode itu sendiri; nama/bahasa situs tidak dipakai.\n');

    for (const row of rows) {
        console.log(`== ${row.source} · ${row.file}${row.note ? ` — ${row.note}` : ''}`);
        console.log(`   judul     : ${row.title || '(tanpa judul)'}`);
        console.log(`   server    : ${row.servers} total · ${row.proven} berlabel Indonesia · ${row.unproven} tanpa bukti`);
        const quote = row.detail ? ` — "${row.detail}"` : row.provenNames.length ? ` — ${row.provenNames.join(', ')}` : '';
        console.log(`   bukti     : ${row.evidence ? `${row.evidence}${quote}` : '(tidak ada)'}`);
        if (row.downloadLabel) console.log(`   download  : ${row.downloadLabel}`);
        console.log('');
    }

    const sum = summarize(rows);
    console.log(`${sum.pages} halaman · ${sum.proven} terbukti Sub Indo · ${sum.unproven} tanpa bukti · `
        + `${sum.provenServers}/${sum.servers} server ber-label Indonesia`);
    console.log('Tanpa bukti, server tetap bisa diputar, tetapi judulnya tidak dihitung Sub Indo.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
