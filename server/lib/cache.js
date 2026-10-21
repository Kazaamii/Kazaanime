/**
 * Kazanime backend — lib/cache.js
 * Cache memori dengan TTL + batas jumlah entri (LRU) + dedupe request yang sedang
 * berjalan + "stale-if-error" (data lama dipakai bila sumber sedang gagal).
 *
 * Catatan serverless (Vercel): memori hanya bertahan selama instance hidup.
 * Lapisan cache utama di produksi adalah CDN Vercel (header s-maxage di routes),
 * cache ini mencegah request ganda di dalam satu instance.
 */
export class TtlCache {
    /**
     * @param {{max?: number, now?: () => number}} [opts]
     */
    constructor({ max = 500, now = Date.now } = {}) {
        this.max = max;
        this.now = now;
        /** @type {Map<string, {value: unknown, expires: number, staleUntil: number, storedAt: number}>} */
        this.map = new Map();
        /** @type {Map<string, Promise<unknown>>} */
        this.inflight = new Map();
        this.stats = { hits: 0, misses: 0, stale: 0, evictions: 0 };
    }

    get size() {
        return this.map.size;
    }

    /** Nilai yang masih segar, atau undefined. */
    get(key) {
        const e = this.map.get(key);
        if (!e || e.expires <= this.now()) return undefined;
        // LRU: entri yang dipakai dipindah ke belakang
        this.map.delete(key);
        this.map.set(key, e);
        return e.value;
    }

    /** Entri apa adanya (termasuk yang kedaluwarsa) — untuk diagnosa & stale-if-error. */
    peek(key) {
        return this.map.get(key);
    }

    /**
     * @param {string} key
     * @param {unknown} value
     * @param {number} ttlMs
     * @param {number} [staleMs] berapa lama setelah kedaluwarsa nilai masih boleh dipakai saat sumber gagal
     */
    set(key, value, ttlMs, staleMs = 0) {
        const now = this.now();
        this.map.delete(key);
        this.map.set(key, { value, expires: now + ttlMs, staleUntil: now + ttlMs + staleMs, storedAt: now });
        this.#evict(now);
    }

    delete(key) {
        this.map.delete(key);
    }

    clear() {
        this.map.clear();
        this.inflight.clear();
    }

    #evict(now) {
        if (this.map.size <= this.max) return;
        // Buang yang sudah tidak bisa dipakai sama sekali dulu, lalu yang paling lama tidak dipakai.
        for (const [k, e] of this.map) {
            if (this.map.size <= this.max) return;
            if (e.staleUntil <= now) { this.map.delete(k); this.stats.evictions++; }
        }
        for (const k of this.map.keys()) {
            if (this.map.size <= this.max) return;
            this.map.delete(k);
            this.stats.evictions++;
        }
    }

    /**
     * Ambil dari cache, atau jalankan `producer` (request identik yang bersamaan hanya jalan sekali).
     * Bila producer gagal dan masih ada nilai lama dalam jendela stale, nilai lama dikembalikan.
     *
     * @template T
     * @param {string} key
     * @param {{ttl: number | ((value: T) => number), stale?: number, force?: boolean}} opts
     * @param {() => Promise<T>} producer
     * @returns {Promise<{value: T, cache: 'hit'|'miss'|'stale', age: number, error?: unknown}>}
     */
    async wrap(key, { ttl, stale = 0, force = false }, producer) {
        if (!force) {
            const fresh = this.get(key);
            if (fresh !== undefined) {
                this.stats.hits++;
                return { value: /** @type {T} */ (fresh), cache: 'hit', age: this.now() - (this.map.get(key)?.storedAt || this.now()) };
            }
        }
        this.stats.misses++;
        let p = this.inflight.get(key);
        if (!p) {
            p = (async () => {
                const value = await producer();
                const ms = typeof ttl === 'function' ? ttl(value) : ttl;
                if (ms > 0) this.set(key, value, ms, stale);
                return value;
            })();
            this.inflight.set(key, p);
            const clear = () => { if (this.inflight.get(key) === p) this.inflight.delete(key); };
            p.then(clear, clear);
        }
        try {
            return { value: /** @type {T} */ (await p), cache: 'miss', age: 0 };
        } catch (error) {
            const e = this.map.get(key);
            if (e && e.staleUntil > this.now()) {
                this.stats.stale++;
                return { value: /** @type {T} */ (e.value), cache: 'stale', age: this.now() - e.storedAt, error };
            }
            throw error;
        }
    }
}
