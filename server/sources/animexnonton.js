/**
 * Kazanime backend — sources/animexnonton.js
 * Adapter "Anime X Nonton" (API JSON, bukan HTML) — sumber anime yang dipakai aplikasi
 * Android Miku Moe 3.6 (`miku.moe.app`).
 *
 * Bentuk API (dibaca dari annotation Retrofit di APK, lihat docs/ANIMEXNONTON.md):
 *   POST {base}/new_api/get_posts/                     page, count, isAPKvalid
 *   POST {base}/new_api/search_category_collection/    isAPKvalid, search, page, count, lang
 *   POST {base}/new_api/get_anime_genre_list/          isAPKvalid
 *   POST {base}/new_api/get_anime_by_genre/            isAPKvalid, genre1, genre2, page, count, lang, sort
 *   POST {base}/new_api/get_category_ongoing/          page, count, lang, isAPKvalid
 *   POST {base}/new_api/get_category_not_ongoing/      page, count, lang, isAPKvalid
 *   POST {base}/new_api/get_post_description/          channel_id, isAPKvalid, gone, category_id
 * Respons: { status, count, countTotal, pages, posts: ApiAnimePost[], categories: [] }
 *
 * ⚠️  MENGAPA ADA DUA MODE
 * API ini tidak bisa dipanggil klien luar:
 *   - nginx membalas 403 untuk GET dan untuk header yang tidak membawa tanda tangan;
 *   - PHP membalas {"status":"error","message":"app only"} bila tanda tangan AnxGuard tidak sah;
 *   - tanda tangan dihitung di kode native (libmikumoe.so) dengan string kanonik yang belum
 *     berhasil direkonstruksi utuh (lihat lib/anx-signer.js).
 * Jadi adapter ini punya dua mode, diatur ANX_MODE:
 *   off      (default) — adapter tidak mendaftar, situs tidak berubah sama sekali.
 *   capture  — membaca snapshot JSON hasil tangkapan mitmproxy/Frida dari perangkat sendiri
 *              (ANX_CAPTURE_FILE). Bekerja hari ini, tanpa menyentuh server orang lain.
 *   live     — memanggil API langsung; butuh ANX_CANONICAL_TEMPLATE + IP yang diizinkan server.
 *
 * Tidak ada penyamaran, tidak ada retry saat 403/429, tidak ada solver challenge —
 * mengikuti aturan yang sama dengan adapter lain di repo ini.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeAnime, makeEpisode, makeEpisodeList } from '../lib/anime.js';
import { SourceError, notFound } from '../lib/errors.js';
import { encodeSlug } from '../lib/slug.js';
import { cleanText, clip } from '../lib/text.js';
import {
    ANX, deriveKeys, encryptBody, liveReady, renderCanonical, resolveCert,
    sha256Hex, signCanonical, urlSafeNoPad,
} from '../lib/anx-signer.js';

export const ID = 'animexnonton';
export const NAME = 'Anime X Nonton';

export const POLICY = Object.freeze({
    // Bukan crawling HTML: ini API JSON milik pihak lain. robots.txt tidak berlaku untuk API,
    // tetapi tetap tidak ada penyamaran UA atau penembusan proteksi.
    robots: false,
    imagePolicy: 'unknown',
    tos: Object.freeze({
        url: null,
        reviewedAt: '2026-10-24',
        verdict: 'unknown',
        note: 'API aplikasi pihak ketiga (Miku Moe / AnimeXNonton). Proteksi tanda tangan AnxGuard membuat '
            + 'klien luar ditolak (nginx 403 / {"status":"error","message":"app only"}). Adapter ini hanya '
            + 'dipakai dengan snapshot hasil tangkapan perangkat sendiri atau bila pemilik API memberi izin.',
    }),
});

/** Slug ref: id angka stabil dari API (cid/categoryId). */
const REF_RE = /^\d{1,10}$/;

/** ApiAnimePost → makeAnime (lihat docs/ANIMEXNONTON.md §model data). */
function toAnime(post, base) {
    const title = cleanText(post.channelName || post.categoryName || post.title || '');
    if (!title) return null;
    const id = Number(post.cid ?? post.categoryId ?? post.channelId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const episodes = Number.parseInt(String(post.countAnime ?? ''), 10);
    return makeAnime({
        title,
        titleAlt: cleanText(post.channelType || ''),
        image: post.imgUrl || post.channelImage || post.categoryImage || '',
        description: cleanText(post.delayReason || ''),
        episodes: Number.isFinite(episodes) && episodes > 0 ? episodes : null,
        latestEpisode: Number.isFinite(episodes) && episodes > 0 ? episodes : null,
        genres: String(post.genre || '').split(/[,|]/).map((g) => g.trim()).filter(Boolean),
        // rating API berupa string ("8.5"); makeAnime menerima angka 0–10.
        score: Number.parseFloat(String(post.rating ?? '').replace(',', '.')),
        status: Number(post.ongoing) === 1 ? 'ONGOING' : Number(post.ongoing) === 0 ? 'COMPLETED' : 'UNKNOWN',
        format: /movie|film/i.test(String(post.channelType || '')) ? 'MOVIE' : 'TV',
        year: Number.parseInt(String(post.years ?? ''), 10),
        country: 'JP',
        slug: encodeSlug(ID, String(id)),
        source: ID,
        // API aplikasi tidak punya halaman web publik per judul (animexnonton.com hanya
        // halaman marketing Play Store), jadi atribusi memakai base API apa adanya.
        url: '',
    });
}

/** Muat snapshot tangkapan (lihat docs untuk bentuk berkasnya). */
async function loadCapture(file) {
    try {
        const raw = await readFile(file, 'utf8');
        const data = JSON.parse(raw);
        return {
            posts: Array.isArray(data.posts) ? data.posts : [],
            genres: Array.isArray(data.genres) ? data.genres : [],
            episodes: data.episodes && typeof data.episodes === 'object' ? data.episodes : {},
            capturedAt: data.capturedAt || null,
        };
    } catch (err) {
        throw new SourceError(
            `Snapshot API Anime X Nonton tidak terbaca (${path.basename(file)}): ${err.code || err.message}. `
            + 'Setel ANX_CAPTURE_FILE ke hasil tangkapan mitmproxy/Frida.',
            { kind: 'config', source: ID },
        );
    }
}

/** Mode yang dikenal. Mode lain diperlakukan sebagai `off` (fail closed). */
export const MODES = Object.freeze(['off', 'capture', 'live']);

/**
 * @param {{network?:any, createClient?:Function, baseUrl?:string, sourceConfig?:object}} deps
 * @returns {object|null} `null` bila mode `off` — registry membuang adapter, sehingga
 *   /api/health, pencarian, dan ?source=animexnonton tidak berubah sama sekali.
 */
export function createAnimeXnonton({ network, createClient, baseUrl = ANX.baseDefault, sourceConfig = {} } = {}) {
    const base = String(baseUrl || ANX.baseDefault).replace(/\/+$/, '');
    const host = (() => { try { return new URL(base).host; } catch { return 'api.wincamp.web.id'; } })();

    /** Mode yang benar-benar dipakai: dari config (env) atau 'off'. */
    const requested = String(sourceConfig.mode || process.env.ANX_MODE || 'off').trim().toLowerCase();
    const mode = MODES.includes(requested) ? requested : 'off';
    if (requested && !MODES.includes(requested)) {
        console.warn(`[sources] ANX_MODE=${requested} tidak dikenal — adapter animexnonton dimatikan (pilihan: ${MODES.join('|')}).`);
    }
    // `off` = adapter tidak mendaftar sama sekali. Bukan sekadar "tidak dipanggil".
    if (mode === 'off') return null;

    const captureFile = sourceConfig.captureFile || process.env.ANX_CAPTURE_FILE || '';
    const canonicalTemplate = sourceConfig.canonicalTemplate || process.env.ANX_CANONICAL_TEMPLATE || '';

    // Client hanya dibuat bila memang akan memanggil jaringan (mode live). `network` wajib
    // diteruskan: tanpa itu createClient() tidak punya throttle/robots/circuit milik repo.
    const client = mode === 'live' && network && typeof createClient === 'function'
        ? createClient(network, { source: ID, allowedHosts: [host], requireExplicitRobots: false, cookies: false })
        : null;

    let snapshot = null;
    async function snapshotOnce() {
        if (snapshot) return snapshot;
        if (!captureFile) {
            throw new SourceError(
                'ANX_CAPTURE_FILE belum diatur. Mode "capture" membutuhkan berkas snapshot JSON '
                + '(hasil mitmproxy/Frida dari perangkat sendiri).',
                { kind: 'config', source: ID },
            );
        }
        snapshot = await loadCapture(captureFile);
        return snapshot;
    }

    /**
     * Panggilan API langsung (mode live). Menolak jalan bila logika tanda tangan belum lengkap,
     * supaya tidak mengirim request yang pasti ditolak ke server pihak lain.
     */
    async function callLive(endpoint, fields = {}) {
        if (!liveReady(canonicalTemplate)) {
            throw new SourceError(
                'API Anime X Nonton memakai tanda tangan AnxGuard yang belum bisa direkonstruksi penuh '
                + '(string kanonik + IV AES-GCM). Setel ANX_CANONICAL_TEMPLATE bila sudah punya, '
                + 'atau pakai ANX_MODE=capture.',
                { kind: 'config', source: ID },
            );
        }
        if (!client) throw new SourceError('HTTP client tidak tersedia.', { kind: 'config', source: ID });

        const keys = deriveKeys();
        const ts = Date.now();
        const nonce = urlSafeNoPad(randomBytes(16));
        const form = new URLSearchParams({ ...fields, isAPKvalid: ANX.ver }).toString();
        const { body } = encryptBody(keys.masterKey, form, ts);
        const canonical = renderCanonical(canonicalTemplate, {
            method: 'POST',
            path: `/new_api/${endpoint}/`,
            bodyHash: sha256Hex(Buffer.from(form, 'utf8')),
            ts,
            nonce,
            ver: ANX.ver,
        });
        // Nilai cert-lock: ANX_CERT (bila diisi) atau konstanta build. Sengaja TIDAK mengambil
        // dari pastebin aplikasi — satu-satunya jalan keluar tetap client repo di atas.
        const cert = resolveCert(sourceConfig.cert || process.env.ANX_CERT);
        // client.request() milik repo ini (lib/fetcher.js) — bukan fetch biasa:
        // sudah membawa UA bot jujur, batas 1 req/detik/host, dan tidak me-retry 403/429.
        const res = await client.request(`${base}/new_api/${endpoint}/`, {
            method: 'POST',
            body,
            accept: 'application/json',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Anx-Ts': String(ts),
                'X-Anx-N': nonce,
                'X-Anx-Ver': ANX.ver,
                'X-Anx-Cert': cert,
                'X-Anx-Rsp': '1',
                'X-Anx-Sig': signCanonical(keys.sigKey, canonical),
            },
        });
        try {
            return JSON.parse(res.text);
        } catch {
            throw new SourceError('Respons Anime X Nonton bukan JSON.', { kind: 'parse', source: ID });
        }
    }

    /**
     * Daftar post: dari API live (mode `live`) atau dari snapshot tangkapan (mode `capture`).
     * Bentuk respons API: { status, count, countTotal, pages, posts: ApiAnimePost[] }.
     */
    async function postsFrom(endpoint, fields) {
        if (mode === 'live') {
            const res = await callLive(endpoint, fields);
            const posts = Array.isArray(res?.posts) ? res.posts
                : Array.isArray(res?.data?.posts) ? res.data.posts : [];
            return { posts, live: true };
        }
        const snap = await snapshotOnce();
        return { posts: snap.posts, live: false };
    }

    /**
     * Detail judul & daftar server hanya bisa dibaca dari snapshot. Mode `live` belum
     * punya kontrak respons untuk `get_post_description` / episode, jadi ditolak dengan
     * pesan jelas alih-alih mengirim request yang pasti gagal.
     * @param {string} what
     */
    function requireSnapshot(what) {
        if (mode === 'capture') return;
        throw new SourceError(
            `${what} Anime X Nonton hanya tersedia dari snapshot tangkapan (ANX_MODE=capture). `
            + 'Mode live baru menyediakan daftar & pencarian.',
            { kind: 'config', source: ID },
        );
    }

    return {
        id: ID,
        name: NAME,
        baseUrl: base,
        country: 'JP',
        policy: POLICY,
        // Mode 'capture' hanya punya satu potret data: tidak ada paginasi/jelajah.
        supportsBrowse: false,
        /** true bila adapter ini masih bisa dipakai (dipakai /api/health). */
        get usable() { return mode === 'capture' || (mode === 'live' && liveReady(canonicalTemplate)); },
        mode,

        parseRef(parts) {
            const id = String(parts[0] || '');
            return parts.length === 1 && REF_RE.test(id) ? { id } : null;
        },

        titleHint(ref) {
            return `Anime X Nonton #${ref.id}`;
        },

        async latest(ctx = {}) {
            const { posts } = await postsFrom('get_posts', { page: 1, count: 30 });
            return posts.map((p) => toAnime(p, base)).filter(Boolean);
        },

        async search(query, ctx = {}) {
            const q = String(query || '').trim();
            const { posts, live } = await postsFrom('search_category_collection', {
                search: q, page: 1, count: 30, lang: 'id',
            });
            const items = posts.map((p) => toAnime(p, base)).filter(Boolean);
            // Live: server sudah menyaring (termasuk judul alternatif) — jangan saring ulang.
            return live || !q ? items : items.filter((a) => a.title.toLowerCase().includes(q.toLowerCase()));
        },

        /** Daftar genre dari snapshot (mode live: get_anime_genre_list). */
        async genres(ctx = {}) {
            if (mode !== 'capture') {
                const res = await callLive('get_anime_genre_list', {});
                const list = (res?.genre || res?.data?.genre || []).map((g) => ({
                    id: String(g.genreName || '').toLowerCase(),
                    label: String(g.genreName || ''),
                }));
                return { genres: list.filter((g) => g.label) };
            }
            const snap = await snapshotOnce();
            return {
                genres: snap.genres
                    .map((g) => (typeof g === 'string' ? { id: g.toLowerCase(), label: g } : { id: String(g.id || ''), label: String(g.label || '') }))
                    .filter((g) => g.id && g.label),
            };
        },

        async getAnime(ref, ctx = {}) {
            requireSnapshot('detail judul');
            const snap = await snapshotOnce();
            const post = snap.posts.find((p) => String(p.cid ?? p.categoryId ?? p.channelId) === String(ref.id));
            const anime = post ? toAnime(post, base) : null;
            if (!anime) throw notFound(`Anime #${ref.id} tidak ada di snapshot Anime X Nonton.`, ID);
            const episodes = snap.episodes[String(ref.id)] || [];
            return {
                ...anime,
                episodeList: makeEpisodeList(episodes.map((e) => ({
                    number: Number(e.number),
                    title: e.title || '',
                    released: e.released || '',
                    url: e.url || '',
                }))),
            };
        },

        async getEpisode(ref, episode, ctx = {}) {
            requireSnapshot('daftar server episode');
            const snap = await snapshotOnce();
            const list = snap.episodes[String(ref.id)] || [];
            const entry = list.find((e) => Number(e.number) === Number(episode));
            if (!entry) throw notFound(`Episode ${episode} tidak ada di snapshot Anime X Nonton.`, ID);
            const servers = (entry.servers || [])
                .map((s) => ({
                    name: clip(s.name, 40) || 'Server',
                    url: s.url,
                    kind: s.kind === 'hls' ? 'hls' : undefined,
                    lang: s.lang || null,
                }))
                .filter((s) => s.url);
            if (!servers.length) {
                throw new SourceError('Snapshot tidak memuat URL server untuk episode ini.', { kind: 'parse', source: ID });
            }
            return makeEpisode({
                episode: Number(episode),
                title: entry.title || '',
                released: entry.released || '',
                url: entry.url || '',
                servers,
                downloads: entry.downloads || [],
            });
        },
    };
}
