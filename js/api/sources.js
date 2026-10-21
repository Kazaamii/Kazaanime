/**
 * Kazanime — api/sources.js
 * Klien untuk BACKEND SCRAPER milik sendiri (server/ — aktif mulai Tahap D).
 *
 * Kenapa lewat backend? Situs sumber (animexin, samehadaku) tidak mengizinkan
 * CORS dan dilindungi Cloudflare, jadi browser tidak bisa (dan tidak boleh)
 * mengambil halamannya langsung. Frontend HANYA memanggil endpoint ini
 * (+ /api/health untuk indikator status):
 *
 *   GET /api/anime/latest
 *   GET /api/anime/search?q=
 *   GET /api/anime/schedule        (jadwal rilis per hari — ditambahkan 22 Okt 2026)
 *   GET /api/anime/:slug
 *   GET /api/anime/:slug/episode/:ep
 *
 * Format respons (server/routes/anime.js):
 *   { ok: true,  source: 'animexin', fallback: false, stale: false, errors?: [...], data: <payload> }
 *   { ok: false, error: 'pesan', code: 'NOT_FOUND' }
 *   - fallback: true → semua scraper gagal, data dari API metadata publik (Kitsu/Jikan/AniList)
 *   - slug backend menyertakan nama sumber: "animexin~soul-land-2-the-peerless-tang-clan"
 * Item anime di `data` memakai field yang sama dengan Anime (title, image, episodes, genres,
 * score, status, slug, country, ...).
 *
 * Payload episode (/api/anime/:slug/episode/:ep) yang dipakai watch.html:
 *   data: {
 *     episode: 3,
 *     servers:   [{ name: 'Dailymotion (Sub Indo)', url: 'https://.../embed/...', lang: 'id' }],
 *     downloads: [{ quality: '1080p', size: '', format: 'MP4', subtitle: 'Sub Indo', links: [{ provider: 'Mediafire', url: 'https://...' }] }]
 *   }
 * URL yang bukan http(s) dibuang di sini (data hasil scraping tidak dipercaya).
 *
 * Tanpa backend (API_CONFIG.backend.enabled = false, atau situs dibuka dari hosting /
 * Live Server statis yang membalas 404 non-JSON untuk /api/...) semua fungsi langsung
 * menolak dengan ApiError kind 'disabled' — halaman tetap berjalan dengan sumber lain.
 */
import { API_CONFIG, CACHE_TTL } from '../config.js';
import { fetchJSON, ApiError } from './http.js';
import { createAnime, originOf, toHttpUrl } from './normalize.js';

const cfg = API_CONFIG.backend;

/** true setelah terbukti tidak ada backend di origin ini (berlaku sampai halaman dimuat ulang). */
let absent = false;

export const isBackendEnabled = () => Boolean(cfg.enabled) && !absent;

const disabledError = () => new ApiError(
    absent
        ? 'Backend tidak berjalan di server ini — jalankan "npm run dev" (lihat README).'
        : 'Backend scraper dinonaktifkan di config.js.',
    { kind: 'disabled', source: 'backend' },
);

/** 404 yang BUKAN dari API Kazanime (body bukan JSON) → tandai backend tidak ada. */
function noteAbsent(err) {
    if (err instanceof ApiError && err.kind === 'http' && err.status === 404 && !err.payload) {
        if (!absent) console.info('[backend] /api tidak ditemukan di origin ini — fitur backend dimatikan untuk halaman ini.');
        absent = true;
        return disabledError();
    }
    return err;
}

/** Item dari backend → Anime (source = 'backend:<nama-situs>'). */
export function fromBackend(item, fallbackSource = 'backend') {
    if (!item || !item.title) return null;
    const site = String(item.source || fallbackSource).replace(/^backend:/, '');
    return createAnime({ ...item, ids: item.ids || {}, source: `backend:${site}` });
}

function unwrap(json) {
    if (!json || json.ok === false) {
        throw new ApiError(json?.error || 'Backend mengembalikan error.', { kind: 'http', status: 502, source: 'backend' });
    }
    return json;
}

function call(path, { ttl = CACHE_TTL.browse, signal, transform } = {}) {
    if (!isBackendEnabled()) return Promise.reject(disabledError());
    const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    return fetchJSON(`${base}/api/anime${path}`, {
        source: 'backend',
        ttl,
        signal,
        timeout: cfg.timeout,
        validate: unwrap,
        transform,
    }).catch((err) => {
        throw noteAbsent(err);
    });
}

const toList = (json) => ({
    items: (Array.isArray(json.data) ? json.data : []).map((x) => fromBackend(x, json.source)).filter(Boolean),
    source: json.source || 'backend',
    /** true = data dari API metadata (semua scraper gagal), bukan dari situs sumber. */
    fallback: Boolean(json.fallback),
});

/** Rilis terbaru dari situs sumber → { items, source, fallback }. */
export function getLatest({ signal } = {}) {
    return call('/latest', { signal, transform: toList });
}

/** Cari judul di situs sumber → { items, source, fallback }. */
export function searchBackend(q, { signal } = {}) {
    return call(`/search?q=${encodeURIComponent(q)}`, { ttl: CACHE_TTL.search, signal, transform: toList });
}

/** Detail anime dari situs sumber → { anime: Anime } (dipakai watch.html bila ada slug). */
export function getBackendAnime(slug, { signal } = {}) {
    return call(`/${encodeURIComponent(slug)}`, {
        signal,
        transform: (json) => {
            const anime = fromBackend({ slug, ...(json.data || {}) }, json.source);
            return anime ? { anime, fallback: Boolean(json.fallback) } : null;
        },
    });
}

const clip = (v, max, fallback = '') => String(v ?? '').trim().slice(0, max) || fallback;

/** Payload episode backend → { servers: StreamServer[], downloads: DownloadGroup[], source }. */
function toEpisodeMedia(json) {
    const d = json.data || {};
    const site = clip(json.source || d.source, 40, 'backend').replace(/^backend:/, '');
    const servers = (Array.isArray(d.servers) ? d.servers : [])
        .map((x, i) => {
            const url = toHttpUrl(x?.url);
            if (!url) return null;
            return {
                id: `backend-${site}-${i}`,
                name: clip(x.name, 40, `Server ${i + 1}`),
                flag: '🌐',
                description: `Server dari ${site}`,
                badge: site,
                url,
                available: true,
                reason: '',
                source: `backend:${site}`,
                lang: ['id', 'en', 'multi'].includes(x.lang) ? x.lang : '',
                origins: [originOf(url)].filter(Boolean),
            };
        })
        .filter(Boolean);
    const downloads = (Array.isArray(d.downloads) ? d.downloads : [])
        .map((g) => ({
            quality: clip(g?.quality, 12, 'SD'),
            size: clip(g?.size, 20),
            format: clip(g?.format, 8),
            subtitle: clip(g?.subtitle, 20),
            links: (Array.isArray(g?.links) ? g.links : [])
                .map((l) => ({ provider: clip(l?.provider, 30, 'Link'), url: toHttpUrl(l?.url) }))
                .filter((l) => l.url)
                .slice(0, 12),
        }))
        .filter((g) => g.links.length);
    return { servers, downloads, source: site };
}

/**
 * Server embed & link download satu episode.
 * @returns {Promise<{servers: object[], downloads: {quality:string,size:string,format:string,subtitle:string,links:{provider:string,url:string}[]}[], source: string}>}
 */
export function getBackendEpisode(slug, ep, { signal } = {}) {
    return call(`/${encodeURIComponent(slug)}/episode/${encodeURIComponent(ep)}`, { ttl: CACHE_TTL.search, signal, transform: toEpisodeMedia });
}

const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Slug backend yang sah: "<sumber>~<bagian>" (sama dengan pola yang diterima routes.parseWatchParams). */
const BACKEND_SLUG_RE = /^[a-z0-9-]{2,30}~[a-zA-Z0-9._~-]{1,150}$/;

/**
 * Jadwal rilis mingguan dari backend: Samehadaku (jam rilis Sub Indo, WIB) + AnimeXin (hari rilis
 * donghua, tanpa jam). Item membawa Anime dengan slug → bisa langsung diputar dari situs sumber.
 * @returns {Promise<{days: Record<number, {time: string|null, title: string, anime: import('./normalize.js').Anime}[]>, source: string}>}
 */
export function getSchedule({ signal } = {}) {
    return call('/schedule', {
        ttl: CACHE_TTL.schedule,
        signal,
        transform: (json) => {
            const days = {};
            const raw = json?.data?.days && typeof json.data.days === 'object' ? json.data.days : {};
            for (const [day, items] of Object.entries(raw)) {
                const d = Number(day);
                if (!Number.isInteger(d) || d < 0 || d > 6 || !Array.isArray(items)) continue;
                days[d] = items.slice(0, 40).map((it) => {
                    if (!BACKEND_SLUG_RE.test(String(it?.slug || ''))) return null; // data scraping tidak dipercaya
                    const anime = fromBackend({ title: it.title, slug: it.slug, image: toHttpUrl(it.image) || null, country: it.country, source: it.source }, json.source);
                    if (!anime) return null;
                    return { time: CLOCK_RE.test(String(it.time || '')) ? it.time : null, title: anime.title, anime };
                }).filter(Boolean);
            }
            return { days, source: json.source || 'backend' };
        },
    });
}

/** Cek status backend (/api/health) — hanya jika diaktifkan. */
export function ping() {
    if (!isBackendEnabled()) return Promise.resolve(false);
    const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    return fetchJSON(`${base}/api/health`, { source: 'backend', timeout: 6000, force: true, transform: () => true })
        .catch((err) => {
            throw noteAbsent(err);
        });
}
