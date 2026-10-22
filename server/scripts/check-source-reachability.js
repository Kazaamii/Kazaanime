#!/usr/bin/env node
/**
 * Transparent, read-only baseline probe for the two configured upstream hosts.
 * - Fetches robots.txt once; only checks `/` if robots.txt is readable and allows it.
 * - Uses a descriptive KazanimeBot User-Agent, no browser headers/cookies/proxy.
 * - Never retries, follows redirects, solves challenges, or logs response bodies.
 * - A challenge is reported and respected; this is not an evasion test.
 */
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, STREAMS } from '../config.js';
import { looksLikeChallenge } from '../lib/fetcher.js';
import { isAllowed, parseRobots, rulesFor } from '../lib/robots.js';

export const USER_AGENT = 'KazanimeBot/1.0 (+https://github.com/Kazaamii/Kazaanime)';
const ROBOTS_MAX_BYTES = 512 * 1024;
const PAGE_SAMPLE_MAX_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CRAWL_DELAY_WAIT_MS = 30_000;

const DEFAULT_TARGETS = Object.freeze([
    { id: 'anizone', baseUrl: STREAMS.anizone.baseUrl },
    { id: 'samehadaku', baseUrl: SOURCES.samehadaku.baseUrl },
]);

async function readLimitedText(response, maxBytes) {
    if (!response.body) return { text: '', truncated: false };
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxBytes - size;
        if (value.byteLength > remaining) {
            if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)));
            await reader.cancel().catch(() => {});
            return { text: Buffer.concat(chunks).toString('utf8'), truncated: true };
        }
        chunks.push(Buffer.from(value));
        size += value.byteLength;
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
}

function outcomeFor(response, text) {
    if (looksLikeChallenge({ status: response.status, headers: response.headers, text })) return 'cloudflare_challenge';
    if (response.status >= 200 && response.status < 300) return 'reachable';
    if (response.status >= 300 && response.status < 400) return 'redirect_not_followed';
    if (response.status === 429) return 'rate_limited';
    if (response.status === 403) return 'forbidden';
    return `http_${response.status}`;
}

async function requestOnce(url, { fetchImpl, accept, maxBytes, timeoutMs }) {
    const startedAt = Date.now();
    try {
        const response = await fetchImpl(url, {
            method: 'GET',
            redirect: 'manual',
            headers: {
                'User-Agent': USER_AGENT,
                Accept: accept,
            },
            signal: AbortSignal.timeout(timeoutMs),
        });
        const { text, truncated } = await readLimitedText(response, maxBytes);
        return {
            text,
            report: {
                status: response.status,
                outcome: outcomeFor(response, text),
                cfRay: response.headers.get('cf-ray') || '',
                server: response.headers.get('server') || '',
                location: response.headers.get('location') || '',
                truncated,
                elapsedMs: Date.now() - startedAt,
            },
        };
    } catch (err) {
        return {
            text: '',
            report: {
                status: 0,
                outcome: err?.name === 'TimeoutError' ? 'timeout' : 'network_error',
                error: String(err?.message || err).slice(0, 160),
                cfRay: '',
                server: '',
                location: '',
                truncated: false,
                elapsedMs: Date.now() - startedAt,
            },
        };
    }
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/**
 * Make one standards-compliant reachability check; no retries or challenge workarounds.
 * The injectable fetch/sleep functions are only seams for deterministic local tests.
 */
export async function checkSite({
    id,
    baseUrl,
    fetchImpl = globalThis.fetch,
    timeoutMs = REQUEST_TIMEOUT_MS,
    minimumIntervalMs = 1000,
    maxCrawlDelayWaitMs = MAX_CRAWL_DELAY_WAIT_MS,
    sleepImpl = wait,
} = {}) {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password) {
        throw new TypeError(`Hanya URL HTTPS tanpa kredensial yang diterima untuk ${id || 'sumber'}.`);
    }

    const origin = base.origin;
    const robotsUrl = new URL('/robots.txt', base).href;
    const robotsResponse = await requestOnce(robotsUrl, {
        fetchImpl,
        accept: 'text/plain,*/*;q=0.5',
        maxBytes: ROBOTS_MAX_BYTES,
        timeoutMs,
    });

    const result = {
        id,
        origin,
        robots: robotsResponse.report,
        homepage: { skipped: true, reason: 'robots_not_verified' },
    };

    const robotsReport = robotsResponse.report;
    if (robotsReport.outcome !== 'reachable' || robotsReport.truncated) {
        result.homepage.reason = robotsReport.outcome === 'cloudflare_challenge'
            ? 'cloudflare_challenge_on_robots'
            : (robotsReport.truncated ? 'robots_too_large_to_verify' : 'robots_not_verified');
        return result;
    }

    const selected = rulesFor(parseRobots(robotsResponse.text), 'KazanimeBot');
    if (selected.group === 'none') {
        result.homepage.reason = 'robots_has_no_matching_group';
        return result;
    }
    if (!isAllowed(selected.rules, '/')) {
        result.homepage.reason = 'robots_disallows_homepage';
        return result;
    }

    const delayMs = Math.max(minimumIntervalMs, Math.ceil((selected.crawlDelay || 0) * 1000));
    if (delayMs > maxCrawlDelayWaitMs) {
        result.homepage.reason = 'crawl_delay_exceeds_probe_window';
        return result;
    }
    if (delayMs > 0) await sleepImpl(delayMs);

    const homepage = await requestOnce(new URL('/', base).href, {
        fetchImpl,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        maxBytes: PAGE_SAMPLE_MAX_BYTES,
        timeoutMs,
    });
    result.homepage = homepage.report;
    return result;
}

function checkLabel(value) {
    if (value?.skipped) return `SKIP (${value.reason})`;
    const ray = value?.cfRay ? ` · cf-ray ${value.cfRay}` : '';
    return `${value?.status || '-'} ${value?.outcome || 'unknown'}${ray}`;
}

function markdownSummary(results) {
    const rows = results.map((result) => (
        `| ${result.id} | ${checkLabel(result.robots)} | ${checkLabel(result.homepage)} |`
    ));
    return [
        '## Upstream reachability baseline',
        '',
        `Waktu: ${new Date().toISOString()}. User-Agent transparan: \`${USER_AGENT}\`.`,
        'Satu GET robots.txt; GET / hanya bila robots.txt terbaca dan mengizinkan. Tidak ada fingerprint browser, cookie, proxy, redirect-follow, retry, atau challenge solver. Body tidak dicatat.',
        '',
        '| Sumber | robots.txt | Homepage |',
        '|---|---|---|',
        ...rows,
        '',
    ].join('\n');
}

export async function main(targets = DEFAULT_TARGETS) {
    const results = [];
    for (const target of targets) {
        try {
            results.push(await checkSite(target));
        } catch (err) {
            results.push({
                id: target.id,
                origin: target.baseUrl,
                robots: { status: 0, outcome: 'invalid_target', error: String(err?.message || err).slice(0, 160) },
                homepage: { skipped: true, reason: 'robots_not_verified' },
            });
        }
    }

    const summary = markdownSummary(results);
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, 'utf8');
    }
    return results;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch((err) => {
        console.error('[reachability] fatal:', err?.message || err);
        process.exitCode = 1;
    });
}
