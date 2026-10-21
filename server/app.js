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
 *   GET /api/anime/latest | /search?q= | /:slug | /:slug/episode/:ep
 */
import path from 'node:path';
import express from 'express';
import { BOT, CACHE, ROOT_DIR, SERVER, SOURCES } from './config.js';
import { AppError } from './lib/errors.js';
import { ipRateLimit } from './lib/rate-limit.js';
import { animeRouter } from './routes/anime.js';
import { createDefaultRegistry } from './sources/index.js';

export const VERSION = '1.4.0';

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
        '  - never solves CAPTCHAs/challenges and never disguises itself as a browser;',
        '    a Cloudflare block or challenge makes the bot back off for 30 minutes',
        'Opt out: add these lines to your robots.txt (picked up within 6 hours):',
        '  User-agent: KazanimeBot',
        '  Disallow: /',
        BOT.contact ? `Contact: ${BOT.contact}` : 'Contact: set BOT_CONTACT on the deployment to publish an address here.',
        '',
        `Configured sources: ${hosts.join(', ') || '-'}`,
        '',
        '— Bahasa Indonesia —',
        'Bot backend Kazanime: hanya membaca halaman publik, patuh robots.txt, maks 1 request/detik per host,',
        'hasil di-cache 10–15 menit, tidak pernah melewati proteksi bot. Tolak bot ini lewat robots.txt di atas.',
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
 *   serveStatic?: boolean,
 *   rateLimitPerMinute?: number,
 *   budgetMs?: number,
 *   log?: boolean,
 * }} [opts]
 */
export function createApp({
    registry = createDefaultRegistry(),
    serveStatic = false,
    rateLimitPerMinute = SERVER.rateLimitPerMinute,
    budgetMs = SERVER.requestBudgetMs,
    log = SERVER.logRequests,
} = {}) {
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
            },
        });
    });
    app.get('/api/bot', botInfo);
    app.use('/api/anime', ipRateLimit({ limit: rateLimitPerMinute }), animeRouter(registry, { budgetMs }));
    app.use('/api', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.status(404).json({ ok: false, error: 'Endpoint tidak ditemukan.', code: 'NOT_FOUND' });
    });

    if (serveStatic) mountStatic(app);
    app.use(errorHandler);
    return app;
}
