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
 *   GET /api/stream/servers?ep=&anilist=&title=&year=   (22 Okt 2026: ReAnime embed + AniZone HLS "Multi Sub")
 *   GET /api/stream/subai?…&p=N    (22 Okt 2026: "Subtitle Indonesia (AI)" — bagian ke-N, terjemahan Gemini;
 *                                  URL-nya datang dari /servers (`ai.url`, ditandatangani backend))
 *
 * Format respons (server/routes/anime.js):
 *   { ok: true,  source: 'animexin', fallback: false, stale: false, errors?: [...], data: <payload> }
 *   { ok: false, error: 'pesan', code: 'NOT_FOUND' }
 *   - fallback: true → semua scraper gagal, data dari API metadata publik (Kitsu/AniList)
 *   - slug backend menyertakan nama sumber: "animexin~soul-land-2-the-peerless-tang-clan"
 * Item anime di `data` memakai field yang sama dengan Anime (title, image, episodes, genres,
 * score, status, slug, country, ...).
 *
 * Payload episode (/api/anime/:slug/episode/:ep) yang dipakai watch.html:
 *   data: {
 *     episode: 3,
 *     servers:   [{ name: 'Dailymotion (Sub Indo)', url: 'https://.../embed/...', lang: 'id', subtitleType: 'hard' }],
 *     downloads: [{ quality: '1080p', size: '', format: 'MP4', subtitle: 'Sub Indo', links: [{ provider: 'Mediafire', url: 'https://...' }] }]
 *   }
 * URL yang bukan http(s) dibuang di sini (data hasil scraping tidak dipercaya).
 *
 * Tanpa backend (API_CONFIG.backend.enabled = false, atau situs dibuka dari hosting /
 * Live Server statis yang membalas 404 non-JSON untuk /api/...) semua fungsi langsung
 * menolak dengan ApiError kind 'disabled' — halaman tetap berjalan dengan sumber lain.
 */
import { API_CONFIG, CACHE_TTL, PLAYER } from '../config.js';
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

function call(path, opts = {}) {
    return callApi(`/api/anime${path}`, opts);
}

/** GET <baseUrl><apiPath> lewat http.js (cache, timeout, dedupe, status backend). */
function callApi(apiPath, { ttl = CACHE_TTL.browse, signal, transform } = {}) {
    if (!isBackendEnabled()) return Promise.reject(disabledError());
    const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    return fetchJSON(`${base}${apiPath}`, {
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
                ...(x.subtitleType === 'hard' || x.subtitleType === 'soft' ? { subtitleType: x.subtitleType } : {}),
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

/** URL relatif ke proxy stream milik sendiri (bukan URL luar dari data penyedia). */
const OWN_STREAM_RE = /^\/api\/stream\/(?:hls|sub)\?[A-Za-z0-9_=&%.-]{1,4000}$/;
/** URL terjemahan subtitle AI milik sendiri (ditandatangani backend). */
const AI_SUB_RE = /^\/api\/stream\/subai\?[A-Za-z0-9_=&%.-]{1,4000}$/;

/**
 * Respons /api/stream/servers → server siap pakai untuk player.
 *  - embed : iframe biasa (ReAnime/flixcloud). Beberapa mirror penyedia yang sama (HD-2, HD-1) digabung
 *            menjadi SATU server dengan `mirrors` (dicoba berurutan bila mirror pertama gagal dimuat).
 *  - hls   : player video bawaan (AniZone): `url` = proxy kita, `direct` = CDN (HLS native Safari/iOS),
 *            `subtitles` = track WebVTT hasil konversi backend.
 */
function toProviderServers(json) {
    const d = json?.data || {};
    const list = Array.isArray(d.servers) ? d.servers : [];
    const byProvider = new Map();
    for (const x of list) {
        const provider = clip(x?.provider, 20);
        if (!provider) continue;
        if (x.kind === 'hls') {
            const url = String(x.url || '');
            if (!OWN_STREAM_RE.test(url)) continue;
            const subtitles = (Array.isArray(x.subtitles) ? x.subtitles : [])
                .filter((t) => OWN_STREAM_RE.test(String(t?.url || '')))
                .slice(0, 16)
                .map((t) => ({ label: clip(t.label, 40, 'Subtitle'), lang: clip(t.lang, 12).toLowerCase(), url: t.url, default: Boolean(t.default) }));
            // Tawaran "Subtitle Indonesia (AI)" (hanya bila episode tidak punya subtitle Indonesia).
            const ai = x.ai && AI_SUB_RE.test(String(x.ai.url || ''))
                ? { url: x.ai.url, from: clip(x.ai.from, 12).toLowerCase(), sourceLabel: clip(x.ai.sourceLabel, 40), label: clip(x.ai.label, 40, 'Indonesia (AI)') }
                : null;
            if (!byProvider.has(provider)) {
                byProvider.set(provider, {
                    provider, kind: 'hls', url, direct: toHttpUrl(x.direct) || '', poster: OWN_STREAM_RE.test(String(x.poster || '')) ? x.poster : '',
                    subtitles, ai, lang: 'multi', mirrors: null,
                });
            }
            continue;
        }
        const url = toHttpUrl(x?.url);
        if (!url) continue;
        const lang = ['id', 'en', 'multi'].includes(x.lang) ? x.lang : '';
        const prev = byProvider.get(provider);
        if (prev) {
            if (prev.kind === 'embed' && !prev.mirrors.includes(url)) prev.mirrors.push(url);
        } else {
            byProvider.set(provider, { provider, kind: 'embed', url, lang, mirrors: [url] });
        }
    }
    const servers = [...byProvider.values()].map((s) => ({
        ...s,
        available: true,
        reason: '',
        origins: [originOf(s.url), ...(s.mirrors || []).map(originOf)].filter(Boolean),
    }));
    const status = d.status && typeof d.status === 'object' ? { ...d.status } : {};
    return { servers, status };
}

/**
 * Server dari penyedia berbasis id/judul (ReAnime, AniZone) untuk satu episode.
 * @param {{anilist?: number|null, ep: number, titles?: string[], year?: number|null, signal?: AbortSignal}} q
 * @returns {Promise<{servers: object[], status: Record<string, string>}>}
 */
export function getStreamServers({ anilist, ep, titles = [], year, signal } = {}) {
    const p = new URLSearchParams();
    p.set('ep', String(ep));
    if (anilist) p.set('anilist', String(anilist));
    const seen = new Set();
    for (const t of titles) {
        const v = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        const k = v.toLowerCase();
        if (v.length < 2 || seen.has(k)) continue;
        seen.add(k);
        p.append('title', v);
        if (seen.size >= 4) break;
    }
    if (year) p.set('year', String(year));
    return callApi(`/api/stream/servers?${p}`, { ttl: CACHE_TTL.search, signal, transform: toProviderServers });
}

/** Respons /api/stream/subai → bagian subtitle AI yang tervalidasi (data dari jaringan tidak dipercaya). */
function toAiPart(json) {
    const d = json?.data || {};
    const parts = Number(d.parts);
    const part = Number(d.part);
    if (!Number.isInteger(parts) || parts < 1 || parts > 99 || !Number.isInteger(part) || part < 0 || part >= parts) {
        throw new ApiError('Data subtitle AI tidak valid.', { kind: 'parse', source: 'ai-subtitle' });
    }
    const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : null);
    const ranges = (Array.isArray(d.ranges) ? d.ranges : []).slice(0, parts)
        .map((r) => (Array.isArray(r) && num(r[0]) != null && num(r[1]) != null ? [num(r[0]), num(r[1])] : null));
    if (ranges.length !== parts || ranges.includes(null)) throw new ApiError('Data subtitle AI tidak valid.', { kind: 'parse', source: 'ai-subtitle' });
    const cues = (Array.isArray(d.cues) ? d.cues : []).slice(0, 4000).map((c) => {
        if (!Array.isArray(c)) return null;
        const start = num(c[0]);
        const end = num(c[1]);
        const text = typeof c[2] === 'string' ? c[2].slice(0, 500) : '';
        if (start == null || end == null || end <= start || !text) return null;
        return { start, end, text, settings: typeof c[3] === 'string' ? c[3].slice(0, 120) : '' };
    }).filter(Boolean);
    return {
        part, parts, ranges, cues,
        label: clip(d.label, 40, 'Indonesia (AI)'),
        model: clip(d.model, 60),
        untranslated: Math.max(0, Number.parseInt(d.untranslated, 10) || 0),
    };
}

/**
 * Satu bagian "Subtitle Indonesia (AI)". Sumber kesehatan terpisah ('ai-subtitle') → kuota AI habis tidak
 * membuat backend dianggap mati. Tanpa retry otomatis di sini (diatur ui/ai-subtitle.js sesuai Retry-After).
 * @param {string} url `ai.url` dari /api/stream/servers
 * @param {number} part
 * @param {{signal?: AbortSignal}} [opts]
 */
export function getAiSubtitlePart(url, part, { signal } = {}) {
    if (!isBackendEnabled()) return Promise.reject(disabledError());
    const p = Number(part);
    if (!AI_SUB_RE.test(String(url || '')) || !Number.isInteger(p) || p < 0 || p > 99) {
        return Promise.reject(new ApiError('Tautan subtitle AI tidak valid.', { kind: 'parse', source: 'ai-subtitle' }));
    }
    const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    return fetchJSON(`${base}${url}&p=${p}`, {
        source: 'ai-subtitle',
        timeout: PLAYER.aiSubtitle?.requestTimeout || 65000,
        retries: 0,
        ttl: 6 * 3600 * 1000,
        persist: false, // bisa puluhan KB per bagian → cukup cache memori + cache HTTP browser
        signal,
        validate: unwrap,
        transform: toAiPart,
    });
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
