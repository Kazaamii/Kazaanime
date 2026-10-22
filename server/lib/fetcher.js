/**
 * Kazanime backend — lib/fetcher.js
 * SATU-SATUNYA tempat backend melakukan request keluar. Setiap request:
 *   1. hanya ke host yang diizinkan untuk sumber itu (anti-SSRF, slug tidak bisa dipakai menembak URL lain)
 *   2. lolos circuit breaker (sumber yang baru gagal/memblokir tidak dipaksa)
 *   3. lolos robots.txt (RFC 9309) — termasuk Crawl-delay
 *   4. antre di throttle per host (jeda minimal antar-request)
 *   5. User-Agent jujur, timeout, batas ukuran respons
 *   6. retry terbatas (hanya error jaringan & HTTP 5xx), backoff + jitter
 *   7. halaman blokir/challenge Cloudflare dikenali → "blocked" → sumber diistirahatkan.
 *      Tanpa solver CAPTCHA/challenge. Sumber yang challenge-nya terbukti ACAK per request
 *      (diukur 22 Okt 2026: AniZone, ReAnime, Anichin — request yang sama berikutnya lolos)
 *      boleh mengulang maks `challengeRetries` kali dengan jeda, lalu diistirahatkan `blockedMs`.
 *
 * Sejak 22 Okt 2026 (instruksi pemilik proyek) larangan spoof header & proxy dicabut. Header
 * khusus per sumber bisa diberikan lewat opsi `headers`. Catatan pengukuran: UA browser palsu
 * justru LEBIH sering di-challenge Cloudflare daripada UA bot jujur, jadi default tetap UA jujur.
 * `stream()` dipakai proxy HLS (server/routes/stream.js) untuk meneruskan segmen video biner.
 */
import { load } from 'cheerio';
import { BOT, SCRAPER } from '../config.js';
import { SourceError } from './errors.js';
import { CircuitBreaker, HostThrottle, sleep } from './rate-limit.js';
import { RobotsGate } from './robots.js';

const CHALLENGE_RE = /Just a moment\.\.\.|Attention Required! \| Cloudflare|Sorry, you have been blocked|cf-chl-|challenge-platform|cf_chl_opt|Enable JavaScript and cookies to continue/i;

/**
 * Apakah respons adalah halaman blokir / challenge Cloudflare (bukan konten asli)?
 * @param {{status: number, headers: Headers, text: string}} res
 */
export function looksLikeChallenge({ status, headers, text }) {
    if (headers.get('cf-mitigated') === 'challenge') return true;
    if (![403, 429, 503].includes(status)) return false;
    const viaCloudflare = /cloudflare/i.test(headers.get('server') || '') || Boolean(headers.get('cf-ray'));
    return viaCloudflare && CHALLENGE_RE.test(String(text || '').slice(0, 30000));
}

/** "120" atau tanggal HTTP → detik. */
export function retryAfterSeconds(value) {
    if (!value) return 0;
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && String(n) === String(value).trim()) return Math.max(0, n);
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : 0;
}

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

/**
 * Infrastruktur bersama untuk semua klien: throttle per host, circuit breaker, robots.txt.
 * @param {{fetchImpl?: typeof fetch, userAgent?: string, token?: string, scraper?: typeof SCRAPER, now?: () => number}} [opts]
 */
export function createNetwork({ fetchImpl = globalThis.fetch, userAgent = BOT.userAgent, token = BOT.token, scraper = SCRAPER, now = Date.now } = {}) {
    const throttle = new HostThrottle({ intervalMs: scraper.minIntervalMs, maxWaitMs: scraper.maxQueueWaitMs, now });
    const circuit = new CircuitBreaker({ failures: scraper.circuit.failures, openMs: scraper.circuit.openMs, now });
    const robots = new RobotsGate({
        token,
        ttlMs: scraper.robots.ttlMs,
        errorTtlMs: scraper.robots.errorTtlMs,
        now,
        fetchRobots: async (origin, signal) => {
            const url = `${origin}/robots.txt`;
            let out = null;
            // Challenge Cloudflare yang acak juga bisa mengenai robots.txt → ulangi SEKALI sebelum
            // menyimpulkan situs memblokir (hasil "blocked" di-cache beberapa menit oleh RobotsGate).
            for (let attempt = 0; attempt < 2; attempt++) {
                if (attempt) await sleep(1200 + Math.random() * 800, signal);
                await throttle.acquire(new URL(url).host, { signal });
                const res = await fetchImpl(url, {
                    headers: { 'User-Agent': userAgent, Accept: 'text/plain,*/*;q=0.5' },
                    redirect: 'follow',
                    signal: combineSignals(scraper.robots.timeoutMs, signal),
                });
                const text = await readBody(res, scraper.robots.maxBytes, { truncate: true });
                out = { status: res.status, text, blocked: looksLikeChallenge({ status: res.status, headers: res.headers, text }) };
                if (!out.blocked) break;
            }
            return out;
        },
    });
    return { fetchImpl, userAgent, throttle, circuit, robots, scraper };
}

function robotsError(reason, source, url) {
    switch (reason) {
        case 'blocked':
            return new SourceError(`${source} memblokir akses bot (Cloudflare) — tidak diakses.`, { kind: 'blocked', source });
        case 'unreachable':
            return new SourceError(`robots.txt ${source} tidak bisa dibaca (server error) — menurut RFC 9309 dianggap melarang sementara.`, { kind: 'robots', source, retryAfter: 600 });
        case 'unverified':
            return new SourceError(`${source}: ToS belum bisa ditinjau dan robots.txt tidak tersedia — tidak diakses.`, { kind: 'policy', source });
        default:
            return new SourceError(`robots.txt ${source} melarang ${url.pathname}.`, { kind: 'robots', source });
    }
}

/**
 * Klien HTTP untuk satu sumber.
 * @param {ReturnType<typeof createNetwork>} net
 * @param {{
 *   source: string,
 *   allowedHosts: string[],
 *   robots?: boolean,                 cek robots.txt (default true; API resmi = false)
 *   requireExplicitRobots?: boolean,  ToS belum bisa ditinjau → robots.txt wajib terbaca & mengizinkan
 *   timeoutMs?: number, retries?: number, intervalMs?: number,
 *   headers?: Record<string, string>,
 *   allowedHostSuffixes?: string[],   host lain yang diizinkan bila = sufiks atau subdomain-nya (CDN media)
 *   challengeRetries?: number,        ulangi maks n kali bila kena challenge Cloudflare (default 0)
 *   blockedMs?: number,               lama sumber diistirahatkan setelah diblokir (default config)
 * }} opts
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
        challengeRetries = 0,
        blockedMs = net.scraper.circuit.blockedMs,
    } = opts;
    const suffixes = allowedHostSuffixes.map((s) => String(s).toLowerCase().replace(/^\.+/, '')).filter(Boolean);
    /** Host boleh diakses klien ini? (daftar persis + sufiks domain, mis. "xin-cdn.xyz" → "suzaku.xin-cdn.xyz") */
    const hostAllowed = (host) => {
        const h = String(host || '').toLowerCase();
        return Boolean(h) && (allowedHosts.includes(h) || suffixes.some((s) => h === s || h.endsWith(`.${s}`)));
    };

    /**
     * @param {string} url
     * @param {{signal?: AbortSignal, deadline?: number, accept?: string, method?: string, body?: string, headers?: Record<string,string>, passErrors?: boolean}} [o]
     *   passErrors: kembalikan respons HTTP ≥ 400 apa adanya (tanpa retry/circuit per status) — untuk klien API
     *   resmi yang membaca body error-nya sendiri (mis. Gemini: kuota harian vs per menit, key ditolak).
     * @returns {Promise<{status: number, url: string, text: string, headers: Headers}>}
     */
    async function request(url, { signal, deadline, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', method = 'GET', body, headers, passErrors = false } = {}) {
        let u;
        try {
            u = new URL(url);
        } catch {
            throw new SourceError('URL sumber tidak valid.', { kind: 'policy', source });
        }
        if (!/^https?:$/.test(u.protocol) || !hostAllowed(u.hostname)) {
            throw new SourceError(`Host ${u.hostname} tidak diizinkan untuk ${source}.`, { kind: 'policy', source });
        }

        const c = net.circuit.check(source);
        if (c.open) {
            throw new SourceError(`${source} sedang diistirahatkan (${c.reason || 'baru saja gagal'}), dicoba lagi ±${c.retryAfter} dtk.`, {
                kind: c.reason === 'blocked' ? 'blocked' : 'circuit', source, retryAfter: c.retryAfter,
            });
        }

        let crawlDelayMs = 0;
        if (useRobots) {
            const verdict = await net.robots.check(u.href, { signal, requireExplicit: requireExplicitRobots });
            if (!verdict.allowed) {
                if (verdict.reason === 'blocked') net.circuit.failure(source, { reason: 'blocked', immediate: true, openMs: blockedMs });
                throw robotsError(verdict.reason, source, u);
            }
            crawlDelayMs = Math.min(verdict.crawlDelayMs, net.scraper.maxCrawlDelayMs);
        }

        let lastErr = null;
        let challenges = 0;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt > 0) await sleep(400 * 2 ** (attempt - 1) + Math.random() * 200, signal);
            await net.throttle.acquire(u.host, { intervalMs: Math.max(intervalMs, crawlDelayMs), signal, source });
            const left = deadline ? deadline - Date.now() : Infinity;
            if (left < 250) throw new SourceError(`Waktu habis menunggu ${source}.`, { kind: 'timeout', source });
            const t = Math.min(timeoutMs, left);

            let res;
            let text;
            try {
                res = await net.fetchImpl(u.href, {
                    method,
                    body,
                    headers: {
                        'User-Agent': net.userAgent,
                        Accept: accept,
                        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
                        ...baseHeaders,
                        ...headers,
                    },
                    redirect: 'follow',
                    signal: combineSignals(t, signal),
                });
                const finalHost = hostOf(res.url) || u.hostname;
                if (!hostAllowed(finalHost)) {
                    await res.body?.cancel().catch(() => {});
                    throw new SourceError(`${source} mengalihkan ke host lain (${finalHost}) — tidak diikuti.`, { kind: 'policy', source });
                }
                text = await readBody(res, net.scraper.maxBodyBytes, { source });
            } catch (err) {
                if (err instanceof SourceError) throw err;
                if (signal?.aborted) throw new SourceError('Permintaan dibatalkan.', { kind: 'abort', source });
                if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
                    net.circuit.failure(source, { reason: 'timeout' });
                    throw new SourceError(`${source} terlalu lama merespons (${Math.round(t / 1000)} dtk).`, { kind: 'timeout', source });
                }
                lastErr = new SourceError(`Tidak dapat terhubung ke ${source}.`, { kind: 'network', source, cause: err });
                continue; // error jaringan → retry
            }

            if (looksLikeChallenge({ status: res.status, headers: res.headers, text })) {
                const left2 = deadline ? deadline - Date.now() : Infinity;
                if (challenges < challengeRetries && left2 > 3500) {
                    // Challenge acak (bukan blokir permanen): request berikutnya biasanya lolos.
                    challenges++;
                    attempt--; // tidak menghabiskan jatah retry error jaringan
                    await sleep(1200 + Math.random() * 1300, signal);
                    continue;
                }
                net.circuit.failure(source, { reason: 'blocked', immediate: true, openMs: blockedMs });
                throw new SourceError(`${source} memblokir akses bot (Cloudflare) — tidak dipaksa.`, { kind: 'blocked', source, httpStatus: res.status });
            }
            if (passErrors) {
                net.circuit.success(source); // server menjawab (status apa pun) → pemanggil yang menafsirkan
                return { status: res.status, url: res.url || u.href, text, headers: res.headers };
            }
            if (res.status === 404 || res.status === 410) {
                net.circuit.success(source); // server sehat, halamannya saja yang tidak ada
                throw new SourceError('Halaman tidak ditemukan di situs sumber.', { kind: 'not_found', source, httpStatus: res.status });
            }
            if (res.status === 429) {
                const ra = retryAfterSeconds(res.headers.get('retry-after')) || 60;
                net.circuit.failure(source, { reason: 'rate-limited', immediate: true, openMs: Math.min(Math.max(ra, 30), 900) * 1000 });
                throw new SourceError(`${source} meminta kita memperlambat (HTTP 429).`, { kind: 'rate_limited', source, httpStatus: 429, retryAfter: ra });
            }
            if (res.status >= 500) {
                lastErr = new SourceError(`${source} sedang gangguan (HTTP ${res.status}).`, { kind: 'http', source, httpStatus: res.status });
                continue; // 5xx → retry
            }
            if (!res.ok) {
                net.circuit.failure(source, { reason: `HTTP ${res.status}` });
                throw new SourceError(`${source} menolak permintaan (HTTP ${res.status}).`, { kind: 'http', source, httpStatus: res.status });
            }
            net.circuit.success(source);
            return { status: res.status, url: res.url || u.href, text, headers: res.headers };
        }
        net.circuit.failure(source, { reason: lastErr?.kind || 'error' });
        throw lastErr || new SourceError(`${source} gagal dihubungi.`, { kind: 'network', source });
    }

    /**
     * Teruskan respons BINER apa adanya (segmen video / key HLS) untuk proxy media.
     * Tetap: allowlist host (anti-SSRF, termasuk host akhir setelah redirect), timeout, batas ukuran.
     * Tanpa robots.txt/throttle/circuit: ini bukan crawling, melainkan 1 request per permintaan
     * pemutaran pengguna ke CDN media.
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
        if (!/^https?:$/.test(u.protocol) || !hostAllowed(u.hostname)) {
            throw new SourceError(`Host ${u.hostname} tidak diizinkan untuk ${source}.`, { kind: 'policy', source });
        }
        let res;
        try {
            res = await net.fetchImpl(u.href, {
                headers: { 'User-Agent': net.userAgent, Accept: '*/*', ...baseHeaders, ...headers },
                redirect: 'follow',
                signal: combineSignals(t, signal),
            });
        } catch (err) {
            if (signal?.aborted) throw new SourceError('Permintaan dibatalkan.', { kind: 'abort', source });
            if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
                throw new SourceError(`${source} terlalu lama merespons.`, { kind: 'timeout', source });
            }
            throw new SourceError(`Tidak dapat terhubung ke ${source}.`, { kind: 'network', source, cause: err });
        }
        const finalHost = hostOf(res.url) || u.hostname;
        if (!hostAllowed(finalHost)) {
            await res.body?.cancel().catch(() => {});
            throw new SourceError(`${source} mengalihkan ke host lain (${finalHost}) — tidak diikuti.`, { kind: 'policy', source });
        }
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
        return { status: res.status, headers: res.headers, body: res.body ? res.body.pipeThrough(limiter) : null, url: res.url || u.href };
    }

    return {
        source,
        request,
        stream,
        /** HTML → cheerio. */
        async html(url, o) {
            const res = await request(url, o);
            return { $: load(res.text), url: res.url, status: res.status };
        },
        /** JSON (API metadata). */
        async json(url, o = {}) {
            const res = await request(url, { accept: 'application/json', ...o });
            try {
                return JSON.parse(res.text);
            } catch {
                throw new SourceError(`${source} mengirim data yang bukan JSON.`, { kind: 'parse', source });
            }
        },
    };
}
