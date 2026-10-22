/**
 * Kazanime backend — lib/browser-automation.js
 * Optional Playwright rendering for an explicitly configured JavaScript-dependent
 * source. It is never a fallback for HTTP 403/429, CAPTCHA, or security challenges.
 */
import { SourceError } from './errors.js';

function normalizedHost(value) {
    return String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function abortedError(source, signal) {
    if (signal?.reason?.name === 'TimeoutError') {
        return new SourceError(`${source} terlalu lama merespons saat JavaScript rendering.`, { kind: 'timeout', source });
    }
    return new SourceError('Permintaan dibatalkan.', { kind: 'abort', source });
}

function makeHostAllowed(allowedHosts = [], allowedHostSuffixes = []) {
    const exact = new Set(allowedHosts.map(normalizedHost));
    const suffixes = allowedHostSuffixes.map((host) => normalizedHost(host).replace(/^\.+/, '')).filter(Boolean);
    return (hostname) => {
        const host = normalizedHost(hostname);
        return exact.has(host) || suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    };
}

export class BrowserAutomation {
    /**
     * @param {{enabled?: boolean, settleMs?: number, executablePath?: string, fingerprintManager?: any,
     *   cookieManager?: any, proxyManager?: any, requestManager?: any, robots?: any, circuit?: any,
     *   loadPlaywright?: () => Promise<any>}} [opts]
     */
    constructor({
        enabled = true,
        settleMs = 350,
        executablePath = '',
        fingerprintManager,
        cookieManager,
        proxyManager,
        requestManager,
        robots,
        circuit,
        loadPlaywright = () => import('playwright-core'),
    } = {}) {
        this.enabled = Boolean(enabled);
        this.settleMs = Math.max(0, Math.min(5000, Math.trunc(settleMs) || 0));
        this.executablePath = String(executablePath || '');
        this.fingerprintManager = fingerprintManager;
        this.cookieManager = cookieManager;
        this.proxyManager = proxyManager;
        this.requestManager = requestManager;
        this.robots = robots;
        this.circuit = circuit;
        this.loadPlaywright = loadPlaywright;
        this.state = 'idle';
    }

    /**
     * @param {{source:string,url:string,allowedHosts:string[],allowedHostSuffixes?:string[],timeoutMs:number,
     *   maxBytes:number,proxy?:{id:string}|null,signal?:AbortSignal,requireExplicitRobots?:boolean,
     *   checkRobots?:boolean,intervalMs?:number,maxCrawlDelayMs?:number,blockedMs?:number}} opts
     * @returns {Promise<{status:number,url:string,text:string,headers:Headers,cookies:any[]}>}
     */
    async render({
        source, url, allowedHosts, allowedHostSuffixes = [], timeoutMs, maxBytes, proxy = null, signal,
        checkRobots = true, requireExplicitRobots = false, intervalMs = 1000, maxCrawlDelayMs = 10000, blockedMs = 30 * 60 * 1000,
    } = {}) {
        if (!this.enabled) throw new SourceError('Browser Automation dinonaktifkan oleh konfigurasi.', { kind: 'disabled', source });
        let target;
        try { target = new URL(url); } catch { throw new SourceError('URL Browser Automation tidak valid.', { kind: 'policy', source }); }
        const hostAllowed = makeHostAllowed(allowedHosts, allowedHostSuffixes);
        if (!/^https?:$/.test(target.protocol) || !hostAllowed(target.hostname) || target.username || target.password) {
            throw new SourceError(`Host ${target.hostname} tidak diizinkan untuk Browser Automation ${source}.`, { kind: 'policy', source });
        }
        if (signal?.aborted) throw abortedError(source, signal);

        let playwright;
        try {
            playwright = await this.loadPlaywright();
        } catch {
            throw new SourceError('JavaScript rendering diminta, tetapi playwright-core belum terpasang.', { kind: 'disabled', source });
        }
        if (!playwright?.chromium?.launch) throw new SourceError('Playwright Chromium tidak tersedia.', { kind: 'disabled', source });

        let browser;
        let context;
        let page;
        let abortHandler;
        let activeRequests = new Map();
        const timeout = Math.max(1000, Math.min(30000, Math.trunc(timeoutMs) || 6000));
        this.state = 'rendering';
        try {
            if (signal?.aborted) throw abortedError(source, signal);
            const launchOptions = { headless: true, timeout };
            if (this.executablePath) launchOptions.executablePath = this.executablePath;
            if (proxy) {
                try {
                    launchOptions.proxy = this.proxyManager?.browserProxy(proxy);
                } catch {
                    throw new SourceError('Proxy terkonfigurasi tidak kompatibel dengan Browser Automation.', { kind: 'policy', source });
                }
            }
            try {
                browser = await playwright.chromium.launch(launchOptions);
            } catch {
                throw new SourceError('Chromium untuk Playwright belum terpasang atau tidak tersedia.', { kind: 'disabled', source });
            }
            if (signal?.aborted) throw abortedError(source, signal);
            context = await browser.newContext(this.fingerprintManager?.contextOptions(source) || {});
            const storedCookies = await this.cookieManager?.getCookiesForBrowser(source, target.href) || [];
            if (storedCookies.length) await context.addCookies(storedCookies);
            page = await context.newPage();
            page.setDefaultNavigationTimeout(timeout);
            page.setDefaultTimeout(timeout);
            activeRequests = new Map();
            let requestPolicyError = null;
            const releaseRequest = (request) => {
                const release = activeRequests.get(request);
                if (!release) return;
                activeRequests.delete(request);
                release();
            };
            page.on?.('requestfinished', releaseRequest);
            page.on?.('requestfailed', releaseRequest);
            await page.route('**/*', async (route) => {
                const request = route.request();
                let resource;
                try { resource = new URL(request.url()); } catch { await route.abort().catch(() => {}); return; }
                if (['data:', 'blob:'].includes(resource.protocol)) { await route.continue(); return; }
                if (!/^https?:$/.test(resource.protocol) || (target.protocol === 'https:' && resource.protocol === 'http:')
                    || resource.username || resource.password || !hostAllowed(resource.hostname)) {
                    if (request.isNavigationRequest?.()) {
                        requestPolicyError = new SourceError('Redirect Browser Automation di luar allowlist diblokir.', { kind: 'policy', source });
                    }
                    await route.abort().catch(() => {});
                    return;
                }

                let crawlDelayMs = 0;
                if (checkRobots && this.robots) {
                    let verdict;
                    try {
                        verdict = await this.robots.check(resource.href, { signal, requireExplicit: requireExplicitRobots });
                    } catch {
                        if (!signal?.aborted && request.isNavigationRequest?.()) {
                            requestPolicyError = new SourceError(`robots.txt ${source} tidak dapat diverifikasi; navigasi JavaScript dihentikan.`, { kind: 'robots', source, retryAfter: 600 });
                        }
                        await route.abort().catch(() => {});
                        return;
                    }
                    if (!verdict.allowed) {
                        if (verdict.reason === 'blocked') {
                            this.circuit?.failure(source, { reason: 'blocked', immediate: true, openMs: blockedMs });
                            requestPolicyError = new SourceError(`${source} dibatasi robots.txt atau challenge keamanan; rendering dihentikan.`, { kind: 'blocked', source });
                        } else if (request.isNavigationRequest?.()) {
                            const kind = verdict.reason === 'unverified' ? 'policy' : 'robots';
                            requestPolicyError = new SourceError(`robots.txt ${source} tidak mengizinkan navigasi JavaScript.`, {
                                kind, source, retryAfter: verdict.reason === 'unreachable' ? 600 : 0,
                            });
                        }
                        await route.abort().catch(() => {});
                        return;
                    }
                    crawlDelayMs = Math.min(verdict.crawlDelayMs || 0, maxCrawlDelayMs);
                }

                let release;
                try {
                    release = await this.requestManager?.acquire(resource.host, {
                        intervalMs: Math.max(intervalMs, crawlDelayMs), signal, source,
                    });
                    if (release) activeRequests.set(request, release);
                    await route.continue();
                } catch (error) {
                    if (release) releaseRequest(request);
                    if (request.isNavigationRequest?.() && error instanceof SourceError) requestPolicyError = error;
                    await route.abort().catch(() => {});
                }
            });
            abortHandler = () => { void page.close().catch(() => {}); };
            if (signal?.aborted) throw abortedError(source, signal);
            signal?.addEventListener('abort', abortHandler, { once: true });
            let response;
            try {
                response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout });
            } catch (error) {
                if (signal?.aborted) throw abortedError(source, signal);
                if (requestPolicyError) throw requestPolicyError;
                throw error;
            }
            if (signal?.aborted) throw abortedError(source, signal);
            if (requestPolicyError) throw requestPolicyError;
            const finalUrl = page.url();
            let final;
            try { final = new URL(finalUrl); } catch { throw new SourceError('Halaman Browser Automation mengarah ke URL tidak valid.', { kind: 'policy', source }); }
            if (!/^https?:$/.test(final.protocol) || (target.protocol === 'https:' && final.protocol === 'http:')
                || final.username || final.password || !hostAllowed(final.hostname)) {
                throw new SourceError('Redirect Browser Automation di luar allowlist diblokir.', { kind: 'policy', source });
            }

            const left = Math.max(0, Math.min(this.settleMs, timeout));
            if (left) await page.waitForTimeout(left);
            const text = await page.content();
            if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new SourceError('Halaman sumber terlalu besar.', { kind: 'parse', source });
            let headerValues = {};
            try { headerValues = response ? await response.allHeaders() : {}; } catch { /* header opsional */ }
            const cookies = await context.cookies(final.href);
            this.state = 'idle';
            return {
                status: response?.status?.() || 200,
                url: final.href,
                text,
                headers: new Headers(headerValues),
                cookies,
            };
        } catch (error) {
            if (error instanceof SourceError) throw error;
            if (signal?.aborted) throw abortedError(source, signal);
            if (/timeout/i.test(String(error?.name || ''))) throw new SourceError(`${source} terlalu lama merespons saat JavaScript rendering.`, { kind: 'timeout', source });
            throw new SourceError(`${source} gagal dirender oleh Browser Automation.`, { kind: 'network', source, cause: error });
        } finally {
            signal?.removeEventListener('abort', abortHandler);
            for (const release of activeRequests.values()) release();
            activeRequests.clear();
            await context?.close().catch(() => {});
            await browser?.close().catch(() => {});
            this.state = 'idle';
        }
    }

    snapshot() {
        return { enabled: this.enabled, state: this.state, renderer: 'playwright-core', challengeFallback: false };
    }
}
