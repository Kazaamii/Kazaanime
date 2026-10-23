/**
 * Kazanime backend — lib/fetcher.js
 * SATU-SATUNYA tempat backend melakukan request keluar. Setiap request:
 *   1. hanya ke host yang diizinkan (anti-SSRF)
 *   2. lolos circuit breaker dan robots.txt (RFC 9309)
 *   3. mengikuti throttle + concurrency RequestManager
 *   4. memakai User-Agent transparan, timeout, batas respons, retry jaringan/5xx terbatas
 *   5. fail-closed pada HTTP 403/429, CAPTCHA, dan security challenge; tidak ada solver/retry.
 *
 * Proxy yang dipakai hanya egress yang dikonfigurasi operator. Challenge tidak memicu rotasi.
 * Cookie jar dipisahkan per sumber dan hanya menerima cookie dari respons yang tidak dibatasi.
 * Playwright hanya dipakai bila adapter mengaktifkan rendering JS; bukan fallback challenge.
 */
import { load } from 'cheerio';
import { fetch as undiciFetch } from 'undici';
import { BOT, SCRAPER, SCRAPER_RUNTIME } from '../config.js';
import { SourceError } from './errors.js';
import { BrowserAutomation } from './browser-automation.js';
import { ChallengeHandler, looksLikeChallenge, retryAfterSeconds } from './challenge-handler.js';
import { CookieManager } from './cookie-manager.js';
import { FingerprintManager } from './fingerprint-manager.js';
import { ProxyManager, ProxyUnavailableError } from './proxy-manager.js';
import { RequestManager } from './request-manager.js';
import { CircuitBreaker, HostThrottle } from './rate-limit.js';
import { RobotsGate } from './robots.js';

export { looksLikeChallenge, retryAfterSeconds };

/**
 * Baca body dengan batas ukuran.
 * @param {Response} res
 * @param {number} maxBytes
 * @param {{truncate?: boolean, source?: string}} [opts] truncate = potong (robots.txt) alih-alih error
 */
export async function readBody(res, maxBytes, { truncate = false, source = '' } = {}) {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel().catch(() => {});
            if (!truncate) throw new SourceError('Halaman sumber terlalu besar.', { kind: 'parse', source });
            chunks.push(value.subarray(0, value.byteLength - (size - maxBytes)));
            break;
        }
        chunks.push(value);
    }
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

function combineSignals(timeoutMs, signal) {
    const t = AbortSignal.timeout(Math.max(1, Math.round(timeoutMs)));
    return signal ? AbortSignal.any([t, signal]) : t;
}

function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PRIVATE_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|referer|origin|x-goog-api-key|x-api-key|api-key|.*(?:token|secret|api[-_]key).*)$/i;
const BODY_HEADERS = ['content-length', 'content-type', 'content-encoding', 'transfer-encoding'];

/**
 * Infrastruktur bersama untuk semua klien: request manager, proxy/cookie/browser managers,
 * circuit breaker, dan robots.txt. fetchImpl dapat diinjeksi untuk unit test.
 * @param {{fetchImpl?: typeof fetch, userAgent?: string, token?: string, scraper?: typeof SCRAPER,
 *   runtime?: typeof SCRAPER_RUNTIME, cache?: any, now?: () => number, proxyManager?: ProxyManager,
 *   cookieManager?: CookieManager, fingerprintManager?: FingerprintManager, requestManager?: RequestManager,
 *   browserAutomation?: BrowserAutomation}} [opts]
 */
export function createNetwork({
    fetchImpl = undiciFetch,
    userAgent = BOT.userAgent,
    token = BOT.token,
    scraper = SCRAPER,
    runtime = SCRAPER_RUNTIME,
    cache = null,
    now = Date.now,
    proxyManager = null,
    cookieManager = null,
    fingerprintManager = null,
    requestManager = null,
    browserAutomation = null,
} = {}) {
    const robotsMode = normalizeRobotsMode(scraper.robots?.mode);
    const throttle = new HostThrottle({ intervalMs: scraper.minIntervalMs, maxWaitMs: scraper.maxQueueWaitMs, now });
    const circuit = new CircuitBreaker({ failures: scraper.circuit.failures, openMs: scraper.circuit.openMs, now });
    const proxies = proxyManager || new ProxyManager({ ...runtime.proxy, now });
    const cookies = cookieManager || new CookieManager(runtime.cookies);
    const fingerprints = fingerprintManager || new FingerprintManager({
        userAgent,
        locale: runtime.browser.locale,
        timezoneId: runtime.browser.timezoneId,
        viewport: runtime.browser.viewport,
    });
    const requests = requestManager || new RequestManager({
        throttle,
        cache,
        maxConcurrencyPerHost: runtime.request.maxConcurrencyPerHost,
        maxQueueWaitMs: scraper.maxQueueWaitMs,
        now,
    });
    const challenges = new ChallengeHandler({ circuit, blockedMs: scraper.circuit.blockedMs, now });

    /** @param {string} url @param {RequestInit} init @param {{source:string,signal?:AbortSignal}} ctx */
    async function fetchUpstream(url, init = {}, { source = '', signal = init.signal } = {}) {
        const requestSignal = init.signal || signal;
        let lease = null;
        try {
            if (requestSignal?.aborted) throw requestSignal.reason || new DOMException('Aborted', 'AbortError');
            lease = await proxies.select({ source, signal: requestSignal });
            const dispatcher = lease ? proxies.dispatcher(lease) : undefined;
            const response = await fetchImpl(url, {
                ...init,
                ...(dispatcher ? { dispatcher } : {}),
            });
            if (lease) proxies.reportSuccess(lease.id);
            return response;
        } catch (error) {
            const callerCancelled = signal?.aborted && signal.reason?.name !== 'TimeoutError';
            if (lease && !callerCancelled) proxies.reportFailure(lease.id, error);
            if (error instanceof ProxyUnavailableError) {
                throw new SourceError('Tidak ada proxy scraper yang sehat; request dihentikan tanpa koneksi langsung.', {
                    kind: 'proxy_unavailable', source, retryAfter: error.retryAfter, cause: error,
                });
            }
            throw error;
        }
    }

    const robots = new RobotsGate({
        token,
        ttlMs: scraper.robots.ttlMs,
        errorTtlMs: scraper.robots.errorTtlMs,
        now,
        fetchRobots: async (origin, signal) => {
            const url = `${origin}/robots.txt`;
            const host = new URL(url).host;
            const release = await requests.acquire(host, { signal, source: 'robots' });
            try {
                let current = new URL(url);
                const requestSignal = combineSignals(scraper.robots.timeoutMs, signal);
                let response;
                for (let hop = 0; hop <= 5; hop++) {
                    response = await fetchUpstream(current.href, {
                        headers: { 'User-Agent': userAgent, Accept: 'text/plain,*/*;q=0.5' },
                        redirect: 'manual',
                        signal: requestSignal,
                    }, { source: 'robots', signal: requestSignal });
                    const status = Number(response.status) || 0;
                    const location = REDIRECT_STATUSES.has(status) ? response.headers?.get?.('location') : '';
                    if (!location) break;
                    let next;
                    try { next = new URL(location, current); } catch { next = null; }
                    if (!next || next.origin !== origin || !/^https?:$/.test(next.protocol) || next.username || next.password || hop === 5) {
                        await response.body?.cancel?.().catch(() => {});
                        return { status: 403, text: '', blocked: true };
                    }
                    await response.body?.cancel?.().catch(() => {});
                    current = next;
                }
                const text = await readBody(response, scraper.robots.maxBytes, { truncate: true, source: 'robots' });
                return {
                    status: response.status,
                    text,
                    blocked: response.status === 403 || looksLikeChallenge({ status: response.status, headers: response.headers, text }),
                };
            } finally {
                release();
            }
        },
    });
    const browser = browserAutomation || new BrowserAutomation({
        ...runtime.browser,
        fingerprintManager: fingerprints,
        cookieManager: cookies,
        proxyManager: proxies,
        requestManager: requests,
        robots,
        circuit,
    });

    return {
        fetchImpl,
        fetch: fetchUpstream,
        robotsMode,
        userAgent,
        throttle,
        requestManager: requests,
        proxyManager: proxies,
        cookieManager: cookies,
        fingerprintManager: fingerprints,
        browserAutomation: browser,
        challengeHandler: challenges,
        circuit,
        robots,
        scraper,
    };
}

function robotsError(reason, source, url, httpStatus = 0) {
    let kind = 'robots';
    let message;
    let retryAfter = 0;
    switch (reason) {
        case 'blocked':
            kind = 'blocked';
            message = `${source} menolak akses bot melalui robots.txt atau challenge keamanan — tidak diakses.`;
            break;
        case 'unreachable':
            message = `robots.txt ${source} tidak bisa dibaca (server error) — menurut RFC 9309 dianggap melarang sementara.`;
            retryAfter = 600;
            break;
        case 'unverified':
            kind = 'policy';
            message = `${source}: ToS belum bisa ditinjau dan robots.txt tidak tersedia — tidak diakses.`;
            break;
        default:
            message = `robots.txt ${source} melarang ${url.pathname}.`;
            break;
    }
    const error = new SourceError(message, { kind, source, httpStatus, retryAfter });
    error.stage = 'robots';
    return error;
}

/** Mode gerbang robots.txt yang dipakai klien (lihat server/config.js). */
export function normalizeRobotsMode(value) {
    return ['enforce', 'warn', 'off'].includes(String(value || '').toLowerCase())
        ? String(value).toLowerCase()
        : 'enforce';
}

/**
 * Klien HTTP untuk satu sumber.
 * @param {ReturnType<typeof createNetwork>} net
 * @param {{source:string, allowedHosts:string[], robots?:boolean, requireExplicitRobots?:boolean,
 *   timeoutMs?:number, retries?:number, intervalMs?:number, headers?:Record<string,string>,
 *   allowedHostSuffixes?:string[], blockedMs?:number, cookies?:boolean, renderJavaScript?:boolean}} opts
 */
export function createClient(net, opts) {
    const {
        source,
        allowedHosts,
        robots: useRobots = true,
        requireExplicitRobots = false,
        timeoutMs = net.scraper.timeoutMs,
        retries = net.scraper.retries,
        intervalMs = net.scraper.minIntervalMs,
        headers: baseHeaders = {},
        allowedHostSuffixes = [],
        blockedMs = net.scraper.circuit.blockedMs,
        cookies: useCookies = false,
        renderJavaScript: useBrowser = false,
    } = opts;
    const robotsMode = normalizeRobotsMode(net.scraper?.robots?.mode);
    /** Catatan saat robots.txt melarang tetapi mode 'warn' membuat request tetap jalan. */
    const robotsNotes = [];
    const warnedSources = new Set();
    const noteRobots = (verdict, target) => {
        if (robotsMode !== 'warn') return;
        const note = {
            source,
            reason: String(verdict?.reason || 'disallowed'),
            url: String(target),
            at: new Date().toISOString(),
        };
        robotsNotes.push(note);
        if (robotsNotes.length > 100) robotsNotes.shift();
        if (!warnedSources.has(source)) {
            warnedSources.add(source);
            console.warn(`[robots] mode=warn: ${source} ${note.reason} (${note.url}) — request tetap dijalankan karena SCRAPER_ROBOTS_MODE=warn.`);
        }
    };
    const suffixes = allowedHostSuffixes.map((s) => String(s).toLowerCase().replace(/^\.+/, '')).filter(Boolean);
    /** Host boleh diakses klien ini? (daftar persis + sufiks domain, mis. "xin-cdn.xyz" → "suzaku.xin-cdn.xyz") */
    const hostAllowed = (host) => {
        const h = String(host || '').toLowerCase();
        return Boolean(h) && (allowedHosts.includes(h) || suffixes.some((s) => h === s || h.endsWith(`.${s}`)));
    };

    /** Validate every redirect before following it; credentials and cookies stay scoped. */
    async function fetchAllowed(url, init, {
        signal = init.signal,
        cookiesEnabled = false,
        checkRobots = useRobots,
        releaseStack = [],
        crawlDelayMs = 0,
        manageHostSlots = true,
    } = {}) {
        const initial = new URL(url);
        let current = initial;
        let method = String(init.method || 'GET').toUpperCase();
        let body = init.body;
        let bodyDropped = false;
        let privateHeadersRemoved = false;
        const heldHosts = new Set([initial.host]);

        for (let hop = 0; hop <= 5; hop++) {
            if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
            if (current.origin !== initial.origin) privateHeadersRemoved = true;
            const requestHeaders = new Headers(init.headers || {});
            requestHeaders.delete('cookie');
            if (privateHeadersRemoved) {
                for (const name of [...requestHeaders.keys()]) if (PRIVATE_HEADER.test(name)) requestHeaders.delete(name);
            }
            if (bodyDropped) for (const name of BODY_HEADERS) requestHeaders.delete(name);
            if (cookiesEnabled) {
                const cookieHeader = await net.cookieManager.getCookieHeader(source, current.href);
                if (cookieHeader) requestHeaders.set('Cookie', cookieHeader);
            }

            const response = await net.fetch(current.href, {
                ...init,
                method,
                body: method === 'GET' || method === 'HEAD' ? undefined : body,
                headers: requestHeaders,
                redirect: 'manual',
                signal,
            }, { source, signal });
            const status = Number(response.status) || 0;
            if (!REDIRECT_STATUSES.has(status)) return { response, url: current.href, crawlDelayMs };
            const location = response.headers?.get?.('location');
            if (!location) return { response, url: current.href, crawlDelayMs };

            let next;
            try { next = new URL(location, current); } catch {
                await response.body?.cancel?.().catch(() => {});
                throw new SourceError(`${source} mengirim redirect dengan URL tidak valid.`, { kind: 'policy', source });
            }
            const validTarget = /^https?:$/.test(next.protocol)
                && hostAllowed(next.hostname)
                && !next.username
                && !next.password
                && !(current.protocol === 'https:' && next.protocol === 'http:');
            if (!validTarget) {
                await response.body?.cancel?.().catch(() => {});
                throw new SourceError(`${source} redirect menuju host/protokol yang tidak diizinkan; request dihentikan.`, { kind: 'policy', source });
            }
            if (hop === 5) {
                await response.body?.cancel?.().catch(() => {});
                throw new SourceError(`${source} mengirim terlalu banyak redirect.`, { kind: 'policy', source });
            }

            let nextMethod = method;
            let nextBody = body;
            let nextBodyDropped = bodyDropped;
            if (status === 303 || ([301, 302].includes(status) && method === 'POST')) {
                nextMethod = 'GET';
                nextBody = undefined;
                nextBodyDropped = true;
            }
            if (next.origin !== current.origin && !['GET', 'HEAD'].includes(nextMethod)) {
                await response.body?.cancel?.().catch(() => {});
                throw new SourceError(`${source} redirect lintas origin untuk request ber-body diblokir.`, { kind: 'policy', source });
            }

            await response.body?.cancel?.().catch(() => {});
            let nextCrawlDelay = crawlDelayMs;
            if (checkRobots && robotsMode !== 'off') {
                const verdict = await net.robots.check(next.href, { signal, requireExplicit: requireExplicitRobots });
                if (!verdict.allowed) {
                    if (robotsMode === 'enforce') {
                        await response.body?.cancel?.().catch(() => {});
                        if (verdict.reason === 'blocked') net.circuit.failure(source, { reason: 'blocked', immediate: true, openMs: blockedMs });
                        throw robotsError(verdict.reason, source, next);
                    }
                    noteRobots(verdict, next.href);
                }
                nextCrawlDelay = Math.max(nextCrawlDelay, Math.min(verdict.crawlDelayMs || 0, net.scraper.maxCrawlDelayMs));
            }
            if (cookiesEnabled) await net.cookieManager.storeResponse(source, current.href, response.headers);

            if (manageHostSlots && !heldHosts.has(next.host)) {
                const redirectRelease = await net.requestManager.acquire(next.host, {
                    intervalMs: Math.max(intervalMs, nextCrawlDelay), signal, source,
                });
                releaseStack.push(redirectRelease);
                heldHosts.add(next.host);
            }
            current = next;
            method = nextMethod;
            body = nextBody;
            bodyDropped = nextBodyDropped;
            crawlDelayMs = nextCrawlDelay;
        }
        throw new SourceError(`${source} mengirim terlalu banyak redirect.`, { kind: 'policy', source });
    }

    /**
     * @param {string} url
     * @param {{signal?:AbortSignal,deadline?:number,accept?:string,method?:string,body?:string,
     *   headers?:Record<string,string>,passErrors?:boolean,cookies?:boolean,renderJavaScript?:boolean}} [o]
     *   passErrors: hanya untuk API resmi yang harus membaca body error; challenge eksplisit tetap dihentikan.
     */
    async function request(url, {
        signal,
        deadline,
        accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        method = 'GET',
        body,
        headers,
        passErrors = false,
        cookies = useCookies,
        renderJavaScript = useBrowser,
    } = {}) {
        let u;
        try {
            u = new URL(url);
        } catch {
            throw new SourceError('URL sumber tidak valid.', { kind: 'policy', source });
        }
        if (!/^https?:$/.test(u.protocol) || !hostAllowed(u.hostname) || u.username || u.password) {
            throw new SourceError(`Host atau autentikasi URL tidak diizinkan untuk ${source}.`, { kind: 'policy', source });
        }

        const c = net.circuit.check(source);
        if (c.open) {
            throw new SourceError(`${source} sedang diistirahatkan (${c.reason || 'baru saja gagal'}), dicoba lagi ±${c.retryAfter} dtk.`, {
                kind: ['blocked', 'challenge'].includes(c.reason) ? 'blocked' : 'circuit', source, retryAfter: c.retryAfter,
            });
        }

        let crawlDelayMs = 0;
        if (useRobots && robotsMode !== 'off') {
            const verdict = await net.robots.check(u.href, { signal, requireExplicit: requireExplicitRobots });
            if (!verdict.allowed) {
                if (robotsMode === 'enforce') {
                    if (verdict.reason === 'blocked') net.circuit.failure(source, { reason: 'blocked', immediate: true, openMs: blockedMs });
                    throw robotsError(verdict.reason, source, u, verdict.httpStatus);
                }
                // 'warn': robots.txt hanya informasi; situs tetap diakses dengan identitas bot jujur + rate limit.
                noteRobots(verdict, u.href);
            }
            crawlDelayMs = Math.min(verdict.crawlDelayMs || 0, net.scraper.maxCrawlDelayMs);
        }

        let lastErr = null;
        const maxAttempts = Math.max(0, Math.min(2, Math.trunc(retries) || 0));
        for (let attempt = 0; attempt <= maxAttempts; attempt++) {
            if (attempt > 0) await net.requestManager.backoff(attempt, { signal, baseDelayMs: 400, maxDelayMs: 1600, jitterMs: 200 });
            const releaseStack = renderJavaScript ? [] : [await net.requestManager.acquire(u.host, { intervalMs: Math.max(intervalMs, crawlDelayMs), signal, source })];
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                for (const releaseOne of releaseStack.splice(0)) releaseOne();
            };
            const left = deadline ? deadline - Date.now() : Infinity;
            if (left < 250) {
                release();
                throw new SourceError(`Waktu habis menunggu ${source}.`, { kind: 'timeout', source });
            }
            const t = Math.min(timeoutMs, left);
            const requestSignal = combineSignals(t, signal);

            let response;
            let text;
            let responseUrl = u.href;
            let renderedCookies = null;
            try {
                if (renderJavaScript) {
                    let proxy = null;
                    try {
                        proxy = await net.proxyManager.select({ source, signal: requestSignal });
                        const rendered = await net.browserAutomation.render({
                            source,
                            url: u.href,
                            allowedHosts,
                            allowedHostSuffixes,
                            timeoutMs: t,
                            maxBytes: net.scraper.maxBodyBytes,
                            proxy,
                            signal: requestSignal,
                            checkRobots: useRobots,
                            requireExplicitRobots,
                            intervalMs,
                            maxCrawlDelayMs: net.scraper.maxCrawlDelayMs,
                            blockedMs,
                        });
                        if (proxy) net.proxyManager.reportSuccess(proxy.id);
                        response = rendered;
                        responseUrl = rendered.url || u.href;
                        text = rendered.text;
                        renderedCookies = rendered.cookies;
                    } catch (error) {
                        if (proxy && !signal?.aborted && ['network', 'timeout'].includes(error?.kind)) net.proxyManager.reportFailure(proxy.id, error);
                        if (error instanceof ProxyUnavailableError) {
                            throw new SourceError('Tidak ada proxy scraper yang sehat; request dihentikan tanpa koneksi langsung.', {
                                kind: 'proxy_unavailable', source, retryAfter: error.retryAfter, cause: error,
                            });
                        }
                        throw error;
                    }
                } else {
                    const requestHeaders = {
                        'User-Agent': net.userAgent,
                        Accept: accept,
                        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
                        ...baseHeaders,
                        ...headers,
                    };
                    const fetched = await fetchAllowed(u.href, {
                        method,
                        body,
                        headers: requestHeaders,
                        signal: requestSignal,
                    }, {
                        signal: requestSignal,
                        cookiesEnabled: cookies,
                        checkRobots: useRobots,
                        releaseStack,
                        crawlDelayMs,
                    });
                    response = fetched.response;
                    responseUrl = fetched.url;
                    crawlDelayMs = fetched.crawlDelayMs;
                    text = await readBody(response, net.scraper.maxBodyBytes, { source });
                }
                const finalHost = hostOf(response.url) || hostOf(responseUrl) || u.hostname;
                if (!hostAllowed(finalHost)) {
                    await response.body?.cancel?.().catch(() => {});
                    throw new SourceError(`${source} mengalihkan ke host lain (${finalHost}) — tidak diikuti.`, { kind: 'policy', source });
                }
            } catch (error) {
                release();
                if (error instanceof SourceError) {
                    if (error.kind === 'network' && attempt < maxAttempts) {
                        lastErr = error;
                        continue;
                    }
                    if (error.kind === 'timeout') net.circuit.failure(source, { reason: 'timeout' });
                    throw error;
                }
                if (signal?.aborted) throw new SourceError('Permintaan dibatalkan.', { kind: 'abort', source });
                if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
                    net.circuit.failure(source, { reason: 'timeout' });
                    throw new SourceError(`${source} terlalu lama merespons (${Math.round(t / 1000)} dtk).`, { kind: 'timeout', source });
                }
                lastErr = new SourceError(`Tidak dapat terhubung ke ${source}.`, { kind: 'network', source, cause: error });
                if (attempt < maxAttempts) continue;
                break;
            } finally {
                // release() is idempotent; the catch path also releases before retry/throw.
                release();
            }

            const status = Number(response.status) || 0;
            const restricted = net.challengeHandler.inspect({ source, status, headers: response.headers, text, passErrors, blockedMs });
            if (restricted) throw restricted;
            if (passErrors) {
                net.circuit.success(source);
                return { status, url: response.url || u.href, text, headers: response.headers };
            }
            if (status === 404 || status === 410) {
                net.circuit.success(source);
                throw new SourceError('Halaman tidak ditemukan di situs sumber.', { kind: 'not_found', source, httpStatus: status });
            }
            if (status >= 500) {
                lastErr = new SourceError(`${source} sedang gangguan (HTTP ${status}).`, { kind: 'http', source, httpStatus: status });
                if (attempt < maxAttempts) continue;
                break;
            }
            if (status < 200 || status >= 300) {
                net.circuit.failure(source, { reason: `HTTP ${status}` });
                throw new SourceError(`${source} menolak permintaan (HTTP ${status}).`, { kind: 'http', source, httpStatus: status });
            }

            if (cookies) {
                if (Array.isArray(renderedCookies)) await net.cookieManager.storeBrowserCookies(source, response.url || responseUrl, renderedCookies);
                else await net.cookieManager.storeResponse(source, response.url || responseUrl, response.headers);
            }
            net.circuit.success(source);
            return { status, url: response.url || responseUrl, text, headers: response.headers };
        }
        net.circuit.failure(source, { reason: lastErr?.kind || 'error' });
        throw lastErr || new SourceError(`${source} gagal dihubungi.`, { kind: 'network', source });
    }

    /**
     * Teruskan respons BINER apa adanya (segmen video / key HLS) untuk proxy media.
     * Tetap: allowlist host (anti-SSRF, termasuk host akhir setelah redirect), timeout, batas ukuran.
     * Tanpa robots.txt/crawl throttle: ini bukan crawling. Allowlist, timeout, proxy, dan circuit
     * pembatasan tetap berlaku; rate limit per IP di route melindungi CDN.
     * @param {string} url
     * @param {{signal?: AbortSignal, headers?: Record<string,string>, timeoutMs?: number, maxBytes?: number}} [o]
     * @returns {Promise<{status: number, headers: Headers, body: ReadableStream<Uint8Array>|null, url: string}>}
     */
    async function stream(url, { signal, headers, timeoutMs: t = timeoutMs, maxBytes = 64 * 1024 * 1024 } = {}) {
        let u;
        try {
            u = new URL(url);
        } catch {
            throw new SourceError('URL media tidak valid.', { kind: 'policy', source });
        }
        if (!/^https?:$/.test(u.protocol) || !hostAllowed(u.hostname) || u.username || u.password) {
            throw new SourceError(`Host atau autentikasi URL tidak diizinkan untuk ${source}.`, { kind: 'policy', source });
        }
        const c = net.circuit.check(source);
        if (c.open) {
            throw new SourceError(`${source} sedang diistirahatkan (${c.reason || 'baru saja gagal'}), dicoba lagi ±${c.retryAfter} dtk.`, {
                kind: ['blocked', 'challenge'].includes(c.reason) ? 'blocked' : 'circuit', source, retryAfter: c.retryAfter,
            });
        }
        let res;
        let streamUrl = u.href;
        const requestSignal = combineSignals(t, signal);
        try {
            const fetched = await fetchAllowed(u.href, {
                headers: { 'User-Agent': net.userAgent, Accept: '*/*', ...baseHeaders, ...headers },
                signal: requestSignal,
            }, {
                signal: requestSignal,
                cookiesEnabled: false,
                checkRobots: false,
                manageHostSlots: false,
            });
            res = fetched.response;
            streamUrl = fetched.url;
        } catch (err) {
            if (err instanceof SourceError) {
                if (err.kind === 'network' || err.kind === 'timeout') net.circuit.failure(source, { reason: err.kind });
                throw err;
            }
            if (signal?.aborted) throw new SourceError('Permintaan dibatalkan.', { kind: 'abort', source });
            if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
                net.circuit.failure(source, { reason: 'timeout' });
                throw new SourceError(`${source} terlalu lama merespons.`, { kind: 'timeout', source });
            }
            net.circuit.failure(source, { reason: 'network' });
            throw new SourceError(`Tidak dapat terhubung ke ${source}.`, { kind: 'network', source, cause: err });
        }
        const finalHost = hostOf(res.url) || hostOf(streamUrl) || u.hostname;
        if (!hostAllowed(finalHost)) {
            await res.body?.cancel().catch(() => {});
            throw new SourceError(`${source} mengalihkan ke host lain (${finalHost}) — tidak diikuti.`, { kind: 'policy', source });
        }
        let challengeText = '';
        if (/text\/html/i.test(res.headers.get('content-type') || '') && res.body) {
            try { challengeText = await readBody(res.clone(), 50_000, { truncate: true, source }); } catch { /* inspeksi tidak mengganti aliran media utama */ }
        }
        const restriction = net.challengeHandler.inspect({ source, status: res.status, headers: res.headers, text: challengeText, blockedMs });
        if (restriction) {
            await res.body?.cancel().catch(() => {});
            throw restriction;
        }
        if (res.status >= 200 && res.status < 400) net.circuit.success(source);
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
            await res.body?.cancel().catch(() => {});
            throw new SourceError('Berkas media terlalu besar.', { kind: 'parse', source });
        }
        let seen = 0;
        const limiter = new TransformStream({
            transform(chunk, controller) {
                seen += chunk.byteLength;
                if (seen > maxBytes) controller.error(new SourceError('Berkas media terlalu besar.', { kind: 'parse', source }));
                else controller.enqueue(chunk);
            },
        });
        return { status: res.status, headers: res.headers, body: res.body ? res.body.pipeThrough(limiter) : null, url: res.url || streamUrl };
    }

    return {
        source,
        request,
        stream,
        /** Mode gerbang robots.txt klien ini ('enforce' | 'warn' | 'off'). */
        robotsMode,
        /** Catatan pelanggaran robots.txt saat mode 'warn' (diagnostik, bukan penegakan). */
        robotsNotes,
        /** HTML → cheerio. */
        async html(url, o) {
            const res = await request(url, o);
            return { $: load(res.text), url: res.url, status: res.status };
        },
        /** JSON (API metadata). */
        async json(url, o = {}) {
            const res = await request(url, { ...o, accept: 'application/json', renderJavaScript: false });
            try {
                return JSON.parse(res.text);
            } catch {
                throw new SourceError(`${source} mengirim data yang bukan JSON.`, { kind: 'parse', source });
            }
        },
    };
}
