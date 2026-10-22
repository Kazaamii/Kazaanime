/**
 * Kazanime backend — providers/index.js
 * Penyedia server stream berbasis id/judul (BUKAN adapter katalog seperti server/sources/*):
 *   reanime : embed flixcloud (Sub English) — server cadangan #2, menggantikan MegaPlay-MAL
 *   anizone : HLS + banyak subtitle ("Multi Sub") — diputar lewat proxy (routes/stream.js)
 * Dipanggil frontend lewat GET /api/stream/servers. Hasil di-cache (TTL episode) + stale-if-error.
 */
import { CACHE, STREAMS } from '../config.js';
import { TtlCache } from '../lib/cache.js';
import { describeError, isAbort } from '../lib/errors.js';
import { titleKey } from '../lib/text.js';
import { createAnizone } from './anizone.js';
import { uniqueTitles } from './match.js';
import { createReanime } from './reanime.js';

export const PROVIDER_FACTORIES = Object.freeze({
    reanime: (deps) => createReanime({ ...deps, baseUrl: STREAMS.reanime.baseUrl, embedHosts: STREAMS.reanime.embedHosts }),
    anizone: (deps) => createAnizone({ ...deps, baseUrl: STREAMS.anizone.baseUrl, mediaHosts: STREAMS.anizone.mediaHosts }),
});

/**
 * @param {{providers: any[], cache?: TtlCache, ttlMs?: number, staleMs?: number, notFoundTtlMs?: number, network?: any}} deps
 */
export function createStreamProviders({
    providers,
    cache = new TtlCache({ max: CACHE.maxEntries }),
    ttlMs = CACHE.episodeTtlMs,
    staleMs = CACHE.staleMs,
    notFoundTtlMs = CACHE.notFoundTtlMs,
    network = null,
} = {}) {
    const list = (providers || []).filter(Boolean);

    return {
        providers: list,

        /**
         * @param {{anilist?: number|null, ep: number, titles?: string[], year?: number|null}} q
         * @param {{deadline?: number, signal?: AbortSignal}} ctx
         * @returns {Promise<{servers: object[], status: Record<string, string>, errors: object[]}>}
         */
        async servers(q, ctx = {}) {
            const titles = uniqueTitles(q.titles || [], 4);
            const who = q.anilist ? `al${q.anilist}` : titles.map(titleKey).sort().join('|');
            const settled = await Promise.allSettled(list.map((p) => cache.wrap(
                `stream:${p.id}:${who}:${q.ep}`,
                { ttl: (v) => (v?.notFound ? notFoundTtlMs : ttlMs), stale: staleMs },
                async () => {
                    try {
                        return await p.servers({ anilist: q.anilist || null, ep: q.ep, titles, year: q.year || null }, ctx);
                    } catch (err) {
                        if (err?.kind === 'not_found') return { notFound: err.message, servers: [] };
                        throw err;
                    }
                },
            )));
            const servers = [];
            const status = {};
            const errors = [];
            settled.forEach((r, i) => {
                const p = list[i];
                if (r.status === 'rejected') {
                    if (isAbort(r.reason)) throw r.reason;
                    status[p.id] = r.reason?.kind === 'blocked' ? 'blocked' : 'error';
                    errors.push(describeError(r.reason));
                    return;
                }
                const v = r.value.value;
                if (v?.notFound) {
                    status[p.id] = 'not_found';
                    return;
                }
                status[p.id] = r.value.cache === 'stale' ? 'stale' : 'ok';
                for (const s of v?.servers || []) servers.push({ ...s, provider: p.id });
            });
            return { servers, status, errors };
        },

        health() {
            const circuits = network?.circuit.snapshot() || {};
            return list.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, circuit: circuits[p.id]?.state || 'closed', reason: circuits[p.id]?.reason || '' }));
        },
    };
}

/** Provider produksi sesuai STREAMS.enabled, berbagi network (throttle/robots/circuit) & cache. */
export function createDefaultStreamProviders({ network, createClient, cache }) {
    const providers = STREAMS.enabled
        .map((id) => {
            const f = PROVIDER_FACTORIES[id];
            if (!f) {
                console.warn(`[streams] penyedia "${id}" tidak dikenal — dilewati.`);
                return null;
            }
            return f({ network, createClient });
        })
        .filter(Boolean);
    return createStreamProviders({ providers, cache, network });
}
