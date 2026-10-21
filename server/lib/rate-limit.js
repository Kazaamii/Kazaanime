/**
 * Kazanime backend — lib/rate-limit.js
 *  - HostThrottle   : jeda minimal antar-request KELUAR per host (sopan ke situs sumber).
 *  - CircuitBreaker : sumber yang gagal beruntun / memblokir "diistirahatkan" sementara.
 *  - ipRateLimit    : batas request MASUK per IP (melindungi sumber dari spam lewat API kita).
 */
import { SourceError } from './errors.js';

/**
 * Tunggu ms milidetik; batal bila signal di-abort.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new SourceError('Permintaan dibatalkan.', { kind: 'abort' }));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, Math.max(0, ms));
        function onAbort() {
            clearTimeout(timer);
            reject(new SourceError('Permintaan dibatalkan.', { kind: 'abort' }));
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export class HostThrottle {
    /**
     * @param {{intervalMs?: number, maxWaitMs?: number, now?: () => number, wait?: typeof sleep}} [opts]
     */
    constructor({ intervalMs = 1000, maxWaitMs = 6000, now = Date.now, wait = sleep } = {}) {
        this.intervalMs = intervalMs;
        this.maxWaitMs = maxWaitMs;
        this.now = now;
        this.wait = wait;
        /** @type {Map<string, number>} host → waktu giliran berikutnya */
        this.next = new Map();
        /** @type {Map<string, number>} host → jeda khusus (mis. Crawl-delay) */
        this.custom = new Map();
    }

    /** Jeda khusus untuk satu host (mis. dari Crawl-delay robots.txt). */
    setHostInterval(host, ms) {
        if (ms > 0) this.custom.set(host, ms);
        else this.custom.delete(host);
    }

    intervalFor(host, intervalMs) {
        return Math.max(intervalMs ?? this.intervalMs, this.custom.get(host) || 0);
    }

    /**
     * Ambil giliran untuk host. Bila antrean terlalu panjang → SourceError rate_limited.
     * @param {string} host
     * @param {{intervalMs?: number, signal?: AbortSignal, source?: string}} [opts]
     */
    async acquire(host, { intervalMs, signal, source = '' } = {}) {
        const now = this.now();
        const at = Math.max(now, this.next.get(host) || 0);
        const waitMs = at - now;
        if (waitMs > this.maxWaitMs) {
            throw new SourceError('Antrean ke situs sumber sedang penuh. Coba lagi sebentar lagi.', {
                kind: 'rate_limited', source, retryAfter: Math.ceil(waitMs / 1000),
            });
        }
        this.next.set(host, at + this.intervalFor(host, intervalMs));
        if (waitMs > 0) await this.wait(waitMs, signal);
    }
}

export class CircuitBreaker {
    /**
     * @param {{failures?: number, openMs?: number, now?: () => number}} [opts]
     */
    constructor({ failures = 2, openMs = 60000, now = Date.now } = {}) {
        this.failures = failures;
        this.openMs = openMs;
        this.now = now;
        /** @type {Map<string, {count: number, openUntil: number, reason: string, at: number}>} */
        this.state = new Map();
    }

    /** @returns {{open: boolean, retryAfter: number, reason: string}} */
    check(key) {
        const s = this.state.get(key);
        const left = s ? s.openUntil - this.now() : 0;
        return left > 0 ? { open: true, retryAfter: Math.ceil(left / 1000), reason: s.reason } : { open: false, retryAfter: 0, reason: '' };
    }

    success(key) {
        const s = this.state.get(key);
        if (s && (s.count || s.openUntil)) this.state.set(key, { count: 0, openUntil: 0, reason: '', at: this.now() });
    }

    /**
     * @param {string} key
     * @param {{reason?: string, openMs?: number, immediate?: boolean}} [opts] immediate = langsung buka (mis. diblokir WAF)
     */
    failure(key, { reason = '', openMs, immediate = false } = {}) {
        const now = this.now();
        const prev = this.state.get(key) || { count: 0, openUntil: 0, reason: '', at: now };
        const count = prev.count + 1;
        const open = immediate || count >= this.failures;
        this.state.set(key, {
            count,
            openUntil: open ? now + (openMs ?? this.openMs) : prev.openUntil,
            reason: reason || prev.reason,
            at: now,
        });
    }

    snapshot() {
        const out = {};
        for (const [k, s] of this.state) {
            const left = s.openUntil - this.now();
            out[k] = { state: left > 0 ? 'open' : 'closed', failures: s.count, retryAfter: left > 0 ? Math.ceil(left / 1000) : 0, reason: s.reason };
        }
        return out;
    }
}

/** IP klien (Vercel mengisi x-real-ip / x-forwarded-for dengan IP asli pengunjung). */
export function clientIp(req) {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real) return real.trim();
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Middleware Express: fixed window per IP. Memori per instance (best effort di serverless —
 * pertahanan utamanya tetap cache CDN + throttle keluar per host).
 * @param {{limit: number, windowMs?: number, now?: () => number}} opts
 */
export function ipRateLimit({ limit, windowMs = 60000, now = Date.now }) {
    /** @type {Map<string, {count: number, resetAt: number}>} */
    const hits = new Map();
    let calls = 0;
    return function rateLimitMiddleware(req, res, next) {
        if (!limit) return next();
        const t = now();
        if (++calls % 500 === 0 || hits.size > 10000) {
            for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
        }
        const ip = clientIp(req);
        let entry = hits.get(ip);
        if (!entry || entry.resetAt <= t) {
            entry = { count: 0, resetAt: t + windowMs };
            hits.set(ip, entry);
        }
        entry.count++;
        const resetSec = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
        res.set('RateLimit-Limit', String(limit));
        res.set('RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
        res.set('RateLimit-Reset', String(resetSec));
        if (entry.count > limit) {
            res.set('Retry-After', String(resetSec));
            res.set('Cache-Control', 'no-store');
            res.status(429).json({ ok: false, error: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.', code: 'RATE_LIMITED' });
            return;
        }
        next();
    };
}
