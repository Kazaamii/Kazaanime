/**
 * Kazanime backend — app.js
 * Membuat aplikasi Express. Dipakai oleh:
 *   - api/index.js     → Vercel Function (frontend statis dilayani CDN Vercel)
 *   - server/index.js  → server lokal (API + file frontend sekaligus)
 *   - server/test/*    → dengan registry tiruan
 *
 * Endpoint:
 *   GET /api/health                     status backend + sumber (dipakai indikator "Status API" di frontend)
 *   GET /api/bot                        info bot untuk admin situs sumber (tercantum di User-Agent)
 *   GET /api/anime/latest | /search?q= | /schedule | /:slug | /:slug/episode/:ep
 *   GET /api/stream/servers | /hls | /sub | /subai  (lihat routes/stream.js)
 */
import path from 'node:path';
import express from 'express';
import { AI_SUBS, BOT, CACHE, ROOT_DIR, SERVER, SOURCES, STREAMS } from './config.js';
import { AppError } from './lib/errors.js';
import { createClient, createNetwork } from './lib/fetcher.js';
import { createGemini } from './lib/gemini.js';
import { ipRateLimit } from './lib/rate-limit.js';
import { createSigner } from './lib/stream-proxy.js';
import { createDefaultStreamProviders } from './providers/index.js';
import { animeRouter } from './routes/anime.js';
import { streamRouter } from './routes/stream.js';
import { createDefaultRegistry } from './sources/index.js';

export const VERSION = '1.6.0';

/** Header keamanan yang sama dengan vercel.json (tanpa X-Frame-Options: lihat mountStatic). */
function securityHeaders(req, res, next) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), display-capture=()');
    next();
}

/** CORS hanya untuk origin yang didaftarkan di CORS_ORIGINS (default: hanya origin sendiri). */
function cors(origins) {
    return (req, res, next) => {
        const origin = req.headers.origin;
        if (origin && origins.includes(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.set('Access-Control-Max-Age', '600');
            res.vary('Origin');
        }
        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }
        next();
    };
}

function requestLogger(req, res, next) {
    const started = Date.now();
    res.on('finish', () => {
        // Proxy segmen video = ratusan request per episode → hanya yang gagal dicatat.
        if (req.originalUrl.startsWith('/api/stream/hls') && res.statusCode < 400) return;
        const r = res.locals.result;
        const extra = r ? ` source=${r.source}${r.fallback ? ' fallback' : ''}${r.stale ? ' stale' : ''}` : '';
        console.log(`[api] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms${extra}`);
    });
    next();
}

function botInfo(req, res) {
    const hosts = SOURCES.enabled.map((id) => SOURCES[id]?.baseUrl).filter(Boolean);
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('text/plain; charset=utf-8').send([
        `${BOT.token}/${BOT.version}`,
        '',
        'What it is: the backend of Kazanime, a small non-commercial anime/donghua fan site.',
        'What it fetches: public listing, search, series and episode pages — nothing behind logins.',
        'Politeness:',
        '  - obeys robots.txt (RFC 9309): group "KazanimeBot", otherwise "*"; honours Crawl-delay',
        '  - at most 1 request per second per host, limited retries, 6 s timeout',
        '  - responses cached 10-15 minutes (plus CDN cache), so most visits never reach your site',
        '  - never solves CAPTCHAs/challenges; a Cloudflare block makes the bot back off (3-30 minutes);',
        '    a challenge on a site where challenges are random is retried at most twice',
        '  - video segments/subtitles for the in-site player are fetched on demand per viewer (not crawling)',
        'Opt out: add these lines to your robots.txt (picked up within 6 hours):',
        '  User-agent: KazanimeBot',
        '  Disallow: /',
        BOT.contact ? `Contact: ${BOT.contact}` : 'Contact: set BOT_CONTACT on the deployment to publish an address here.',
        '',
        `Configured sources: ${hosts.join(', ') || '-'}`,
        '',
        '— Bahasa Indonesia —',
        'Bot backend Kazanime: hanya membaca halaman publik, patuh robots.txt, maks 1 request/detik per host,',
        'hasil di-cache 10–15 menit, tanpa solver CAPTCHA/challenge. Tolak bot ini lewat robots.txt di atas.',
    ].join('\n'));
}

/**
 * File frontend untuk server lokal. HANYA halaman & folder frontend yang dilayani
 * (server/, api/, package.json, node_modules, .env tidak pernah terekspos).
 * X-Frame-Options sengaja tidak dikirim di lokal supaya bisa dipratinjau dalam iframe;
 * di Vercel header itu datang dari vercel.json.
 */
function mountStatic(app) {
    const opts = { index: false, fallthrough: true, maxAge: 0, etag: true };
    app.use('/css', express.static(path.join(ROOT_DIR, 'css'), opts));
    app.use('/js', express.static(path.join(ROOT_DIR, 'js'), opts));
    const page = (file) => (req, res) => res.sendFile(path.join(ROOT_DIR, file));
    app.get('/', page('index.html'));
    for (const file of ['index.html', 'watch.html', 'search.html']) app.get(`/${file}`, page(file));
    app.get('/favicon.ico', (req, res) => res.status(204).end());
    app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('404 — halaman tidak ditemukan.'));
}

// Express mengenali error handler dari jumlah parameternya (4) — `next` wajib ada.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    const known = err instanceof AppError;
    let status = known ? err.status : Number(err?.status || err?.statusCode) || 500;
    if (status === 499) status = 503;
    if (status < 400 || status > 599) status = 500;
    if (!known || status >= 500) {
        const line = `[api] ${req.method} ${req.originalUrl} → ${status} ${err?.code || ''} ${err?.message || err}`;
        if (known) console.warn(line);
        else console.error(line, err?.stack || '');
    }
    if (res.headersSent) return;
    if (err?.retryAfter) res.set('Retry-After', String(Math.min(err.retryAfter, 3600)));
    res.set('Cache-Control', status === 404 ? 'public, max-age=60, s-maxage=300' : 'no-store');
    if (!req.path.startsWith('/api')) {
        res.status(status).type('text/plain; charset=utf-8').send(status === 404 ? '404 — halaman tidak ditemukan.' : 'Terjadi kesalahan di server.');
        return;
    }
    res.status(status).json({
        ok: false,
        error: known ? err.message : status === 400 ? 'Permintaan tidak valid.' : 'Terjadi kesalahan di server.',
        code: known ? err.code : status === 400 ? 'BAD_REQUEST' : 'INTERNAL',
        ...(known && err.details ? { details: err.details } : {}),
    });
}

/**
 * @param {{
 *   registry?: ReturnType<typeof createDefaultRegistry>,
 *   streams?: ReturnType<typeof createDefaultStreamProviders>,
 *   mediaClient?: {stream: Function},
 *   signer?: ReturnType<typeof createSigner>,
 *   gemini?: ReturnType<typeof createGemini>|null,   undefined = dibuat dari AI_SUBS (bila GEMINI_API_KEY ada); null = AI mati
 *   aiConfig?: typeof AI_SUBS,
 *   serveStatic?: boolean,
 *   rateLimitPerMinute?: number,
 *   proxyRateLimitPerMinute?: number,
 *   aiRateLimitPerMinute?: number,
 *   budgetMs?: number,
 *   log?: boolean,
 * }} [opts]
 */
export function createApp({
    registry = createDefaultRegistry(),
    streams,
    mediaClient,
    signer = createSigner(STREAMS.secret),
    gemini,
    aiConfig = AI_SUBS,
    serveStatic = false,
    rateLimitPerMinute = SERVER.rateLimitPerMinute,
    proxyRateLimitPerMinute = STREAMS.proxyRateLimitPerMinute,
    aiRateLimitPerMinute = aiConfig.rateLimitPerMinute,
    budgetMs = SERVER.requestBudgetMs,
    log = SERVER.logRequests,
} = {}) {
    const network = registry.network || createNetwork();
    const providers = streams || createDefaultStreamProviders({ network, createClient, cache: registry.cache });
    const media = mediaClient || createClient(network, {
        source: 'anizone-media',
        allowedHosts: [],
        allowedHostSuffixes: STREAMS.anizone.mediaHosts,
        robots: false,
        intervalMs: 0,
        retries: 0,
        timeoutMs: STREAMS.proxyTimeoutMs,
        // CDN media tertentu memerlukan Origin/Referer AniZone sebagaimana pemutar sumbernya; ini kebutuhan
        // protokol media, bukan penyamaran browser atau cara melewati challenge pada halaman situs.
        headers: { Referer: `${STREAMS.anizone.baseUrl}/`, Origin: STREAMS.anizone.baseUrl },
    });
    // Subtitle Indonesia (AI): klien Gemini hanya dibuat bila GEMINI_API_KEY ada (key tidak pernah keluar dari server).
    let geminiHost = '';
    try {
        geminiHost = aiConfig.enabled ? new URL(aiConfig.apiBase).hostname : '';
    } catch {
        console.warn('[ai-subtitle] GEMINI_API_BASE tidak valid — Subtitle Indonesia (AI) dimatikan.');
    }
    const ai = gemini === undefined
        ? (geminiHost
            ? createGemini({
                client: createClient(network, {
                    source: 'gemini',
                    allowedHosts: [geminiHost],
                    robots: false, // API resmi ber-key, bukan crawling
                    intervalMs: 0,
                    retries: 0,
                    timeoutMs: aiConfig.timeoutMs,
                }),
                apiKey: aiConfig.apiKey,
                apiBase: aiConfig.apiBase,
                models: aiConfig.models,
                timeoutMs: aiConfig.timeoutMs,
            })
            : null)
        : gemini;
    const streamApi = streamRouter({ providers, mediaClient: media, signer, budgetMs, ai: ai ? { gemini: ai, config: aiConfig } : null });
    if (SERVER.isVercel && !STREAMS.secretFromEnv) {
        console.warn('[streams] STREAM_SECRET belum diatur — secret proxy diturunkan dari ID deployment (lihat README).');
    }
    const app = express();
    app.disable('x-powered-by');
    // Di Vercel IP pengunjung datang lewat proxy; di server biasa header proxy tidak dipercaya.
    app.set('trust proxy', SERVER.isVercel || process.env.TRUST_PROXY === '1');

    app.use(securityHeaders);
    app.use('/api', cors(SERVER.corsOrigins));
    if (log) app.use('/api', requestLogger);

    app.get('/api/health', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({
            ok: true,
            source: 'kazanime-backend',
            data: {
                status: 'ok',
                version: VERSION,
                time: new Date().toISOString(),
                uptimeSec: Math.round(process.uptime()),
                userAgent: BOT.userAgent,
                cacheTtlSec: { latest: CACHE.latestTtlMs / 1000, search: CACHE.searchTtlMs / 1000, detail: CACHE.detailTtlMs / 1000, episode: CACHE.episodeTtlMs / 1000 },
                ...registry.health(),
                streams: providers.health(),
                aiSubtitles: streamApi.aiHealth(),
            },
        });
    });
    app.get('/api/bot', botInfo);
    app.use('/api/anime', ipRateLimit({ limit: rateLimitPerMinute }), animeRouter(registry, { budgetMs }));
    const serversLimit = ipRateLimit({ limit: rateLimitPerMinute });
    const proxyLimit = ipRateLimit({ limit: proxyRateLimitPerMinute });
    // /subai yang lolos dari cache CDN memakai kuota Gemini pemilik situs → batas per IP jauh lebih ketat.
    const aiLimit = ipRateLimit({ limit: aiRateLimitPerMinute });
    app.use(
        '/api/stream',
        (req, res, next) => {
            if (req.path === '/servers') return serversLimit(req, res, next);
            if (req.path === '/subai') return aiLimit(req, res, next);
            return proxyLimit(req, res, next);
        },
        streamApi,
    );
    app.use('/api', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.status(404).json({ ok: false, error: 'Endpoint tidak ditemukan.', code: 'NOT_FOUND' });
    });

    if (serveStatic) mountStatic(app);
    app.use(errorHandler);
    return app;
}
