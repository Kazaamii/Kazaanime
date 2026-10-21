#!/usr/bin/env node
/**
 * Kazanime — server/scripts/check-sources.js
 * Laporan kepatuhan & kesehatan setiap sumber scraper:
 *   - ringkasan hasil peninjauan ToS (POLICY.tos di adapter)
 *   - robots.txt LIVE (RFC 9309): status, grup yang berlaku, Crawl-delay, boleh/tidak
 *   - --live : uji ambil data (latest → detail → episode terbaru → jadwal), ±6 request per sumber,
 *              memakai throttle & User-Agent yang sama dengan produksi.
 *
 *   npm run check:sources
 *   npm run check:sources -- --live
 */
import { BOT, SOURCES } from '../config.js';
import { createClient, createNetwork } from '../lib/fetcher.js';
import { decodeSlug } from '../lib/slug.js';
import { FACTORIES } from '../sources/index.js';

const live = process.argv.includes('--live');
const network = createNetwork();
const line = (label, text) => console.log(`  ${label.padEnd(9)}: ${text}`);

console.log(`Kazanime — cek sumber (${new Date().toISOString()})`);
console.log(`User-Agent: ${BOT.userAgent}`);

for (const id of SOURCES.enabled) {
    const factory = FACTORIES[id];
    if (!factory) {
        console.log(`\n✗ ${id}: adapter tidak dikenal`);
        continue;
    }
    const adapter = factory({ network, createClient, baseUrl: SOURCES[id].baseUrl });
    const { tos } = adapter.policy;
    console.log(`\n== ${adapter.name} — ${adapter.baseUrl}`);
    line('ToS', `${tos.verdict.toUpperCase()} (ditinjau ${tos.reviewedAt})${tos.url ? ` · ${tos.url}` : ''}`);
    line('', tos.note);

    if (tos.verdict === 'forbidden') {
        line('status', 'DIMATIKAN — ToS melarang akses otomatis');
        continue;
    }

    const verdict = await network.robots.check(`${adapter.baseUrl}/`, { requireExplicit: tos.verdict !== 'allowed' });
    const snap = network.robots.snapshot()[new URL(adapter.baseUrl).origin] || {};
    line('robots', `${snap.state} (HTTP ${snap.httpStatus || '-'}) · grup "${snap.group}" · ${snap.rules ?? 0} aturan · Crawl-delay ${snap.crawlDelay ?? '-'}`);
    line('akses', verdict.allowed ? `BOLEH (${verdict.reason})` : `TIDAK (${verdict.reason}) — adapter otomatis dilewati, fallback dipakai`);

    if (!live || !verdict.allowed) continue;
    const t0 = Date.now();
    try {
        const items = await adapter.latest({});
        line('latest', `${items.length} item (${Date.now() - t0} ms) · contoh: ${items[0]?.title || '-'} → ${items[0]?.slug || '-'}`);
        const first = items.find((x) => x.slug);
        if (!first) continue;
        const ref = adapter.parseRef(decodeSlug(first.slug).parts);
        const anime = await adapter.getAnime(ref, {});
        line('detail', `${anime.title} · ${anime.episodeList.length} episode · terbaru ${anime.latestEpisode ?? '-'} · ${anime.status}`);
        const last = anime.episodeList[anime.episodeList.length - 1];
        if (last) {
            const ep = await adapter.getEpisode(ref, last.number, { anime });
            line('episode', `#${ep.episode} · ${ep.servers.length} server (${ep.servers.slice(0, 3).map((s) => s.name).join(', ')}${ep.servers.length > 3 ? ', …' : ''}) · ${ep.downloads.length} grup download`);
        }
        if (typeof adapter.schedule === 'function') {
            const days = await adapter.schedule({});
            const all = Object.values(days).flat();
            line('jadwal', `${all.length} anime di ${Object.values(days).filter((d) => d.length).length} hari · ${all.filter((x) => x.time).length} dengan jam rilis`);
        }
    } catch (err) {
        line('live', `GAGAL — ${err.kind || err.code || ''}: ${err.message}`);
    }
}
console.log('');
