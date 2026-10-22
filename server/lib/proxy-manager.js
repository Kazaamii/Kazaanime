/**
 * Kazanime backend — lib/proxy-manager.js
 * HTTP(S) and SOCKS egress selection for operator-authorized proxies only.
 * A 403/429/CAPTCHA never marks a proxy bad or triggers rotation/retry; upstream
 * access restrictions are handled by ChallengeHandler and the source circuit.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { Agent, ProxyAgent } from 'undici';
import { socksConnector, socksDispatcher } from 'fetch-socks';

const SCHEME_MAP = Object.freeze({
    'http:': 'http:',
    'https:': 'https:',
    'socks:': 'socks5:',
    'socks4a:': 'socks4a:',
    'socks5:': 'socks5:',
    'socks5h:': 'socks5h:',
});

export class ProxyUnavailableError extends Error {
    constructor(retryAfter = 0) {
        super('Tidak ada proxy scraper yang sehat; request tidak dialihkan langsung.');
        this.name = 'ProxyUnavailableError';
        this.code = 'PROXY_UNAVAILABLE';
        this.retryAfter = retryAfter;
    }
}

/**
 * Urai konfigurasi URL tanpa menaruh URL/userinfo di error atau diagnostic.
 * @param {string} raw
 * @param {number} index
 */
function parseEndpoint(raw, index) {
    let input;
    let parsed;
    try {
        input = String(raw || '').trim();
        parsed = new URL(input);
    } catch {
        throw new TypeError(`Format proxy ke-${index + 1} tidak valid.`);
    }
    const protocol = SCHEME_MAP[parsed.protocol.toLowerCase()];
    if (!protocol || !parsed.hostname || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
        throw new TypeError(`Skema atau format proxy ke-${index + 1} tidak didukung.`);
    }
    let username = '';
    let password = '';
    try {
        username = decodeURIComponent(parsed.username);
        password = decodeURIComponent(parsed.password);
    } catch {
        throw new TypeError(`Kredensial proxy ke-${index + 1} tidak valid.`);
    }
    if (Boolean(username) !== Boolean(password)) {
        throw new TypeError(`Proxy ke-${index + 1} harus memiliki username dan password sekaligus.`);
    }
    const isSocks4 = protocol === 'socks4:' || protocol === 'socks4a:';
    if (isSocks4 && password) throw new TypeError(`SOCKS4 proxy ke-${index + 1} tidak mendukung password.`);
    if (parsed.port === '0') throw new TypeError(`Port proxy ke-${index + 1} tidak valid.`);
    const port = parsed.port ? Number(parsed.port) : (protocol === 'https:' ? 443 : protocol.startsWith('socks') ? 1080 : 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError(`Port proxy ke-${index + 1} tidak valid.`);
    const hostname = parsed.hostname;
    const server = `${protocol}//${hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname}:${port}`;
    const original = new URL(server);
    if (username) {
        original.username = encodeURIComponent(username);
        original.password = encodeURIComponent(password);
    }
    const socksType = protocol.startsWith('socks4') ? 4 : protocol.startsWith('socks5') ? 5 : 0;
    return {
        id: `proxy-${index + 1}`,
        protocol,
        hostname,
        port,
        server,
        username,
        password,
        socksType,
        socksRemoteDns: protocol === 'socks4a:' || protocol === 'socks5h:',
        href: original.href,
        health: 'unknown',
        failures: 0,
        cooldownUntil: 0,
        checkedAt: 0,
        lastError: '',
        dispatcher: null,
    };
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw new DOMException('Aborted', 'AbortError');
}

function tcpProbe(proxy, { timeoutMs = 2000, signal } = {}) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve(false);
        let settled = false;
        const host = proxy.hostname.replace(/^\[|\]$/g, '');
        const socket = proxy.protocol === 'https:'
            ? tls.connect({ host, port: proxy.port, servername: host, rejectUnauthorized: true })
            : net.connect({ host, port: proxy.port });
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            socket.destroy();
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        const onAbort = () => finish(false);
        signal?.addEventListener('abort', onAbort, { once: true });
        socket.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

export class ProxyManager {
    /**
     * @param {{
     *   urls?: string[], rotation?: 'round-robin'|'sticky'|'disabled', healthCheck?: boolean,
     *   connectTimeoutMs?: number, healthTtlMs?: number, failureCooldownMs?: number,
     *   now?: () => number, probe?: typeof tcpProbe, lookup?: typeof dns.lookup,
     *   makeDispatcher?: (proxy: any, connectTimeoutMs: number) => any,
     * }} [opts]
     */
    constructor({
        urls = [],
        rotation = 'round-robin',
        healthCheck = true,
        connectTimeoutMs = 2000,
        healthTtlMs = 30000,
        failureCooldownMs = 30000,
        now = Date.now,
        probe = tcpProbe,
        lookup = dns.lookup,
        makeDispatcher = null,
    } = {}) {
        this.rotation = ['round-robin', 'sticky', 'disabled'].includes(rotation) ? rotation : 'round-robin';
        this.healthCheckEnabled = Boolean(healthCheck);
        this.connectTimeoutMs = Math.max(250, Math.min(30000, Math.trunc(connectTimeoutMs) || 2000));
        this.healthTtlMs = Math.max(1000, Math.trunc(healthTtlMs) || 30000);
        this.failureCooldownMs = Math.max(1000, Math.trunc(failureCooldownMs) || 30000);
        this.now = now;
        this.probe = probe;
        this.lookup = lookup;
        this.makeDispatcher = makeDispatcher || ((proxy, timeout) => {
            if (proxy.socksType) {
                const socks = {
                    type: proxy.socksType,
                    host: proxy.hostname.replace(/^\[|\]$/g, ''),
                    port: proxy.port,
                    ...(proxy.username ? { userId: proxy.username } : {}),
                    ...(proxy.password ? { password: proxy.password } : {}),
                };
                const dispatcherOptions = {
                    connectTimeout: timeout,
                    headersTimeout: timeout,
                    bodyTimeout: timeout,
                };
                if (proxy.protocol === 'socks5:') {
                    // SOCKS5 resolves target DNS locally; socks5h keeps the hostname for proxy-side DNS.
                    const connector = socksConnector(socks, { timeout });
                    return new Agent({
                        ...dispatcherOptions,
                        connect: (options, callback) => {
                            if (net.isIP(options.hostname)) return connector(options, callback);
                            this.lookup(options.hostname, { verbatim: true }).then(({ address }) => connector({
                                ...options,
                                hostname: address,
                                servername: options.servername || options.hostname,
                            }, callback), (error) => callback(error, null));
                        },
                    });
                }
                return socksDispatcher(socks, { ...dispatcherOptions, connect: { timeout } });
            }
            return new ProxyAgent({
                uri: proxy.href,
                proxyTunnel: false,
                connectTimeout: timeout,
                headersTimeout: timeout,
                bodyTimeout: timeout,
                proxyTls: { timeout, rejectUnauthorized: true },
            });
        });
        this.proxies = urls.map((url, i) => parseEndpoint(url, i));
        this.cursor = 0;
        this.sticky = new Map();
        this.checking = new Map();
    }

    get enabled() {
        return this.proxies.length > 0 && this.rotation !== 'disabled';
    }

    async #check(proxy, { force = false, signal } = {}) {
        const now = this.now();
        if (proxy.cooldownUntil > now && !force) return false;
        if (!force && proxy.health !== 'unknown' && now - proxy.checkedAt < this.healthTtlMs) return proxy.health === 'healthy';
        if (this.checking.has(proxy.id)) return this.checking.get(proxy.id);
        const check = (async () => {
            let ok = false;
            try { ok = Boolean(await this.probe(proxy, { timeoutMs: this.connectTimeoutMs, signal })); } catch { ok = false; }
            proxy.checkedAt = this.now();
            proxy.health = ok ? 'healthy' : 'unhealthy';
            proxy.lastError = ok ? '' : 'unreachable';
            if (ok) {
                proxy.failures = 0;
                proxy.cooldownUntil = 0;
            }
            return ok;
        })();
        this.checking.set(proxy.id, check);
        try {
            return await check;
        } finally {
            if (this.checking.get(proxy.id) === check) this.checking.delete(proxy.id);
        }
    }

    /** TCP health check only; it verifies that a configured proxy port is reachable, not the target site. */
    async healthCheckAll({ force = false, signal } = {}) {
        if (!this.proxies.length) return { configured: 0, healthy: 0, proxies: [] };
        await Promise.all(this.proxies.map((proxy) => this.#check(proxy, { force, signal })));
        const snapshot = this.snapshot();
        return { configured: snapshot.configured, healthy: snapshot.healthy, proxies: snapshot.proxies };
    }

    /** Choose the next healthy, explicitly configured egress proxy; no direct fallback if all are down. */
    async select({ source = '', signal } = {}) {
        if (!this.proxies.length || this.rotation === 'disabled') return null;
        throwIfAborted(signal);
        if (this.healthCheckEnabled) {
            await Promise.all(this.proxies.map((proxy) => this.#check(proxy, { signal })));
            throwIfAborted(signal);
        }
        const now = this.now();
        const candidates = this.proxies.filter((proxy) => proxy.cooldownUntil <= now
            && (!this.healthCheckEnabled || proxy.health === 'healthy'));
        if (!candidates.length) {
            const until = Math.max(...this.proxies.map((proxy) => proxy.cooldownUntil || (proxy.checkedAt ? proxy.checkedAt + this.healthTtlMs : 0)));
            const retryAfter = Math.max(1, Math.ceil((until - now) / 1000));
            throw new ProxyUnavailableError(retryAfter);
        }
        if (this.rotation === 'sticky' && source) {
            const currentId = this.sticky.get(source);
            const current = candidates.find((proxy) => proxy.id === currentId);
            if (current) return this.#lease(current);
        }
        const start = this.cursor++ % candidates.length;
        const selected = candidates[start];
        if (this.rotation === 'sticky' && source) this.sticky.set(source, selected.id);
        return this.#lease(selected);
    }

    #lease(proxy) {
        // No complete URL or credentials are returned by diagnostics; this lease is process-internal.
        return Object.freeze({
            id: proxy.id,
            protocol: proxy.protocol,
            server: proxy.server,
            username: proxy.username,
            password: proxy.password,
            socksType: proxy.socksType,
        });
    }

    dispatcher(lease) {
        if (!lease) return undefined;
        const proxy = this.proxies.find((item) => item.id === lease.id);
        if (!proxy) throw new Error('Proxy lease tidak dikenal.');
        if (!proxy.dispatcher) proxy.dispatcher = this.makeDispatcher(proxy, this.connectTimeoutMs);
        return proxy.dispatcher;
    }

    /** Format proxy untuk Playwright tanpa menyisipkan userinfo di URL. */
    browserProxy(lease) {
        if (!lease) return undefined;
        const proxy = this.proxies.find((item) => item.id === lease.id);
        if (!proxy) throw new Error('Proxy lease tidak dikenal.');
        if (proxy.socksType === 4) throw new TypeError('Browser Automation memerlukan HTTP(S) atau SOCKS5 proxy.');
        return {
            server: proxy.protocol === 'socks5h:' ? `socks5://${proxy.hostname.includes(':') && !proxy.hostname.startsWith('[') ? `[${proxy.hostname}]` : proxy.hostname}:${proxy.port}` : proxy.server,
            ...(proxy.username ? { username: proxy.username } : {}),
            ...(proxy.password ? { password: proxy.password } : {}),
        };
    }

    reportSuccess(id) {
        const proxy = this.proxies.find((item) => item.id === id);
        if (!proxy) return;
        proxy.health = 'healthy';
        proxy.checkedAt = this.now();
        proxy.failures = 0;
        proxy.cooldownUntil = 0;
        proxy.lastError = '';
    }

    /** Call only for transport failures/timeouts, never for HTTP 403/429/challenges. */
    reportFailure(id, error) {
        const proxy = this.proxies.find((item) => item.id === id);
        if (!proxy) return;
        proxy.failures++;
        proxy.health = 'unhealthy';
        proxy.checkedAt = this.now();
        proxy.cooldownUntil = this.now() + this.failureCooldownMs;
        proxy.lastError = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network';
    }

    snapshot() {
        const now = this.now();
        const proxies = this.proxies.map((proxy) => ({
            id: proxy.id,
            protocol: proxy.protocol.slice(0, -1),
            state: proxy.cooldownUntil > now ? 'cooldown' : proxy.health,
            failures: proxy.failures,
            retryAfter: proxy.cooldownUntil > now ? Math.ceil((proxy.cooldownUntil - now) / 1000) : 0,
        }));
        return {
            enabled: this.enabled,
            strategy: this.rotation,
            configured: this.proxies.length,
            healthy: proxies.filter((proxy) => proxy.state === 'healthy').length,
            proxies,
            healthCheck: this.healthCheckEnabled ? 'tcp' : 'disabled',
        };
    }

    async close() {
        await Promise.all(this.proxies.map(async (proxy) => {
            if (!proxy.dispatcher) return;
            try {
                if (typeof proxy.dispatcher.close === 'function') await proxy.dispatcher.close();
                else proxy.dispatcher.destroy?.();
            } catch {
                // Cleanup is best-effort; never log a dispatcher error that may contain proxy details.
            }
            proxy.dispatcher = null;
        }));
    }
}
