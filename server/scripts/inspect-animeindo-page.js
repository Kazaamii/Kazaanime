#!/usr/bin/env node
/**
 * Local diagnostic for AnimeIndo's publicly accessible page.
 *
 * - Requires robots.txt to be readable and to allow every first-party request.
 * - Does not solve CAPTCHA/security challenges, rotate around blocks, spoof browser
 *   fingerprints, fetch third-party player pages, or save raw media URLs/responses.
 * - Captures same-site Fetch/XHR endpoint shapes, safe JSON schema samples, page metadata,
 *   forms, and episode-like links to help build a tested source adapter.
 *
 * Usage:
 *   node server/scripts/inspect-animeindo-page.js "https://animeindo.cloud/nonton/..."
 *   node server/scripts/inspect-animeindo-page.js "https://animeindo.cloud/nonton/..." report.json
 *
 * Set PLAYWRIGHT_EXECUTABLE_PATH to an installed Chrome/Chromium executable if needed.
 * The browser is visible so the developer can perform ordinary page interactions manually.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNetwork, looksLikeChallenge } from '../lib/fetcher.js';
import { SCRAPER } from '../config.js';

const DEFAULT_URL = 'https://animeindo.cloud/nonton/hyouken-suberu-s2-sub-indo/hnmgsws-s2-episode-3-sub-indo';
const ALLOWED_HOSTS = new Set(['animeindo.cloud', 'www.animeindo.cloud']);
const REDACT_QUERY_KEY = /token|secret|signature|(^|[_-])sig($|[_-])|auth|cookie|session|nonce|password|passwd|api.?key|(^|[_-])key($|[_-])/i;
const SENSITIVE_FIELD = /url|src|file|stream|playlist|embed|token|secret|sign|auth|cookie|session|nonce|password|api.?key|signature|(^|[_-])key($|[_-])/i;
const SAFE_VALUE_FIELD = /title|name|label|number|episode|slug|genre|studio|duration|status|total|count|type|kind|format|release|year|score|rating|quality|language|lang/i;

function typeName(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/** Keep endpoint paths and query-key names while dropping query values and fragments. */
export function sanitizeUrl(value) {
    let url;
    try {
        url = new URL(String(value));
    } catch {
        return '[invalid-url]';
    }
    const safePath = url.pathname.split('/').map((segment) => {
        if (segment.length > 96 || /token|secret|signature|nonce/i.test(segment)) return '[redacted]';
        return segment;
    }).join('/');
    const query = [...url.searchParams.keys()].slice(0, 20).map((key) => {
        const marker = REDACT_QUERY_KEY.test(key) ? '[redacted]' : '[omitted]';
        return encodeURIComponent(key) + '=' + encodeURIComponent(marker);
    }).join('&');
    return url.origin + safePath + (query ? '?' + query : '');
}

/** Remove visible URLs and inline secret-like assignments from text samples. */
export function cleanVisibleText(value) {
    return String(value ?? '')
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
        .replace(/\b(token|nonce|signature|api[_ -]?key|password|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
}

/**
 * Summarize JSON shape with a tiny allowlist of non-sensitive values.
 * Values under URL/player/file/auth-related keys are always redacted.
 */
export function summarizeJson(value, key = '', depth = 0) {
    const type = typeName(value);
    if (SENSITIVE_FIELD.test(String(key))) return { type, redacted: true };
    if (depth >= 4) return { type };
    if (Array.isArray(value)) {
        const childKey = /genre|tag|category/i.test(String(key)) ? 'genre' : '';
        return {
            type: 'array',
            count: value.length,
            sample: value.slice(0, 2).map((item) => summarizeJson(item, childKey, depth + 1)),
        };
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        const fields = {};
        for (const [name, child] of entries.slice(0, 30)) {
            fields[name] = summarizeJson(child, name, depth + 1);
        }
        return {
            type: 'object',
            fields,
            ...(entries.length > 30 ? { omittedFields: entries.length - 30 } : {}),
        };
    }
    if (SAFE_VALUE_FIELD.test(String(key)) && ['string', 'number', 'boolean'].includes(type)) {
        return { type, sample: cleanVisibleText(value).slice(0, 120) };
    }
    return { type };
}

function browserExecutable() {
    const configured = String(process.env.PLAYWRIGHT_EXECUTABLE_PATH || '').trim();
    if (configured && existsSync(configured)) return configured;

    const candidates = process.platform === 'win32'
        ? [
            path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ]
        : process.platform === 'darwin'
            ? [
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
            ]
            : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

    return candidates.find((candidate) => candidate && existsSync(candidate)) || '';
}

function isAllowedHost(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())
            && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
}

async function captureDom(page) {
    const raw = await page.evaluate(() => {
        const clip = (value, max = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
        const meta = Array.from(document.querySelectorAll('meta[name], meta[property], meta[itemprop]'))
            .slice(0, 60)
            .map((node) => ({
                key: node.getAttribute('name') || node.getAttribute('property') || node.getAttribute('itemprop') || '',
                value: node.getAttribute('content') || '',
            }));
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
            .slice(0, 50)
            .map((node) => clip(node.innerText || node.textContent));
        const links = Array.from(document.querySelectorAll('a[href]'))
            .map((node) => {
                try {
                    const url = new URL(node.href, location.href);
                    return {
                        origin: url.origin,
                        path: url.pathname,
                        href: url.href,
                        text: clip(node.innerText || node.textContent, 160),
                    };
                } catch {
                    return null;
                }
            })
            .filter((link) => link && link.origin === location.origin
                && (/\/nonton\//i.test(link.path) || /episode[-/]\d+/i.test(link.path) || /episode/i.test(link.text)))
            .slice(0, 250)
            .map(({ href, text }) => ({ href, text }));
        const forms = Array.from(document.querySelectorAll('form')).slice(0, 25).map((form) => ({
            action: form.action || location.href,
            method: String(form.method || 'get').toUpperCase(),
            inputs: Array.from(form.querySelectorAll('input, select, textarea')).slice(0, 30).map((input) => ({
                name: input.name || '',
                type: input.type || input.tagName.toLowerCase(),
            })),
        }));
        const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
            .slice(0, 8)
            .map((node) => {
                try {
                    return JSON.parse(node.textContent || 'null');
                } catch {
                    return { parseError: true };
                }
            });
        const scripts = Array.from(document.querySelectorAll('script[src]'))
            .map((node) => {
                try {
                    const url = new URL(node.src, location.href);
                    return url.origin === location.origin ? url.href : '';
                } catch {
                    return '';
                }
            })
            .filter(Boolean)
            .slice(0, 80);
        return {
            title: clip(document.title, 300),
            headings,
            meta,
            links,
            forms,
            jsonLd,
            scripts,
            bodyText: clip(document.body?.innerText || '', 8000),
        };
    });

    return {
        title: cleanVisibleText(raw.title).slice(0, 300),
        headings: raw.headings.map((value) => cleanVisibleText(value)).filter(Boolean),
        meta: raw.meta.map((item) => ({
            key: cleanVisibleText(item.key).slice(0, 100),
            value: SENSITIVE_FIELD.test(item.key) ? '[redacted]' : cleanVisibleText(item.value).slice(0, 240),
        })),
        links: raw.links.map((item) => ({
            href: sanitizeUrl(item.href),
            text: cleanVisibleText(item.text).slice(0, 160),
        })),
        forms: raw.forms.map((form) => ({
            action: sanitizeUrl(form.action),
            method: form.method,
            inputs: form.inputs,
        })),
        jsonLd: raw.jsonLd.map((value) => summarizeJson(value)),
        scripts: raw.scripts.map((value) => sanitizeUrl(value)),
        bodyText: cleanVisibleText(raw.bodyText),
    };
}

async function main() {
    const target = process.argv[2] || DEFAULT_URL;
    const outputPath = path.resolve(process.argv[3] || 'animeindo-inspection.json');
    let parsed;
    try {
        parsed = new URL(target);
    } catch {
        console.error('URL tidak valid.');
        process.exitCode = 2;
        return;
    }
    if (!isAllowedHost(target) || !/^\/nonton\//i.test(parsed.pathname)) {
        console.error('Inspektor ini hanya menerima halaman HTTPS /nonton/ di animeindo.cloud.');
        process.exitCode = 2;
        return;
    }

    const report = {
        target: sanitizeUrl(target),
        startedAt: new Date().toISOString(),
        policy: { robots: 'pending', challengeBypass: false, thirdPartyRequests: 'not fetched' },
        page: null,
        network: { requests: [], responses: [], policyBlockedRequestCount: 0 },
        notes: [],
    };

    const network = createNetwork();
    let browser;
    try {
        const robots = await network.robots.check(target, { requireExplicit: true });
        if (!robots.allowed) {
            report.policy.robots = 'denied-or-unverified';
            report.notes.push('Halaman tidak dibuka karena robots.txt melarang atau tidak dapat diverifikasi: ' + String(robots.reason || 'unknown'));
            await fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
            console.error(report.notes[0]);
            console.error('Laporan: ' + outputPath);
            process.exitCode = 2;
            return;
        }
        report.policy.robots = 'allowed';

        let chromium;
        try {
            ({ chromium } = await import('playwright-core'));
        } catch {
            throw new Error('playwright-core belum terpasang. Jalankan npm install, lalu pastikan Chrome/Chromium tersedia.');
        }
        const executablePath = browserExecutable();
        browser = await chromium.launch({
            headless: false,
            ...(executablePath ? { executablePath } : {}),
        });

        const context = await browser.newContext({
            locale: 'id-ID',
            timezoneId: 'Asia/Jakarta',
            viewport: { width: 1280, height: 800 },
        });
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(20000);
        page.setDefaultTimeout(8000);

        const activeRequests = new Map();
        const releaseRequest = (request) => {
            const release = activeRequests.get(request);
            if (release) {
                activeRequests.delete(request);
                release();
            }
        };
        page.on('requestfinished', releaseRequest);
        page.on('requestfailed', releaseRequest);

        await page.route('**/*', async (route) => {
            const request = route.request();
            const url = request.url();
            if (!isAllowedHost(url)) {
                report.policyBlockedRequestCount += 1;
                await route.abort().catch(() => {});
                return;
            }
            let verdict;
            try {
                verdict = await network.robots.check(url, { requireExplicit: true });
            } catch {
                verdict = { allowed: false, reason: 'unverified' };
            }
            if (!verdict.allowed) {
                report.policyBlockedRequestCount += 1;
                if (verdict.reason === 'blocked') report.notes.push('Sebagian request same-site diblokir robots.txt/security policy; tidak dicoba ulang.');
                await route.abort().catch(() => {});
                return;
            }
            let release;
            try {
                release = await network.requestManager.acquire(new URL(url).host, {
                    intervalMs: Math.max(SCRAPER.minIntervalMs, verdict.crawlDelayMs || 0),
                    source: 'animeindo-inspector',
                });
                if (release) activeRequests.set(request, release);
                await route.continue();
            } catch {
                if (release) releaseRequest(request);
                await route.abort().catch(() => {});
            }
        });

        const responseTasks = [];
        const seenRequests = new Map();
        page.on('request', (request) => {
            if (!['fetch', 'xhr'].includes(request.resourceType())) return;
            let url;
            try { url = new URL(request.url()); } catch { return; }
            if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return;
            const key = request.method() + ' ' + sanitizeUrl(request.url()) + ' [' + request.resourceType() + ']';
            seenRequests.set(key, (seenRequests.get(key) || 0) + 1);
        });
        page.on('response', (response) => {
            const request = response.request();
            if (!['fetch', 'xhr'].includes(request.resourceType())) return;
            let url;
            try { url = new URL(request.url()); } catch { return; }
            if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return;
            const task = (async () => {
                const headers = await response.allHeaders().catch(() => ({}));
                const contentType = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
                const item = {
                    url: sanitizeUrl(request.url()),
                    method: request.method(),
                    status: response.status(),
                    contentType: contentType || 'unknown',
                };
                if (contentType.includes('json') && response.status() >= 200 && response.status() < 400) {
                    try {
                        item.jsonShape = summarizeJson(await response.json());
                    } catch {
                        item.jsonShape = { unavailable: true };
                    }
                }
                report.network.responses.push(item);
            })();
            responseTasks.push(task);
        });

        let navigationResponse = null;
        try {
            navigationResponse = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch (error) {
            report.notes.push('Navigasi berhenti: ' + cleanVisibleText(error?.message || error).slice(0, 300));
        }
        const navigationStatus = navigationResponse?.status?.() || 0;
        const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
        let responseHeaders = {};
        try { responseHeaders = navigationResponse ? await navigationResponse.allHeaders() : {}; } catch { /* optional */ }
        const challenged = looksLikeChallenge({
            status: navigationStatus,
            headers: new Headers(responseHeaders),
            text: bodyText,
        }) || navigationStatus === 403 || navigationStatus === 429;

        if (challenged) {
            report.notes.push('HTTP 403/429 atau security challenge terdeteksi. Inspektor berhenti tanpa CAPTCHA solver, retry, atau rotasi untuk melewati blokir.');
        } else {
            const waitMs = Math.max(0, Math.min(45000, Number.parseInt(process.env.INSPECT_WAIT_MS || '12000', 10) || 0));
            console.log('Browser terbuka. Bila perlu, lakukan interaksi biasa pada halaman selama ' + Math.round(waitMs / 1000) + ' detik untuk memicu Fetch/XHR first-party.');
            if (waitMs) await page.waitForTimeout(waitMs);
        }

        await Promise.allSettled(responseTasks);
        report.page = {
            status: navigationStatus || null,
            finalUrl: sanitizeUrl(page.url()),
            challenged,
            dom: await captureDom(page).catch(() => null),
        };
        report.network.requests = [...seenRequests.entries()].slice(0, 200).map(([request, count]) => ({ request, count }));
        report.network.responses = report.network.responses.slice(0, 200);
        report.finishedAt = new Date().toISOString();
        await fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
        console.log('Laporan tersimpan: ' + outputPath);
        console.log('Request Fetch/XHR first-party: ' + report.network.requests.length);
        console.log('Respons Fetch/XHR tercatat: ' + report.network.responses.length);
        console.log('Request diblokir oleh batas host/robots: ' + report.network.policyBlockedRequestCount);
        if (challenged) process.exitCode = 2;
    } catch (error) {
        report.finishedAt = new Date().toISOString();
        report.notes.push(cleanVisibleText(error?.message || error).slice(0, 500));
        await fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8').catch(() => {});
        console.error('Inspeksi gagal: ' + report.notes[report.notes.length - 1]);
        process.exitCode = 1;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error('Inspeksi gagal: ' + cleanVisibleText(error?.message || error).slice(0, 500));
        process.exitCode = 1;
    });
}
