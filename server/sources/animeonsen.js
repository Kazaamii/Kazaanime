/**
 * Kazanime backend — sources/animeonsen.js
 * API-backed adapter for AnimeOnsen. Endpoint shapes follow the upstream extension source:
 *   https://api.animeonsen.xyz/v4/content/index
 *   https://api.animeonsen.xyz/v4/content/{id}/extensive
 *   https://api.animeonsen.xyz/v4/content/{id}/episodes
 *   https://api.animeonsen.xyz/v4/content/{id}/video/{episode}
 *   https://search.animeonsen.xyz/indexes/content/search
 * OAuth uses operator-supplied credentials only; no upstream secret is bundled here.
 *
 * Access is fail-closed: with the robots gate enabled (SCRAPER_ROBOTS_MODE=enforce/warn) every
 * site/API/auth/search/media request requires explicit robots approval; the project default is 'off'.
 * ToS status is unknown, and playback additionally requires exact operator-confirmed
 * ANIMEONSEN_MEDIA_HOSTS entries. No site endpoints are contacted by unit tests.
 */
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import { absoluteUrl, cleanText } from '../lib/text.js';

export const ID = 'animeonsen';
export const NAME = 'AnimeOnsen';
export const BASE_URL = 'https://www.animeonsen.xyz';
export const API_BASE = 'https://api.animeonsen.xyz/v4';
export const AUTH_URL = 'https://auth.animeonsen.xyz/oauth/token';
export const SEARCH_BASE = 'https://search.animeonsen.xyz';

export const POLICY = Object.freeze({
    robots: true,
    imagePolicy: 'allowed',
    tos: Object.freeze({
        url: BASE_URL,
        reviewedAt: '2026-10-22',
        verdict: 'unknown',
        note: 'ToS/access permission is unverified; all requests require an explicit robots.txt allow.',
    }),
});

const ALLOWED_API_HOSTS = Object.freeze([
    'www.animeonsen.xyz',
    'api.animeonsen.xyz',
    'auth.animeonsen.xyz',
    'search.animeonsen.xyz',
]);
const CONTENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/i;
const LANG_KEY_RE = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?$/i;
const MEDIA_FORMATS = new Set(['ass', 'ssa', 'srt', 'vtt']);
const MEDIA_VIDEO_FORMATS = new Set(['m3u8', 'mp4', 'webm']);
const LANGUAGE_NAMES = Object.freeze({ id: 'Indonesia', en: 'English', ja: 'Japanese', zh: 'Chinese', ar: 'Arabic', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ru: 'Russian' });

function validContentId(value) {
    const id = String(value ?? '').trim();
    return CONTENT_ID_RE.test(id) ? id : '';
}

function languageCode(value) {
    const raw = String(value || '').replace(/_/g, '-');
    return LANG_KEY_RE.test(raw) ? raw.toLowerCase() : '';
}

function extensionOf(value) {
    try {
        return new URL(value).pathname.split('.').pop()?.toLowerCase() || '';
    } catch {
        return '';
    }
}

function safeMediaUrl(value, hosts) {
    const raw = absoluteUrl(value);
    if (!raw) return '';
    try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        const allowed = hosts.includes(host);
        return url.protocol === 'https:' && !url.port && !url.username && !url.password && allowed ? url.href : '';
    } catch {
        return '';
    }
}

function firstTitle(item) {
    return cleanText(item?.content_title || item?.content_title_jp || item?.content_title_en);
}

function itemToAnime(item, base) {
    const id = validContentId(item?.content_id);
    const title = firstTitle(item);
    if (!id || !title) return null;
    const alt = [item.content_title_en, item.content_title_jp, item.content_title]
        .map(cleanText)
        .find((candidate) => candidate && candidate.toLowerCase() !== title.toLowerCase()) || '';
    const image = absoluteUrl(item.thumbnail || item.content_image || `${API_BASE}/image/210x300/${encodeURIComponent(id)}`, API_BASE);
    return makeAnime({
        title,
        titleAlt: alt,
        image,
        country: null,
        slug: encodeSlug(ID, id),
        source: ID,
        url: `${base}/details/${encodeURIComponent(id)}`,
    });
}

function parseEpisodeRows(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SourceError('AnimeOnsen mengirim daftar episode dengan format tidak dikenal.', { kind: 'parse', source: ID });
    }
    const entries = Object.entries(value)
        .map(([key, item]) => {
            const number = Number(key);
            if (!Number.isInteger(number) || number < 1 || number > 5000) return null;
            const name = cleanText(item?.nameJp || item?.contentTitle_episode_jp || item?.nameEn || item?.contentTitle_episode_en);
            return { number, title: name ? `Episode ${number}: ${name}` : `Episode ${number}`, url: '' };
        })
        .filter(Boolean);
    return makeEpisodeList(entries);
}

function parseVideoData(data, mediaHosts) {
    const stream = safeMediaUrl(data?.uri?.stream, mediaHosts);
    if (!stream) {
        throw new SourceError('AnimeOnsen media host tidak diizinkan; atur ANIMEONSEN_MEDIA_HOSTS setelah mengonfirmasi host resmi.', {
            kind: 'policy', source: ID,
        });
    }
    const videoFormat = extensionOf(stream);
    if (!MEDIA_VIDEO_FORMATS.has(videoFormat)) {
        throw new SourceError('Format URL video AnimeOnsen tidak dikenali; server tidak diteruskan.', { kind: 'parse', source: ID });
    }

    const labels = data?.metadata?.subtitles && typeof data.metadata.subtitles === 'object' ? data.metadata.subtitles : {};
    const subtitleUris = data?.uri?.subtitles && typeof data.uri.subtitles === 'object' ? data.uri.subtitles : {};
    const subtitles = Object.entries(subtitleUris)
        .map(([key, value]) => {
            const lang = languageCode(key);
            const url = safeMediaUrl(value, mediaHosts);
            const format = extensionOf(url);
            if (!lang || !url || !MEDIA_FORMATS.has(format)) return null;
            const baseLang = lang.split('-')[0];
            const label = cleanText(labels[key]) || LANGUAGE_NAMES[baseLang] || lang;
            return { label, lang, format, url, default: false };
        })
        .filter(Boolean)
        .sort((a, b) => {
            const rank = (lang) => (lang.split('-')[0] === 'id' ? 0 : lang.split('-')[0] === 'en' ? 1 : 2);
            return rank(a.lang) - rank(b.lang);
        })
        .slice(0, 16);
    const preferred = subtitles.find((track) => track.lang.split('-')[0] === 'id')
        || subtitles.find((track) => track.lang.split('-')[0] === 'en')
        || subtitles[0];
    if (preferred) preferred.default = true;

    return {
        kind: videoFormat === 'm3u8' ? 'hls' : 'video',
        url: stream,
        subtitles,
        hasSubtitles: subtitles.length > 0,
    };
}

/**
 * API-backed AnimeOnsen adapter.
 * @param {{network:any, createClient:Function, baseUrl?:string, sourceConfig?:object}} deps
 */
export function createAnimeOnsen({ network, createClient, baseUrl = BASE_URL, sourceConfig = {} }) {
    const base = String(baseUrl || BASE_URL).replace(/\/+$/, '');
    const clientId = String(sourceConfig.clientId || '').trim();
    const clientSecret = String(sourceConfig.clientSecret || '').trim();
    const mediaHosts = Array.isArray(sourceConfig.mediaHosts)
        ? sourceConfig.mediaHosts.map((host) => String(host).toLowerCase().replace(/^\.+/, '')).filter(Boolean)
        : [];
    const siteHeaders = { Origin: base, Referer: `${base}/` };
    const client = createClient(network, {
        source: ID,
        allowedHosts: [...ALLOWED_API_HOSTS],
        requireExplicitRobots: true,
        blockedMs: 30 * 60 * 1000,
        retries: 0,
        headers: siteHeaders,
    });

    let accessToken = '';
    let accessTokenFlight = null;
    let searchToken = '';
    let searchTokenFlight = null;

    function requireCredentials() {
        if (!clientId || !clientSecret) {
            throw new SourceError('AnimeOnsen nonaktif: isi ANIMEONSEN_CLIENT_ID dan ANIMEONSEN_CLIENT_SECRET dari kredensial yang berizin.', {
                kind: 'policy', source: ID,
            });
        }
    }

    async function getAccessToken(ctx) {
        requireCredentials();
        if (accessToken) return accessToken;
        if (!accessTokenFlight) {
            accessTokenFlight = (async () => {
                const body = new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    grant_type: 'client_credentials',
                }).toString();
                const tokenData = await client.json(AUTH_URL, {
                    ...ctx,
                    method: 'POST',
                    body,
                    headers: {
                        ...siteHeaders,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        Accept: 'application/json',
                    },
                });
                const token = String(tokenData?.access_token || '').trim();
                if (!token) throw new SourceError('AnimeOnsen tidak mengembalikan access token.', { kind: 'http', source: ID });
                accessToken = token;
                return token;
            })().finally(() => { accessTokenFlight = null; });
        }
        return accessTokenFlight;
    }

    async function apiJson(url, ctx) {
        const requestWithToken = (token) => client.json(url, {
            ...ctx,
            headers: { ...siteHeaders, Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        const token = await getAccessToken(ctx);
        try {
            return await requestWithToken(token);
        } catch (error) {
            // Match the upstream OAuth flow: refresh once for an ordinary 401, never retry blocks/challenges.
            if (error?.httpStatus !== 401) throw error;
            if (accessToken === token) accessToken = '';
            const refreshed = await getAccessToken(ctx);
            if (refreshed === token) throw error;
            return requestWithToken(refreshed);
        }
    }

    async function getSearchToken(ctx) {
        requireCredentials();
        if (searchToken) return searchToken;
        if (!searchTokenFlight) {
            searchTokenFlight = (async () => {
                const page = await client.html(base, ctx);
                const token = String(page.$('meta[name="ao-search-token"]').attr('content') || '').trim();
                if (!token) throw new SourceError('Meta token pencarian AnimeOnsen tidak ditemukan.', { kind: 'parse', source: ID });
                searchToken = token;
                return token;
            })().finally(() => { searchTokenFlight = null; });
        }
        return searchTokenFlight;
    }

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        country: null,
        policy: POLICY,
        supportsLatest: false,

        parseRef(parts) {
            const id = validContentId(parts[0]);
            return parts.length === 1 && id ? { id } : null;
        },

        titleHint(ref) {
            return `animeonsen ${ref.id}`;
        },

        async latest() {
            // Upstream marks latest updates unsupported; do not mislabel the popular index as "latest".
            return [];
        },

        async search(query, ctx = {}) {
            const token = await getSearchToken(ctx);
            const result = await client.json(`${SEARCH_BASE}/indexes/content/search`, {
                ...ctx,
                method: 'POST',
                body: JSON.stringify({ q: String(query || '') }),
                headers: {
                    ...siteHeaders,
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
            });
            if (!Array.isArray(result?.hits)) {
                throw new SourceError('Respons pencarian AnimeOnsen tidak dikenali.', { kind: 'parse', source: ID });
            }
            return result.hits.map((item) => itemToAnime(item, base)).filter(Boolean);
        },

        async getAnime(ref, ctx = {}) {
            const id = validContentId(ref.id);
            if (!id) throw notFound('ID AnimeOnsen tidak valid.', ID);
            const [detail, episodeResponse] = await Promise.all([
                apiJson(`${API_BASE}/content/${encodeURIComponent(id)}/extensive`, ctx),
                apiJson(`${API_BASE}/content/${encodeURIComponent(id)}/episodes`, ctx),
            ]);
            if (validContentId(detail?.content_id) !== id) {
                throw new SourceError('Detail AnimeOnsen tidak cocok dengan ID yang diminta.', { kind: 'parse', source: ID });
            }
            const episodeList = parseEpisodeRows(episodeResponse);
            const title = cleanText(detail.content_title || detail.content_title_en || detail.content_title_jp);
            if (!title) throw new SourceError('AnimeOnsen tidak mengirim judul anime.', { kind: 'parse', source: ID });
            const titleAlt = [detail.content_title_en, detail.content_title_jp, detail.content_title]
                .map(cleanText)
                .find((value) => value && value.toLowerCase() !== title.toLowerCase()) || '';
            const mal = detail.mal_data && typeof detail.mal_data === 'object' && !Array.isArray(detail.mal_data)
                ? detail.mal_data
                : {};
            const latestEpisode = episodeList.length ? Math.max(...episodeList.map((item) => item.number)) : null;
            const anime = makeAnime({
                title,
                titleAlt,
                image: `${API_BASE}/image/210x300/${encodeURIComponent(id)}`,
                description: cleanText(mal.synopsis || ''),
                episodes: episodeList.length || null,
                latestEpisode,
                genres: Array.isArray(mal.genres) ? mal.genres.map((genre) => genre?.name).filter(Boolean) : [],
                score: mal.mean_score,
                status: String(mal.status || '').trim() === 'finished_airing' ? 'COMPLETED' : (mal.status ? 'ONGOING' : 'UNKNOWN'),
                country: null,
                ids: { mal: detail.mal_id },
                studios: Array.isArray(mal.studios) ? mal.studios.map((studio) => studio?.name).filter(Boolean) : [],
                slug: encodeSlug(ID, id),
                source: ID,
                url: `${base}/details/${encodeURIComponent(id)}`,
            });
            return { ...anime, episodeList };
        },

        async getEpisode(ref, ep, ctx = {}) {
            const id = validContentId(ref.id);
            const entry = (ctx.anime?.episodeList || []).find((item) => item.number === ep);
            if (!id || !entry) throw notFound(`Episode ${ep} belum tersedia di ${NAME}.`, ID);
            if (!mediaHosts.length) {
                throw new SourceError('Pemutaran AnimeOnsen belum dikonfigurasi; konfirmasi CDN lalu isi ANIMEONSEN_MEDIA_HOSTS.', {
                    kind: 'policy', source: ID,
                });
            }
            const data = await apiJson(`${API_BASE}/content/${encodeURIComponent(id)}/video/${ep}`, ctx);
            if (!data?.uri || typeof data.uri !== 'object') {
                throw new SourceError('Respons video AnimeOnsen tidak dikenali.', { kind: 'parse', source: ID });
            }
            const media = parseVideoData(data, mediaHosts);
            return makeEpisode({
                episode: ep,
                title: entry.title,
                url: `${base}/details/${encodeURIComponent(id)}`,
                servers: [{
                    name: 'AnimeOnsen',
                    url: media.url,
                    kind: media.kind,
                    lang: media.hasSubtitles ? 'multi' : '',
                    ...(media.hasSubtitles ? { subtitleType: 'soft' } : {}),
                    subtitles: media.subtitles,
                }],
            });
        },
    };
}

export { parseEpisodeRows, parseVideoData, safeMediaUrl };
