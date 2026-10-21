/**
 * Kazanime backend — config.js
 * Semua konstanta server di SATU tempat. Setiap nilai bisa di-override lewat
 * environment variable (lihat .env.example) tanpa mengubah kode.
 *
 * Kebijakan sopan-santun scraper (robots.txt, ToS, rate limit, cache, User-Agent)
 * diatur di sini + di objek `policy` milik tiap adapter (server/sources/*.js).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

/** Angka bulat dari env dengan batas aman. */
function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const n = Number.parseInt(env[name] ?? '', 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Daftar dipisah koma dari env. */
function list(name, fallback) {
    if (!env[name]) return fallback;
    return env[name].split(',').map((s) => s.trim()).filter(Boolean);
}

function bool(name, fallback) {
    if (env[name] == null || env[name] === '') return fallback;
    return /^(1|true|yes|on)$/i.test(env[name]);
}

/** Folder proyek (tempat index.html, css/, js/). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SERVER = Object.freeze({
    port: int('PORT', 3000, { min: 1, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    isVercel: Boolean(env.VERCEL),
    /** Origin lain yang boleh memanggil API (mis. Live Server di :5500). Default: hanya origin sendiri. */
    corsOrigins: list('CORS_ORIGINS', []),
    /** Batas waktu total satu request API (ms). Frontend menunggu maks 12 dtk, jadi < 12000. */
    requestBudgetMs: int('REQUEST_BUDGET_MS', 10000, { min: 2000, max: 11000 }),
    /** Rate limit request MASUK per IP per menit untuk /api/anime/*. 0 = nonaktif. */
    rateLimitPerMinute: int('RATE_LIMIT_PER_MIN', 60, { min: 0, max: 100000 }),
    logRequests: bool('LOG_REQUESTS', true),
});

/** URL publik situs (dipakai di User-Agent & Referer ke API metadata). */
const SITE_URL = (env.PUBLIC_SITE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')).replace(/\/+$/, '');
const BOT_INFO_URL = env.BOT_INFO_URL || (SITE_URL ? `${SITE_URL}/api/bot` : '');
const BOT_CONTACT = env.BOT_CONTACT || '';

export const BOT = Object.freeze({
    /** Product token yang dicocokkan dengan baris "User-agent:" di robots.txt. */
    token: 'KazanimeBot',
    version: '1.0',
    infoUrl: BOT_INFO_URL,
    contact: BOT_CONTACT,
    siteUrl: SITE_URL,
    /** User-Agent jujur: nama bot + halaman info/kontak. Tidak pernah menyamar jadi browser. */
    userAgent: env.SCRAPER_USER_AGENT
        || `KazanimeBot/1.0 (${[BOT_INFO_URL ? `+${BOT_INFO_URL}` : 'local development', BOT_CONTACT].filter(Boolean).join('; ')})`,
});

export const SCRAPER = Object.freeze({
    /** Timeout per request ke situs sumber (ms). */
    timeoutMs: int('SCRAPER_TIMEOUT_MS', 6000, { min: 1000, max: 20000 }),
    /** Retry terbatas: hanya untuk error jaringan & HTTP 5xx (bukan 4xx, bukan timeout). */
    retries: int('SCRAPER_RETRIES', 1, { min: 0, max: 2 }),
    /** Jeda minimal antar-request ke host yang SAMA (ms). Crawl-delay robots.txt bisa memperbesar. */
    minIntervalMs: int('SCRAPER_MIN_INTERVAL_MS', 1000, { min: 250, max: 30000 }),
    /** Antrean ke satu host lebih lama dari ini → ditolak (503) daripada menggantung. */
    maxQueueWaitMs: 6000,
    maxCrawlDelayMs: 10000,
    /** Halaman lebih besar dari ini dianggap tidak wajar. */
    maxBodyBytes: 3 * 1024 * 1024,
    robots: Object.freeze({
        ttlMs: 6 * 3600 * 1000,
        errorTtlMs: 10 * 60 * 1000,
        timeoutMs: 5000,
        maxBytes: 512 * 1024, // RFC 9309: minimal 500 KiB harus diproses
    }),
    circuit: Object.freeze({
        failures: 2,            // gagal beruntun sebelum sumber "diistirahatkan"
        openMs: 60 * 1000,      // istirahat setelah gagal biasa
        blockedMs: 30 * 60 * 1000, // istirahat setelah diblokir (Cloudflare/WAF) — jangan dipaksa
    }),
});

export const CACHE = Object.freeze({
    maxEntries: int('CACHE_MAX_ENTRIES', 500, { min: 50, max: 20000 }),
    latestTtlMs: int('CACHE_LATEST_SEC', 600, { min: 60, max: 3600 }) * 1000,   // 10 menit
    searchTtlMs: int('CACHE_SEARCH_SEC', 900, { min: 60, max: 3600 }) * 1000,   // 15 menit
    detailTtlMs: int('CACHE_DETAIL_SEC', 900, { min: 60, max: 3600 }) * 1000,   // 15 menit
    episodeTtlMs: int('CACHE_EPISODE_SEC', 900, { min: 60, max: 3600 }) * 1000, // 15 menit
    scheduleTtlMs: int('CACHE_SCHEDULE_SEC', 3600, { min: 300, max: 21600 }) * 1000, // 1 jam (jadwal jarang berubah)
    notFoundTtlMs: 5 * 60 * 1000,
    /** Bila sumber gagal, data lama (maks 1 jam) tetap dipakai & diberi tanda stale. */
    staleMs: 60 * 60 * 1000,
    metadataTtlMs: 24 * 3600 * 1000,
    metadataMissTtlMs: 6 * 3600 * 1000,
    /** Header CDN Vercel: s-maxage + stale-while-revalidate (detik). */
    cdnMaxAge: int('CDN_S_MAXAGE', 600, { min: 0, max: 86400 }),
    cdnStale: int('CDN_STALE_WHILE_REVALIDATE', 1800, { min: 0, max: 86400 }),
});

export const SOURCES = Object.freeze({
    /** Urutan = prioritas. Hapus nama dari daftar untuk mematikan adapter. */
    // animexin = donghua (Sub Indo/English) · samehadaku = anime Jepang (Sub Indo), pengganti Kuramanime
    // yang memblokir bot ini lewat Cloudflare (lihat README).
    enabled: list('SCRAPER_SOURCES', ['animexin', 'samehadaku']).map((s) => s.toLowerCase()),
    animexin: Object.freeze({ baseUrl: (env.ANIMEXIN_BASE_URL || 'https://animexin.dev').replace(/\/+$/, '') }),
    samehadaku: Object.freeze({ baseUrl: (env.SAMEHADAKU_BASE_URL || 'https://v2.samehadaku.how').replace(/\/+$/, '') }),
});

export const METADATA = Object.freeze({
    /** Fallback ke API metadata publik bila semua scraper gagal. */
    enabled: bool('METADATA_FALLBACK', true),
    order: list('METADATA_ORDER', ['kitsu', 'jikan', 'anilist']).map((s) => s.toLowerCase()),
    timeoutMs: int('METADATA_TIMEOUT_MS', 6000, { min: 1000, max: 15000 }),
    /** Ganti gambar yang dilindungi hotlink (mis. animexin) dengan poster dari Kitsu. */
    enrichImages: bool('METADATA_ENRICH_IMAGES', true),
    enrichBudgetMs: 2500,
    enrichConcurrency: 4,
    /** Sumber poster pengganti (urut): kitsu, bangumi (judul Mandarin), mangabaka (cover manhua). */
    posterSources: list('METADATA_POSTER_SOURCES', ['kitsu', 'bangumi', 'mangabaka']).map((s) => s.toLowerCase()),
    kitsu: Object.freeze({ baseUrl: 'https://kitsu.app/api/edge', minIntervalMs: 200 }),
    bangumi: Object.freeze({ baseUrl: 'https://api.bgm.tv', minIntervalMs: 500 }),
    mangabaka: Object.freeze({ baseUrl: 'https://api.mangabaka.org/v1', minIntervalMs: 500 }),
    jikan: Object.freeze({ baseUrl: 'https://api.jikan.moe/v4', minIntervalMs: 400 }),           // batas resmi 3 req/dtk
    anilist: Object.freeze({ baseUrl: 'https://graphql.anilist.co', minIntervalMs: 2100 }),     // batas 30 req/menit (mode terdegradasi)
});
