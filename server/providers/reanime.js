/**
 * Kazanime backend — providers/reanime.js
 * Penyedia server "ReAnime" (https://reanime.to) — pengganti server cadangan #2 (MegaPlay-MAL),
 * ditambahkan 22 Okt 2026 atas permintaan pemilik proyek.
 *
 * Diverifikasi langsung 22 Okt 2026:
 *   robots.txt  : "User-agent: * / Disallow:" (semua diizinkan)
 *   GET /api/flix/<id AniList>/<episode> → {"success":true,"servers":[{serverName:"HD-1"|"HD-2",
 *        dataLink:"https://flixcloud.cc/e/<id>?v=1|2", dataType:"sub"|"dub", ...}]}  (JSON publik)
 *   GET /api/v1/search?q=<judul>&limit=n → hasil berisi anilist_id (kadang 0 → diambil dari URL cover "bx<id>-")
 *   Embed flixcloud.cc/e/… dipasang langsung sebagai iframe (header-nya tanpa X-Frame-Options /
 *   frame-ancestors). Tidak ada dekripsi apa pun — player embed bekerja sendiri di browser pengguna.
 * Subtitle ReAnime berbahasa Inggris. Hanya server "sub" yang dipakai (HD-2 lalu HD-1, urutan situsnya).
 * Cloudflare men-challenge sebagian request secara acak (bukan blokir permanen) → challengeRetries.
 */
import { notFound } from '../lib/errors.js';
import { bestTitleMatch, uniqueTitles } from './match.js';

export const ID = 'reanime';
export const NAME = 'ReAnime';

const ORDER = { 'HD-2': 0, 'HD-1': 1 };

/** anilist_id hasil pencarian ReAnime (0 → dari URL cover AniList "…/bx159042-…"). */
export function anilistIdOf(item) {
    const id = Number(item?.anilist_id);
    if (Number.isInteger(id) && id > 0) return id;
    for (const k of ['extra_large', 'large', 'medium']) {
        const m = /\/b?x?(\d+)-[A-Za-z0-9]+\.(?:jpe?g|png|webp)/.exec(String(item?.cover_image?.[k] || ''));
        if (m) return Number(m[1]);
    }
    return null;
}

/**
 * Respons /api/flix → server embed (sub saja), host embed wajib di allowlist.
 * @param {any} json
 * @param {string[]} embedHosts
 */
export function parseFlix(json, embedHosts) {
    if (!json || json.success !== true || !Array.isArray(json.servers)) return [];
    const seen = new Set();
    return json.servers
        .filter((s) => /^s?-?sub$/i.test(String(s?.dataType || '')))
        .map((s) => {
            let url;
            try { url = new URL(String(s.dataLink || '')); } catch { return null; }
            const host = url.hostname.replace(/^www\./, '');
            if (url.protocol !== 'https:' || !embedHosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
            if (seen.has(url.href)) return null;
            seen.add(url.href);
            const label = String(s.serverName || '').trim().slice(0, 12) || 'HD';
            return { name: `ReAnime ${label}`, label, url: url.href, lang: 'en', kind: 'embed' };
        })
        .filter(Boolean)
        .sort((a, b) => (ORDER[a.label] ?? 9) - (ORDER[b.label] ?? 9));
}

/**
 * @param {{network: any, createClient: Function, baseUrl?: string, embedHosts?: string[]}} deps
 */
export function createReanime({ network, createClient, baseUrl = 'https://reanime.to', embedHosts = ['flixcloud.cc'] }) {
    const base = String(baseUrl).replace(/\/+$/, '');
    const host = new URL(base).hostname.replace(/^www\./, '');
    const client = createClient(network, {
        source: ID,
        allowedHosts: [host, `www.${host}`],
        challengeRetries: 2,
        blockedMs: 3 * 60 * 1000,
    });

    async function findAnilistId(titles, year, ctx) {
        for (const q of uniqueTitles(titles, 2)) {
            const url = new URL(`${base}/api/v1/search`);
            url.searchParams.set('q', q);
            url.searchParams.set('limit', '8');
            const json = await client.json(url.href, ctx);
            const results = Array.isArray(json?.results) ? json.results : [];
            const hit = bestTitleMatch(
                results,
                (r) => [r?.title?.english, r?.title?.romaji, r?.title?.native],
                titles,
                { year, yearOf: (r) => r?.season_year || null },
            );
            const id = hit ? anilistIdOf(hit) : null;
            if (id) return id;
        }
        return null;
    }

    return {
        id: ID,
        name: NAME,
        baseUrl: base,

        /**
         * @param {{anilist?: number|null, ep: number, titles?: string[], year?: number|null}} q
         * @param {{deadline?: number, signal?: AbortSignal}} ctx
         * @returns {Promise<{servers: object[], anilist: number}>}
         */
        async servers({ anilist, ep, titles = [], year = null }, ctx = {}) {
            const id = anilist || (titles.length ? await findAnilistId(titles, year, ctx) : null);
            if (!id) throw notFound('Anime ini tidak ditemukan di ReAnime.', ID);
            const json = await client.json(`${base}/api/flix/${id}/${ep}`, ctx);
            const servers = parseFlix(json, embedHosts);
            if (!servers.length) throw notFound(`Episode ${ep} belum tersedia di ReAnime.`, ID);
            return { servers, anilist: id };
        },
    };
}
