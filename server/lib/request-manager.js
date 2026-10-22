/**
 * Kazanime backend — lib/request-manager.js
 * Shared per-host queue for polite request pacing and bounded concurrency. It also
 * delegates response/data caching to the existing TtlCache and supplies the same
 * bounded exponential backoff used by the fetcher.
 */
import { SourceError } from './errors.js';
import { HostThrottle, sleep } from './rate-limit.js';

/** Release function for one semaphore slot. */
function makeRelease(state, now) {
    let released = false;
    return () => {
        if (released) return;
        released = true;
        for (;;) {
            const next = state.queue.shift();
            if (!next) {
                state.active = Math.max(0, state.active - 1);
                state.lastUsed = now();
                return;
            }
            if (next.cancelled) continue;
            clearTimeout(next.timer);
            next.signal?.removeEventListener('abort', next.onAbort);
            next.resolve(makeRelease(state, now));
            return; // transfer the occupied slot directly to the next waiter
        }
    };
}

export class RequestManager {
    /**
     * @param {{
     *   throttle?: HostThrottle,
     *   cache?: import('./cache.js').TtlCache|null,
     *   maxConcurrencyPerHost?: number,
     *   maxQueueWaitMs?: number,
     *   now?: () => number,
     *   wait?: typeof sleep,
     * }} [opts]
     */
    constructor({ throttle = new HostThrottle(), cache = null, maxConcurrencyPerHost = 2, maxQueueWaitMs = 6000, now = Date.now, wait = sleep } = {}) {
        this.throttle = throttle;
        this.cache = cache;
        this.maxConcurrencyPerHost = Math.max(1, Math.min(100, Math.trunc(maxConcurrencyPerHost) || 1));
        this.maxQueueWaitMs = Math.max(0, Math.trunc(maxQueueWaitMs) || 0);
        this.now = now;
        this.wait = wait;
        /** @type {Map<string, {active:number, queue:any[], lastUsed:number}>} */
        this.hosts = new Map();
    }

    #state(host) {
        let state = this.hosts.get(host);
        if (!state) {
            state = { active: 0, queue: [], lastUsed: this.now() };
            this.hosts.set(host, state);
        }
        return state;
    }

    async #acquireConcurrency(host, { signal, source = '' } = {}) {
        if (signal?.aborted) throw new SourceError('Permintaan dibatalkan.', { kind: 'abort', source });
        const state = this.#state(host);
        if (state.active < this.maxConcurrencyPerHost) {
            state.active++;
            state.lastUsed = this.now();
            return makeRelease(state, this.now);
        }

        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, signal, cancelled: false, timer: null, onAbort: null };
            const remove = () => {
                entry.cancelled = true;
                const index = state.queue.indexOf(entry);
                if (index >= 0) state.queue.splice(index, 1);
                signal?.removeEventListener('abort', entry.onAbort);
                clearTimeout(entry.timer);
            };
            entry.onAbort = () => {
                remove();
                reject(new SourceError('Permintaan dibatalkan.', { kind: 'abort', source }));
            };
            if (signal) signal.addEventListener('abort', entry.onAbort, { once: true });
            if (this.maxQueueWaitMs > 0) {
                entry.timer = setTimeout(() => {
                    remove();
                    reject(new SourceError(`Antrean request ke ${source || host} penuh.`, {
                        kind: 'rate_limited', source, retryAfter: Math.max(1, Math.ceil(this.maxQueueWaitMs / 1000)),
                    }));
                }, this.maxQueueWaitMs);
                entry.timer.unref?.();
            } else {
                remove();
                reject(new SourceError(`Antrean request ke ${source || host} penuh.`, { kind: 'rate_limited', source, retryAfter: 1 }));
                return;
            }
            state.queue.push(entry);
        });
    }

    /**
     * Menunggu giliran rate-limit lebih dulu, lalu mengambil slot concurrency.
     * Pemanggil HARUS memanggil fungsi release di finally.
     */
    async acquire(host, { intervalMs, signal, source = '' } = {}) {
        await this.throttle.acquire(host, { intervalMs, signal, source });
        return this.#acquireConcurrency(host, { signal, source });
    }

    /** Jalankan pekerjaan dengan slot per-host dan lepaskan slot meski terjadi error. */
    async run(host, options, task) {
        const release = await this.acquire(host, options);
        try {
            return await task();
        } finally {
            release();
        }
    }

    /** Backoff terbatas dengan jitter; percobaan/access challenge tidak ditangani di sini. */
    async backoff(attempt, { signal, baseDelayMs = 400, maxDelayMs = 2500, jitterMs = 200 } = {}) {
        const index = Math.max(0, Math.trunc(attempt) - 1);
        const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(index, 8)));
        await this.wait(exponential + Math.random() * Math.min(jitterMs, exponential), signal);
    }

    /** Gunakan cache TTL/LRU/dedupe/stale yang sudah ada agar semantik lama tetap sama. */
    cached(key, options, producer) {
        if (!this.cache) return Promise.resolve().then(async () => ({ value: await producer(), cache: 'miss', age: 0 }));
        return this.cache.wrap(key, options, producer);
    }

    snapshot() {
        const out = {};
        for (const [host, state] of this.hosts) {
            out[host] = { active: state.active, queued: state.queue.filter((item) => !item.cancelled).length };
        }
        return { maxConcurrencyPerHost: this.maxConcurrencyPerHost, hosts: out };
    }
}
