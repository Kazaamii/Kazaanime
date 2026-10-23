/**
 * Kazanime backend — config.js
 * Semua konstanta server di SATU tempat. Setiap nilai bisa di-override lewat
 * environment variable (lihat .env.example) tanpa mengubah kode.
 *
 * Kebijakan sopan-santun scraper (robots.txt, ToS, rate limit, cache, User-Agent)
 * diatur di sini + di objek `policy` milik tiap adapter (server/sources/*.js).
 */
import { createHash } from 'node:crypto';
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
    /** Retry terbatas hanya untuk gangguan jaringan dan HTTP 5xx; 403/429/challenge tidak diulang. */
    retries: int('SCRAPER_RETRIES', 1, { min: 0, max: 2 }),
    /** Jeda minimal antar-request ke host yang SAMA (ms). Crawl-delay robots.txt bisa memperbesar. */
    minIntervalMs: int('SCRAPER_MIN_INTERVAL_MS', 1000, { min: 250, max: 30000 }),
    /** Antrean ke satu host lebih lama dari ini → ditolak (503) daripada menggantung. */
    maxQueueWaitMs: 6000,
    maxCrawlDelayMs: 10000,
    /** Halaman lebih besar dari ini dianggap tidak wajar. */
    maxBodyBytes: 3 * 1024 * 1024,
    robots: Object.freeze({
        /**
         * Mode gerbang robots.txt:
         *   'enforce' — taati robots.txt sepenuhnya (perilaku lama): path terlarang tidak diminta.
         *   'warn'    — robots.txt tetap dibaca untuk diagnosis, tetapi tidak memblokir request.
         *   'off'     — robots.txt tidak diminta sama sekali; batas tetap lewat rate limit per host.
         *
         * Default proyek ini: 'off' (permintaan eksplisit pemilik proyek, 23 Okt 2026).
         * Set `SCRAPER_ROBOTS_MODE=enforce` untuk mengembalikan perilaku lama.
         * Apa pun modenya, 403/429/challenge TIDAK pernah diterobos atau diulang.
         */
        mode: (() => {
            const value = String(env.SCRAPER_ROBOTS_MODE || 'off').toLowerCase();
            return ['enforce', 'warn', 'off'].includes(value) ? value : 'off';
        })(),
        ttlMs: 6 * 3600 * 1000,
        errorTtlMs: 10 * 60 * 1000,
        timeoutMs: 5000,
        maxBytes: 512 * 1024, // RFC 9309: minimal 500 KiB harus diproses
    }),
    circuit: Object.freeze({
        failures: 2,            // gagal beruntun sebelum sumber "diistirahatkan"
        openMs: 60 * 1000,      // istirahat setelah gagal biasa
        blockedMs: 30 * 60 * 1000, // istirahat setelah diblokir (WAF/challenge) — jangan dipaksa
    }),
});

const proxyListRaw = env.SCRAPER_PROXY_URLS || env.SCRAPER_PROXY_URL
    || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || '';
const proxyRotation = String(env.SCRAPER_PROXY_ROTATION || 'round-robin').toLowerCase();
const cookieEncryptionKey = String(env.SCRAPER_COOKIE_STORE_KEY || '');

/** Runtime scraper modular; proxy/cookie secrets hanya dikonsumsi server dan tidak masuk health/log. */
export const SCRAPER_RUNTIME = Object.freeze({
    request: Object.freeze({
        maxConcurrencyPerHost: int('SCRAPER_MAX_CONCURRENCY_PER_HOST', 2, { min: 1, max: 20 }),
    }),
    proxy: Object.freeze({
        urls: Object.freeze(proxyListRaw.split(/[;,]/).map((value) => value.trim()).filter(Boolean)),
        rotation: ['round-robin', 'sticky', 'disabled'].includes(proxyRotation) ? proxyRotation : 'round-robin',
        healthCheck: bool('SCRAPER_PROXY_HEALTH_CHECK', true),
        connectTimeoutMs: int('SCRAPER_PROXY_CONNECT_TIMEOUT_MS', 2000, { min: 250, max: 30000 }),
        healthTtlMs: int('SCRAPER_PROXY_HEALTH_TTL_MS', 30000, { min: 1000, max: 600000 }),
        failureCooldownMs: int('SCRAPER_PROXY_COOLDOWN_MS', 30000, { min: 1000, max: 3600000 }),
    }),
    cookies: Object.freeze({
        enabled: bool('SCRAPER_COOKIES_ENABLED', true),
        encryptionKey: cookieEncryptionKey,
        storePath: env.SCRAPER_COOKIE_STORE_PATH
            ? path.resolve(ROOT_DIR, env.SCRAPER_COOKIE_STORE_PATH)
            : path.join(ROOT_DIR, '.scraper-data', 'cookies.enc'),
    }),
    browser: Object.freeze({
        enabled: bool('SCRAPER_BROWSER_ENABLED', true),
        settleMs: int('SCRAPER_BROWSER_SETTLE_MS', 350, { min: 0, max: 5000 }),
        executablePath: env.PLAYWRIGHT_EXECUTABLE_PATH || '',
        locale: env.SCRAPER_BROWSER_LOCALE || 'id-ID',
        timezoneId: env.SCRAPER_BROWSER_TIMEZONE || 'Asia/Jakarta',
        viewport: Object.freeze({
            width: int('SCRAPER_BROWSER_VIEWPORT_WIDTH', 1280, { min: 320, max: 3840 }),
            height: int('SCRAPER_BROWSER_VIEWPORT_HEIGHT', 800, { min: 240, max: 2160 }),
        }),
    }),
});

export const CACHE = Object.freeze({
    maxEntries: int('CACHE_MAX_ENTRIES', 500, { min: 50, max: 20000 }),
    latestTtlMs: int('CACHE_LATEST_SEC', 600, { min: 60, max: 3600 }) * 1000,   // 10 menit
    searchTtlMs: int('CACHE_SEARCH_SEC', 900, { min: 60, max: 3600 }) * 1000,   // 15 menit
    detailTtlMs: int('CACHE_DETAIL_SEC', 900, { min: 60, max: 3600 }) * 1000,   // 15 menit
    episodeTtlMs: int('CACHE_EPISODE_SEC', 900, { min: 60, max: 3600 }) * 1000, // 15 menit
    scheduleTtlMs: int('CACHE_SCHEDULE_SEC', 3600, { min: 300, max: 21600 }) * 1000, // 1 jam (jadwal jarang berubah)
    /**
     * Peta Sub Indo per episode (24 Okt 2026). Pemeriksaan menyentuh halaman episode satu per
     * satu, jadi hasilnya disimpan lebih lama daripada daftar episode biasa.
     */
    subtitleMapTtlMs: int('CACHE_SUBTITLE_MAP_SEC', 1800, { min: 300, max: 21600 }) * 1000,
    notFoundTtlMs: 5 * 60 * 1000,
    /** Bila sumber gagal, data lama (maks 1 jam) tetap dipakai & diberi tanda stale. */
    staleMs: 60 * 60 * 1000,
    metadataTtlMs: 24 * 3600 * 1000,
    metadataMissTtlMs: 6 * 3600 * 1000,
    /** Header CDN Vercel: s-maxage + stale-while-revalidate (detik). */
    cdnMaxAge: int('CDN_S_MAXAGE', 600, { min: 0, max: 86400 }),
    cdnStale: int('CDN_STALE_WHILE_REVALIDATE', 1800, { min: 0, max: 86400 }),
});

const animeOnsenClientId = String(env.ANIMEONSEN_CLIENT_ID || '').trim();
const animeOnsenClientSecret = String(env.ANIMEONSEN_CLIENT_SECRET || '').trim();
const animeOnsenMediaHosts = list('ANIMEONSEN_MEDIA_HOSTS', []).map((s) => s.toLowerCase().replace(/^\.+/, ''));
// 24 Okt 2026 (permintaan pengguna): Samehadaku, Sakunime, Otakudesu, dan Kuramanime
// dimatikan sebagai default — situsnya memblokir IP pusat data dan panel Sub Indo kini
// hanya AnimeKu + Oploverz. Adapter-nya TETAP ada; aktifkan lagi lewat SCRAPER_SOURCES
// bila akses situsnya sudah tersedia.
const defaultSources = ['animexin', 'anichin', 'anoboy', 'hianime', 'animeku', 'oploverz'];
// AnimeOnsen is opt-in: authorized runtime credentials + an operator-confirmed media allowlist.
if (animeOnsenClientId && animeOnsenClientSecret && animeOnsenMediaHosts.length) defaultSources.push('animeonsen');

export const SOURCES = Object.freeze({
    /** Urutan = prioritas. Hapus nama dari daftar untuk mematikan adapter. */
    // Anoboy/Sakunime/Kuramanime: ToS unknown → hak akses mengikuti SCRAPER_ROBOTS_MODE (default off). Kuramanime memakai satu base URL tanpa failover.
    enabled: list('SCRAPER_SOURCES', defaultSources).map((s) => s.toLowerCase()),
    animexin: Object.freeze({ baseUrl: (env.ANIMEXIN_BASE_URL || 'https://animexin.dev').replace(/\/+$/, '') }),
    // AnimeIndo opt-in only: add "animeindo" to SCRAPER_SOURCES after verifying robots.txt/terms.
    animeindo: Object.freeze({
        baseUrl: (env.ANIMEINDO_BASE_URL || 'https://animeindo.cloud').replace(/\/+$/, ''),
        renderJavaScript: bool('ANIMEINDO_RENDER_JAVASCRIPT', false),
    }),
    samehadaku: Object.freeze({
        baseUrl: (env.SAMEHADAKU_BASE_URL || 'https://v2.samehadaku.how').replace(/\/+$/, ''),
        renderJavaScript: bool('SAMEHADAKU_RENDER_JAVASCRIPT', false),
        cookiesEnabled: SCRAPER_RUNTIME.cookies.enabled && bool('SAMEHADAKU_COOKIES', true),
    }),
    anoboy: Object.freeze({ baseUrl: (env.ANOBOY_BASE_URL || 'https://anoboy.be').replace(/\/+$/, '') }),
    sakunime: Object.freeze({ baseUrl: (env.SAKUNIME_BASE_URL || 'https://sakunime.com').replace(/\/+$/, '') }),
    anichin: Object.freeze({ baseUrl: (env.ANICHIN_BASE_URL || 'https://anichin.moe').replace(/\/+$/, '') }),
    otakudesu: Object.freeze({
        baseUrl: (env.OTAKUDESU_BASE_URL || 'https://otakudesu.blog').replace(/\/+$/, ''),
        renderJavaScript: bool('OTAKUDESU_RENDER_JAVASCRIPT', false),
        cookiesEnabled: SCRAPER_RUNTIME.cookies.enabled && bool('OTAKUDESU_COOKIES', true),
    }),
    kuramanime: Object.freeze({
        baseUrl: (env.KURAMANIME_BASE_URL || 'https://v9.kuramanime.work').replace(/\/+$/, ''),
        renderJavaScript: bool('KURAMANIME_RENDER_JAVASCRIPT', false),
        cookiesEnabled: SCRAPER_RUNTIME.cookies.enabled && bool('KURAMANIME_COOKIES', true),
    }),
    hianime: Object.freeze({ baseUrl: (env.HIANIME_BASE_URL || 'https://hianime.ro').replace(/\/+$/, '') }),
    // AnimeKu: memblokir UA browser dari IP pusat data, menerima UA bot jujur (lihat adapter).
    animeku: Object.freeze({ baseUrl: (env.ANIMEKU_BASE_URL || 'https://ww2.animeku.lol').replace(/\/+$/, '') }),
    // Oploverz: WordPress tema dramastream/themesia; robots.txt mengizinkan semua.
    oploverz: Object.freeze({ baseUrl: (env.OPLOVERZ_BASE_URL || 'https://oploverz.ch').replace(/\/+$/, '') }),
    animeonsen: Object.freeze({
        baseUrl: 'https://www.animeonsen.xyz',
        // Secrets are server-only; health output and request logs never serialize this object.
        clientId: animeOnsenClientId,
        clientSecret: animeOnsenClientSecret,
        // Exact media CDN hostnames are not hard-coded; the operator must confirm and allowlist them.
        mediaHosts: Object.freeze(animeOnsenMediaHosts),
    }),
    // Kusonime hanya dipanggil dari panel download; setiap halaman wajib lolos robots gate.
    kusonimeDownloads: Object.freeze({
        enabled: bool('KUSONIME_DOWNLOADS_ENABLED', true),
        baseUrl: (env.KUSONIME_BASE_URL || 'https://kusonime.com').replace(/\/+$/, ''),
    }),
});

/**
 * Penyedia server stream berbasis id/judul (server/providers/*) — ditambahkan 22 Okt 2026:
 *   reanime : server cadangan #2 (embed flixcloud, Sub English) menggantikan MegaPlay-MAL
 *   anizone : server "Multi Sub" (HLS) yang diputar lewat proxy /api/stream/hls
 */
const STREAM_SECRET_ENV = env.STREAM_SECRET && env.STREAM_SECRET.length >= 16 ? env.STREAM_SECRET : '';
export const STREAMS = Object.freeze({
    enabled: list('STREAM_PROVIDERS', ['reanime', 'anizone']).map((s) => s.toLowerCase()),
    reanime: Object.freeze({
        baseUrl: (env.REANIME_BASE_URL || 'https://reanime.to').replace(/\/+$/, ''),
        /** Host embed yang boleh dipasang sebagai iframe dari respons API ReAnime. */
        embedHosts: list('REANIME_EMBED_HOSTS', ['flixcloud.cc']).map((s) => s.toLowerCase()),
    }),
    anizone: Object.freeze({
        baseUrl: (env.ANIZONE_BASE_URL || 'https://anizone.to').replace(/\/+$/, ''),
        /** Sufiks host CDN video/subtitle AniZone yang boleh diambil proxy (anti open-proxy/SSRF). */
        mediaHosts: list('ANIZONE_MEDIA_HOSTS', ['xin-cdn.xyz']).map((s) => s.toLowerCase()),
    }),
    /**
     * Secret HMAC untuk URL proxy. Sebaiknya diisi STREAM_SECRET (≥ 16 karakter acak) di Vercel.
     * Tanpa itu dipakai turunan dari ID project/deployment Vercel (konsisten antar-instance satu
     * deployment) — host media tetap dibatasi allowlist di atas.
     */
    secret: STREAM_SECRET_ENV || createHash('sha256').update(['kazanime-stream-v1', env.VERCEL_PROJECT_ID, env.VERCEL_DEPLOYMENT_ID || env.VERCEL_URL,
        env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean).join('|')).digest('hex'),
    secretFromEnv: Boolean(STREAM_SECRET_ENV),
    /** Rate limit request proxy (/api/stream/hls & /sub) per IP per menit. 0 = nonaktif. */
    proxyRateLimitPerMinute: int('STREAM_PROXY_RATE_LIMIT_PER_MIN', 900, { min: 0, max: 100000 }),
    proxyTimeoutMs: int('STREAM_PROXY_TIMEOUT_MS', 20000, { min: 3000, max: 28000 }),
    maxSegmentBytes: 40 * 1024 * 1024,
    // Challenge/HTTP 403/429 never trigger retries, regardless of other retry settings.
    subtitleAttempts: 1,
});

/**
 * Subtitle Indonesia (AI) — ditambahkan 22 Okt 2026 atas permintaan pemilik proyek.
 * Bila episode di player bawaan (server HLS AniZone "Multi Sub") TIDAK punya subtitle Indonesia, subtitle
 * Inggris diterjemahkan Gemini per bagian lewat GET /api/stream/subai (lihat lib/subtitle-ai.js).
 *  - API key HANYA dari env GEMINI_API_KEY di server: tidak pernah dikirim ke frontend, tidak ditulis di repo.
 *    Tanpa key → fitur mati (backend tidak menawarkan `ai`, tidak ada tombol palsu).
 *  - Hasil di-cache CDN Vercel + browser (tanpa layanan penyimpanan baru — pilihan pemilik proyek).
 *  - Model: Flash (utama) → Flash-Lite (cadangan bila kuota/overload/model tidak ada). Nama model dicek di
 *    https://ai.google.dev/gemini-api/docs/models (22 Okt 2026: gemini-3.6-flash & gemini-3.5-flash-lite
 *    stabil + punya tier gratis; gemini-3.6-flash mendukung thinking "minimal" → paling cepat untuk terjemahan).
 */
const GEMINI_KEY = String(env.GEMINI_API_KEY || '').trim();
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{1,60}$/i;
const GEMINI_MODELS = [
    env.GEMINI_MODEL || 'gemini-3.6-flash',
    ...(String(env.GEMINI_FALLBACK_MODEL || '').trim().toLowerCase() === 'none' ? [] : list('GEMINI_FALLBACK_MODEL', ['gemini-3.5-flash-lite'])),
].map((m) => String(m).trim()).filter((m, i, all) => MODEL_RE.test(m) && all.indexOf(m) === i);
export const AI_SUBS = Object.freeze({
    enabled: Boolean(GEMINI_KEY) && GEMINI_MODELS.length > 0 && bool('AI_SUBTITLES', true),
    apiKey: GEMINI_KEY,
    models: Object.freeze(GEMINI_MODELS),
    /** Bisa diarahkan ke server tiruan untuk uji lokal. */
    apiBase: (env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
    label: 'Indonesia (AI)',
    /** Satu bagian = maks. sekian baris unik / karakter → 1 request Gemini (±2 bagian per episode TV 24 menit). */
    partLines: int('AI_SUBTITLE_PART_LINES', 220, { min: 30, max: 400 }),
    partChars: int('AI_SUBTITLE_PART_CHARS', 9000, { min: 1500, max: 20000 }),
    /** Batas satu panggilan Gemini (ms); total satu request /subai dibatasi requestBudgetMs (< maxDuration Vercel 60 dtk). */
    timeoutMs: int('AI_SUBTITLE_TIMEOUT_MS', 40000, { min: 8000, max: 52000 }),
    requestBudgetMs: 55000,
    /** Rate limit per IP per menit untuk /api/stream/subai (yang lolos dari cache CDN). 0 = nonaktif. */
    rateLimitPerMinute: int('AI_SUBTITLE_RATE_LIMIT_PER_MIN', 20, { min: 0, max: 1000 }),
    /** Naikkan bila prompt / cara pembagian berubah → URL baru (cache lama di CDN/browser tidak tercampur). */
    version: 1,
});

export const METADATA = Object.freeze({
    /** Fallback ke API metadata publik bila semua scraper gagal. */
    enabled: bool('METADATA_FALLBACK', true),
    // Jikan (MyAnimeList) dihapus 22 Okt 2026 atas permintaan pemilik proyek.
    order: list('METADATA_ORDER', ['kitsu', 'anilist']).map((s) => s.toLowerCase()).filter((s) => s !== 'jikan'),
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
    anilist: Object.freeze({ baseUrl: 'https://graphql.anilist.co', minIntervalMs: 2100 }),     // batas 30 req/menit (mode terdegradasi)
});
