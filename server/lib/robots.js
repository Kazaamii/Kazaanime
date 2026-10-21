/**
 * Kazanime backend — lib/robots.js
 * Kepatuhan robots.txt sesuai RFC 9309 (Robots Exclusion Protocol):
 *  - Grup "User-agent: KazanimeBot" dipakai bila ada; selain itu grup "*".
 *    Beberapa grup yang cocok digabung.
 *  - Aturan Allow/Disallow: kecocokan TERPANJANG menang; seri → Allow menang.
 *    Mendukung wildcard "*" dan penanda akhir "$".
 *  - /robots.txt selalu boleh diambil.
 *  - Status: 2xx → diurai · 4xx → "tidak tersedia" = boleh semua (RFC 9309 §2.3.1.3)
 *            5xx / jaringan / timeout → "tidak terjangkau" = TIDAK boleh semua (§2.3.1.4).
 *  - Tambahan kebijakan Kazanime: halaman blokir/challenge Cloudflare saat mengambil
 *    robots.txt = situs menolak bot → diperlakukan "blocked" (tidak diakses sama sekali).
 *  - Crawl-delay (non-standar tapi umum) dihormati sebagai jeda minimal antar-request.
 */

/**
 * @typedef {{allow: boolean, pattern: string}} Rule
 * @typedef {{agents: string[], rules: Rule[], crawlDelay: number|null}} Group
 * @typedef {{groups: Group[], sitemaps: string[]}} Robots
 */

/**
 * Urai isi robots.txt.
 * @param {string} text
 * @returns {Robots}
 */
export function parseRobots(text) {
    /** @type {Group[]} */
    const groups = [];
    const sitemaps = [];
    /** @type {Group|null} */
    let current = null;
    let lastWasAgent = false;

    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    for (const raw of lines) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();

        if (key === 'user-agent') {
            if (!current || !lastWasAgent) {
                current = { agents: [], rules: [], crawlDelay: null };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
            continue;
        }
        if (key === 'sitemap') {
            if (value) sitemaps.push(value);
            continue; // sitemap tidak memutus grup
        }
        lastWasAgent = false;
        if (!current) continue; // aturan sebelum user-agent mana pun diabaikan
        if (key === 'allow' || key === 'disallow') {
            current.rules.push({ allow: key === 'allow', pattern: value });
        } else if (key === 'crawl-delay') {
            const n = Number.parseFloat(value);
            if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
        }
    }
    return { groups, sitemaps };
}

/** "KazanimeBot/1.0" → "kazanimebot" (product token saja, huruf kecil). */
function productToken(agent) {
    return String(agent || '').trim().split('/')[0].trim().toLowerCase();
}

/**
 * Aturan yang berlaku untuk bot kita.
 * @param {Robots} robots
 * @param {string} token  mis. "KazanimeBot"
 * @returns {{rules: Rule[], crawlDelay: number|null, group: 'specific'|'*'|'none'}}
 */
export function rulesFor(robots, token) {
    const me = productToken(token);
    const specific = robots.groups.filter((g) => g.agents.some((a) => productToken(a) === me));
    const chosen = specific.length ? specific : robots.groups.filter((g) => g.agents.includes('*'));
    if (!chosen.length) return { rules: [], crawlDelay: null, group: 'none' };
    const delays = chosen.map((g) => g.crawlDelay).filter((d) => d != null);
    return {
        rules: chosen.flatMap((g) => g.rules),
        crawlDelay: delays.length ? Math.max(...delays) : null,
        group: specific.length ? 'specific' : '*',
    };
}

/** Normalisasi percent-encoding agar "/a%2fb" dan "/a%2Fb" sama, tanpa mengubah karakter biasa. */
function normalizeEncoding(s) {
    return s.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
}

/** Pola robots → RegExp (diawali "^"; "*" = apa saja; "$" di akhir = harus berakhir di situ). */
function patternToRegex(pattern) {
    const anchored = pattern.endsWith('$');
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const escaped = normalizeEncoding(body).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/**
 * Apakah path (+query) boleh diakses menurut daftar aturan.
 * @param {Rule[]} rules
 * @param {string} pathAndQuery  mis. "/anime/?s=naruto"
 */
export function isAllowed(rules, pathAndQuery) {
    const target = normalizeEncoding(pathAndQuery || '/');
    if (target === '/robots.txt') return true;
    let best = null; // {len, allow}
    for (const rule of rules) {
        if (!rule.pattern) continue; // "Disallow:" kosong = tidak melarang apa pun
        if (!patternToRegex(rule.pattern).test(target)) continue;
        const len = rule.pattern.length;
        if (!best || len > best.len || (len === best.len && rule.allow && !best.allow)) best = { len, allow: rule.allow };
    }
    return best ? best.allow : true;
}

/**
 * Penjaga robots.txt per origin, dengan cache.
 */
export class RobotsGate {
    /**
     * @param {{
     *   token: string,
     *   fetchRobots: (origin: string, signal?: AbortSignal) => Promise<{status: number, text: string, blocked?: boolean}>,
     *   ttlMs?: number, errorTtlMs?: number, now?: () => number,
     * }} opts
     */
    constructor({ token, fetchRobots, ttlMs = 6 * 3600e3, errorTtlMs = 10 * 60e3, now = Date.now }) {
        this.token = token;
        this.fetchRobots = fetchRobots;
        this.ttlMs = ttlMs;
        this.errorTtlMs = errorTtlMs;
        this.now = now;
        /** @type {Map<string, {state: string, rules: Rule[], crawlDelay: number|null, expires: number, fetchedAt: number, httpStatus: number, group: string}>} */
        this.entries = new Map();
        /** @type {Map<string, Promise<any>>} */
        this.inflight = new Map();
    }

    /**
     * Status robots.txt sebuah origin (diambil sekali lalu di-cache).
     * state: ok | unavailable (4xx → boleh semua) | unreachable (5xx/jaringan → tidak boleh) | blocked (WAF/challenge)
     */
    async load(origin, signal) {
        const cached = this.entries.get(origin);
        if (cached && cached.expires > this.now()) return cached;
        if (this.inflight.has(origin)) return this.inflight.get(origin);
        const p = (async () => {
            let entry;
            const fetchedAt = this.now();
            try {
                const res = await this.fetchRobots(origin, signal);
                if (res.blocked) {
                    entry = { state: 'blocked', rules: [], crawlDelay: null, httpStatus: res.status, group: 'none' };
                } else if (res.status >= 200 && res.status < 300) {
                    const r = rulesFor(parseRobots(res.text), this.token);
                    entry = { state: 'ok', rules: r.rules, crawlDelay: r.crawlDelay, httpStatus: res.status, group: r.group };
                } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                    entry = { state: 'unavailable', rules: [], crawlDelay: null, httpStatus: res.status, group: 'none' };
                } else {
                    entry = { state: 'unreachable', rules: [], crawlDelay: null, httpStatus: res.status, group: 'none' };
                }
            } catch (err) {
                if (err?.kind === 'abort') throw err;
                entry = { state: 'unreachable', rules: [], crawlDelay: null, httpStatus: 0, group: 'none', error: String(err?.message || err) };
            }
            const ttl = entry.state === 'ok' || entry.state === 'unavailable' ? this.ttlMs : this.errorTtlMs;
            const full = { ...entry, fetchedAt, expires: fetchedAt + ttl };
            this.entries.set(origin, full);
            return full;
        })();
        this.inflight.set(origin, p);
        const clear = () => this.inflight.delete(origin);
        p.then(clear, clear);
        return p;
    }

    /**
     * @param {string} url
     * @param {{signal?: AbortSignal, requireExplicit?: boolean}} [opts]
     *   requireExplicit: untuk sumber yang ToS-nya belum bisa ditinjau → robots.txt HARUS terbaca & mengizinkan.
     * @returns {Promise<{allowed: boolean, reason: string, crawlDelayMs: number}>}
     */
    async check(url, { signal, requireExplicit = false } = {}) {
        const u = new URL(url);
        const entry = await this.load(u.origin, signal);
        const crawlDelayMs = entry.crawlDelay != null ? Math.round(entry.crawlDelay * 1000) : 0;
        switch (entry.state) {
            case 'blocked': return { allowed: false, reason: 'blocked', crawlDelayMs };
            case 'unreachable': return { allowed: false, reason: 'unreachable', crawlDelayMs };
            case 'unavailable': return requireExplicit
                ? { allowed: false, reason: 'unverified', crawlDelayMs }
                : { allowed: true, reason: 'no-robots', crawlDelayMs };
            default: {
                const ok = isAllowed(entry.rules, u.pathname + u.search);
                return { allowed: ok, reason: ok ? 'allowed' : 'disallowed', crawlDelayMs };
            }
        }
    }

    snapshot() {
        const out = {};
        for (const [origin, e] of this.entries) {
            out[origin] = { state: e.state, httpStatus: e.httpStatus, group: e.group, crawlDelay: e.crawlDelay, rules: e.rules.length, fetchedAt: new Date(e.fetchedAt).toISOString() };
        }
        return out;
    }
}
