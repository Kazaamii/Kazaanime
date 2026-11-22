/**
 * Kazanime backend — providers/reanime.js
 * Penyedia server "ReAnime" (https://reanime.cz, dulu reanime.to) — pengganti server cadangan #2
 * (MegaPlay-MAL), ditambahkan 22 Okt 2026 atas permintaan pemilik proyek.
 *
 * Diverifikasi langsung 22 Okt 2026:
 *   robots.txt  : "User-agent: * / Disallow:" (semua diizinkan)
 *   GET /api/flix/<id AniList>/<episode> → {"success":true,"servers":[{serverName:"HD-1"|"HD-2",
 *        dataLink:"https://flixcloud.cc/e/<id>?v=1|2", dataType:"sub"|"dub", ...}]}  (JSON publik)
 *   GET /api/v1/search?q=<judul>&limit=n → hasil berisi anilist_id (kadang 0 → diambil dari URL cover "bx<id>-")
 *   Embed flixcloud.cc/e/… dipasang langsung sebagai iframe (header-nya tanpa X-Frame-Options /
 *   frame-ancestors). Tidak ada dekripsi apa pun — player embed bekerja sendiri di browser pengguna.
 * Subtitle ReAnime berbahasa Inggris. Hanya server "sub" yang dipakai (HD-2 lalu HD-1, urutan situsnya).
 * Challenge Cloudflare dihentikan tanpa retry; circuit memberi cooldown dan provider lain tetap dicoba.
 *
 * Putaran 27 (22 Nov 2026) — *"Stream selalu bufering"*:
 *   `reanime.to` berhenti menerima koneksi (TLS diputus untuk SEMUA jalur, termasuk `/`), sehingga
 *   tiap request jatuh sebagai `policy`/jaringan dan panel server kosong. Situsnya pindah ke
 *   `reanime.cz` dan `/api/flix/154587/1` di sana menjawab normal (diperiksa 22 Nov 2026).
 *   Basis utama sekarang `.cz`; `.to` hanya **cadangan** untuk kegagalan jaringan/timeout —
 *   tidak ada percobaan ulang untuk 403/429/challenge, dan tidak ada host di luar domain resmi.
 */
import { notFound } from '../lib/errors.js';
import { bestTitleMatch, uniqueTitles } from './match.js';

export const ID = 'reanime';
export const NAME = 'ReAnime';

const ORDER = { 'HD-2': 0, 'HD-1': 1 };
const NETWORK_KINDS = new Set(['network', 'timeout']);

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
 * Daftar basis yang dicoba berurutan. Basis cadangan hanya dipakai bila basis sebelumnya gagal
 * JARINGAN/TIMEOUT — 403/429/challenge/`policy` tidak pernah memicu percobaan ke basis lain.
 * @param {string} primary
 * @param {string} fallback
 * @returns {{base: string, host: string}[]}
 */
export function streamBases(primary, fallback = '') {
    const out = [];
    for (const value of [primary, fallback]) {
        const base = String(value || '').replace(/\/+$/, '');
        if (!base) continue;
        let host;
        try { host = new URL(base).hostname.replace(/^www\./, ''); } catch { continue; }
        if (!host || out.some((b) => b.host === host)) continue;
        out.push({ base, host });
    }
    return out;
}

/**
 * @param {{network: any, createClient: Function, baseUrl?: string, fallbackBaseUrl?: string,
 *   embedHosts?: string[]}} deps
 */
export function createReanime({
    network,
    createClient,
    baseUrl = 'https://reanime.cz',
    fallbackBaseUrl = 'https://reanime.to',
    embedHosts = ['flixcloud.cc'],
}) {
    const bases = streamBases(baseUrl, fallbackBaseUrl);
    const clients = new Map();
    for (const b of bases) {
        clients.set(b.host, createClient(network, {
            source: ID,
            allowedHosts: [b.host, `www.${b.host}`],
            blockedMs: 3 * 60 * 1000,
        }));
    }

    /**
     * Jalankan `fn(base, client)` pada basis pertama; pindah ke basis cadangan HANYA untuk
     * kegagalan jaringan/timeout (situs pindah domain), bukan pembatasan akses.
     */
    async function withBase(fn) {
        let lastErr = null;
        for (const b of bases) {
            try {
                return await fn(b, clients.get(b.host));
            } catch (err) {
                lastErr = err;
                if (!NETWORK_KINDS.has(err?.kind)) throw err;
            }
        }
        throw lastErr || notFound('ReAnime tidak dapat dihubungi.', ID);
    }

    async function findAnilistId(titles, year, ctx, base, client) {
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
        baseUrl: bases[0]?.base || baseUrl,

        /**
         * @param {{anilist?: number|null, ep: number, titles?: string[], year?: number|null}} q
         * @param {{deadline?: number, signal?: AbortSignal}} ctx
         * @returns {Promise<{servers: object[], anilist: number}>}
         */
        async servers({ anilist, ep, titles = [], year = null }, ctx = {}) {
            return withBase(async (b, client) => {
                const id = anilist || (titles.length ? await findAnilistId(titles, year, ctx, b.base, client) : null);
                if (!id) throw notFound('Anime ini tidak ditemukan di ReAnime.', ID);
                const json = await client.json(`${b.base}/api/flix/${id}/${ep}`, ctx);
                const servers = parseFlix(json, embedHosts);
                if (!servers.length) throw notFound(`Episode ${ep} belum tersedia di ReAnime.`, ID);
                return { servers, anilist: id };
            });
        },
    };
}
