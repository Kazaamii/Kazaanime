/**
 * Kazanime backend — routes/stream.js (ditambahkan 22 Okt 2026)
 *   GET /api/stream/servers?ep=&anilist=&title=&title=&year=
 *        → server dari penyedia berbasis id/judul: ReAnime (embed) + AniZone (HLS "Multi Sub")
 *   GET /api/stream/hls?u=&s=   → proxy HLS AniZone: playlist ditulis ulang (semua URI → proxy),
 *                                segmen/key diteruskan apa adanya (stream, mendukung Range)
 *   GET /api/stream/sub?u=&f=&s= → subtitle ASS/SRT → WebVTT (untuk <track>)
 *   GET /api/stream/subai?u=&f=&l=&v=&s=&p= → (22 Okt 2026) "Subtitle Indonesia (AI)": bagian ke-p subtitle
 *        episode diterjemahkan Gemini (lib/subtitle-ai.js). Hanya ditawarkan (`ai` di /servers) bila episode
 *        TIDAK punya subtitle Indonesia dan GEMINI_API_KEY diisi. Hasil di-cache CDN/browser lama.
 *
 * Keamanan proxy: hanya URL yang DITANDATANGANI server ini (HMAC, lihat lib/stream-proxy.js) dan
 * hanya host media yang diizinkan (AniZone melalui suffix allowlist; AnimeOnsen melalui exact hostname,
 * client terpisah, dan robots.txt eksplisit sampai CDN/segmen) → bukan open proxy. Rate limit per IP
 * terpisah (lebih longgar: 1 episode =
 * ratusan segmen). Respons segmen/subtitle boleh di-cache lama oleh CDN (isinya tidak berubah).
 */
import { Readable } from 'node:stream';
import { Router } from 'express';
import { AI_SUBS, SOURCES, STREAMS } from '../config.js';
import { AppError, badRequest } from '../lib/errors.js';
import { looksLikeChallenge, readBody } from '../lib/fetcher.js';
import { decodeTarget, encodeTarget, isPlaylist, rewritePlaylist, toVtt } from '../lib/stream-proxy.js';
import { createAiSubtitleService, pickAiSource } from '../lib/subtitle-ai.js';
import { readEpisode } from './anime.js';

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

/** ?title= boleh berulang; maks 4 judul, masing-masing 1–100 karakter tanpa karakter kontrol. */
export function readTitles(value) {
    const arr = (Array.isArray(value) ? value : [value]).filter((v) => typeof v === 'string');
    // eslint-disable-next-line no-control-regex
    return arr.map((t) => t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).filter((t) => t.length >= 2 && t.length <= 100).slice(0, 4);
}

const readPosInt = (v, max) => {
    if (v == null || v === '') return null;
    if (!/^\d{1,9}$/.test(String(v))) throw badRequest('Parameter angka tidak valid.');
    const n = Number(v);
    return n >= 1 && n <= max ? n : null;
};

const SUB_FORMAT_RE = /^(ass|ssa|srt|vtt)$/;
const LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;
/** Parameter yang sah untuk /subai — parameter lain ditolak (mencegah URL "unik" yang membobol cache CDN). */
const SUBAI_PARAMS = new Set(['u', 'f', 'l', 'v', 's', 'p']);

/**
 * @param {{
 *   providers: ReturnType<import('../providers/index.js').createStreamProviders>,
 *   mediaClient: {stream: Function},
 *   animeOnsenMediaClient?: {stream: Function},
 *   animeOnsenMediaHosts?: string[],
 *   signer: {sign: (v: string) => string, verify: (v: string, s: string) => boolean},
 *   budgetMs: number,
 *   ai?: {gemini: {generate: Function, health: Function}, config: typeof AI_SUBS}|null,  null = fitur AI mati
 * }} deps
 */
export function streamRouter({ providers, mediaClient, animeOnsenMediaClient = null, animeOnsenMediaHosts = SOURCES.animeonsen.mediaHosts, signer, budgetMs, ai = null }) {
    const router = Router();
    const proxyScope = (value) => {
        const scope = String(value || '');
        if (scope === '' || scope === 'animeonsen') return scope;
        throw badRequest('Penyedia proxy stream tidak valid.');
    };
    const scopeSuffix = (scope, format = '') => format
        ? `|${format}${scope ? `|${scope}` : ''}`
        : (scope ? `|${scope}` : '');
    const isAnimeOnsenMediaUrl = (value) => {
        try {
            const url = new URL(String(value || ''));
            return url.protocol === 'https:' && !url.port && !url.username && !url.password
                && animeOnsenMediaHosts.map((host) => String(host).toLowerCase()).includes(url.hostname.toLowerCase());
        } catch {
            return false;
        }
    };
    const hlsUrl = (u, scope = '') => {
        if (scope === 'animeonsen' && !isAnimeOnsenMediaUrl(u)) {
            throw new AppError('Playlist AnimeOnsen merujuk host di luar allowlist.', { status: 403, code: 'BAD_SIGNATURE' });
        }
        return `/api/stream/hls?u=${encodeTarget(u)}${scope ? `&p=${scope}` : ''}&s=${signer.sign(`${u}${scopeSuffix(scope)}`)}`;
    };
    const subUrl = (u, f, scope = '') => `/api/stream/sub?u=${encodeTarget(u)}&f=${f}${scope ? `&p=${scope}` : ''}&s=${signer.sign(`${u}${scopeSuffix(scope, f)}`)}`;
    const mediaFor = (scope) => scope === 'animeonsen' ? animeOnsenMediaClient : mediaClient;
    const mediaHeaders = (scope) => (scope === 'animeonsen'
        ? { Origin: SOURCES.animeonsen.baseUrl, Referer: `${SOURCES.animeonsen.baseUrl}/` }
        : {});
    const aiVersion = ai?.config.version ?? AI_SUBS.version;
    const aiSign = (u, f, l, v) => signer.sign(`${u}|ai|${f}|${l}|${v}`);
    const subAiUrl = (u, f, l) => `/api/stream/subai?u=${encodeTarget(u)}&f=${f}&l=${l}&v=${aiVersion}&s=${aiSign(u, f, l, aiVersion)}`;

    /**
     * Ambil subtitle sekali. 403/429/CAPTCHA/challenge dihentikan; tidak ada retry atau rotasi identitas.
     * @returns {Promise<string>} isi mentah (ASS/SRT/VTT)
     */
    async function fetchSubtitle(target, { timeoutMs = 10000, scope = '' } = {}) {
        if (scope === 'animeonsen' && !isAnimeOnsenMediaUrl(target)) {
            throw new AppError('Subtitle AnimeOnsen merujuk host di luar allowlist.', { status: 403, code: 'BAD_SIGNATURE' });
        }
        const client = mediaFor(scope);
        if (!client) throw new AppError('Proxy media AnimeOnsen belum dikonfigurasi.', { status: 503, code: 'PROXY_UNAVAILABLE' });
        const up = await client.stream(target, { timeoutMs, maxBytes: 4 * 1024 * 1024, headers: mediaHeaders(scope) });
        const body = await readBody({ body: up.body }, 4 * 1024 * 1024, { source: scope === 'animeonsen' ? 'animeonsen-media' : 'anizone-media' });
        if (up.status === 403 || up.status === 429 || looksLikeChallenge({ status: up.status, headers: up.headers, text: body })) {
            throw new AppError('Subtitle dibatasi situs sumber; akses dihentikan tanpa percobaan ulang.', {
                status: 503, code: 'UPSTREAM_BLOCKED', details: { status: up.status },
            });
        }
        if (up.status >= 400) throw new AppError(`Subtitle tidak tersedia (HTTP ${up.status}).`, { status: up.status === 404 ? 404 : 502, code: 'UPSTREAM' });
        return body;
    }

    const aiService = ai
        ? createAiSubtitleService({
            gemini: ai.gemini,
            config: ai.config,
            // Tidak mengulang request subtitle yang dibatasi; kegagalan dikembalikan ke pemanggil AI.
            loadVtt: async (target, format) => toVtt(await fetchSubtitle(target, { timeoutMs: 8000 }), format),
        })
        : null;

    function verified(u, s, suffix = '') {
        const target = decodeTarget(u);
        if (!target || !signer.verify(`${target}${suffix}`, String(s || ''))) {
            throw new AppError('Tautan stream tidak valid.', { status: 403, code: 'BAD_SIGNATURE' });
        }
        return target;
    }

    /** Tawaran "Subtitle Indonesia (AI)" — hanya bila AI aktif & episode tidak punya subtitle Indonesia. */
    function aiOffer(subtitles) {
        if (!aiService) return null;
        const src = pickAiSource(subtitles || []);
        if (!src?.file || !SUB_FORMAT_RE.test(String(src.format || ''))) return null;
        const lang = LANG_RE.test(String(src.lang || '')) ? src.lang : 'und';
        return { url: subAiUrl(src.file, src.format, lang), from: lang, sourceLabel: src.label, label: ai.config.label };
    }

    router.get('/servers', async (req, res) => {
        const ep = readEpisode(req.query.ep);
        const anilist = readPosInt(req.query.anilist, 1e8);
        const year = readPosInt(req.query.year, 2100);
        const titles = readTitles(req.query.title);
        if (!anilist && !titles.length) throw badRequest('Butuh parameter anilist atau title.');
        const r = await providers.servers({ anilist, ep, titles, year }, { deadline: Date.now() + budgetMs });
        const servers = r.servers.map((s) => (s.kind === 'hls'
            ? {
                provider: s.provider,
                kind: 'hls',
                name: s.name,
                lang: s.lang,
                url: hlsUrl(s.src),
                direct: s.src,
                poster: s.poster ? hlsUrl(s.poster) : null, // CDN mengirim CORP → lewat proxy
                subtitles: (s.subtitles || []).map((t) => ({ label: t.label, lang: t.lang, default: Boolean(t.default), url: subUrl(t.file, t.format) })),
                ai: aiOffer(s.subtitles),
            }
            : { provider: s.provider, kind: 'embed', name: s.name, label: s.label || '', lang: s.lang, url: s.url }));
        const any = servers.length > 0;
        res.set('Cache-Control', any ? 'public, max-age=60, s-maxage=600, stale-while-revalidate=1800' : 'public, max-age=0, s-maxage=60');
        res.json({
            ok: true,
            source: 'streams',
            fallback: false,
            stale: Object.values(r.status).includes('stale'),
            ...(r.errors.length ? { errors: r.errors } : {}),
            generatedAt: new Date().toISOString(),
            data: { episode: ep, servers, status: r.status },
        });
    });

    router.get('/hls', async (req, res) => {
        const scope = proxyScope(req.query.p);
        const target = verified(req.query.u, req.query.s, scopeSuffix(scope));
        if (scope === 'animeonsen' && !isAnimeOnsenMediaUrl(target)) {
            throw new AppError('URL AnimeOnsen merujuk host di luar allowlist.', { status: 403, code: 'BAD_SIGNATURE' });
        }
        const client = mediaFor(scope);
        if (!client) throw new AppError('Proxy media AnimeOnsen belum dikonfigurasi.', { status: 503, code: 'PROXY_UNAVAILABLE' });
        const range = typeof req.headers.range === 'string' && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : null;
        const ac = new AbortController();
        // Pengguna menutup koneksi sebelum respons selesai → batalkan fetch ke CDN.
        // (BUKAN req.on('close'): sejak Node 16 event itu terpicu begitu request GET selesai dibaca.)
        res.on('close', () => { if (!res.writableFinished) ac.abort(); });
        const fetchUp = () => client.stream(target, {
            signal: ac.signal,
            headers: { ...mediaHeaders(scope), ...(range ? { Range: range } : {}) },
            timeoutMs: STREAMS.proxyTimeoutMs,
            maxBytes: STREAMS.maxSegmentBytes,
        });
        const up = await fetchUp();
        if (up.status === 403 || up.status === 429 || looksLikeChallenge({ status: up.status, headers: up.headers })) {
            await up.body?.cancel().catch(() => {});
            throw new AppError('Server video membatasi akses; request dihentikan tanpa percobaan ulang.', {
                status: 503, code: 'UPSTREAM_BLOCKED', details: { status: up.status },
            });
        }
        if (up.status >= 400) {
            await up.body?.cancel().catch(() => {});
            throw new AppError(`Server video membalas HTTP ${up.status}.`, { status: up.status === 404 ? 404 : 502, code: 'UPSTREAM' });
        }
        const ct = up.headers.get('content-type') || '';
        if (/mpegurl/i.test(ct) || /\.m3u8$/i.test(new URL(target).pathname)) {
            const text = await readBody({ body: up.body }, 2 * 1024 * 1024, { source: 'anizone-media' });
            if (!isPlaylist(text)) throw new AppError('Playlist video tidak valid.', { status: 502, code: 'UPSTREAM' });
            res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            res.set('Cache-Control', scope ? 'private, no-store' : 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
            res.send(rewritePlaylist(text, up.url || target, (url) => hlsUrl(url, scope)));
            return;
        }
        res.status(up.status === 206 ? 206 : 200);
        for (const h of PASS_HEADERS) {
            const v = up.headers.get(h);
            if (v) res.set(h, v);
        }
        res.set('Cache-Control', scope ? 'private, no-store' : 'public, max-age=86400, s-maxage=604800, immutable');
        if (!up.body) {
            res.end();
            return;
        }
        await new Promise((resolve) => {
            const node = Readable.fromWeb(up.body);
            node.on('error', () => { res.destroy(); resolve(); });
            res.on('close', () => { node.destroy(); resolve(); });
            node.pipe(res);
        });
    });

    router.get('/sub', async (req, res) => {
        const f = String(req.query.f || '').toLowerCase();
        if (!SUB_FORMAT_RE.test(f)) throw badRequest('Format subtitle tidak valid.');
        const scope = proxyScope(req.query.p);
        const target = verified(req.query.u, req.query.s, scopeSuffix(scope, f));
        const text = await fetchSubtitle(target, { scope });
        res.set('Content-Type', 'text/vtt; charset=utf-8');
        res.set('Cache-Control', scope ? 'private, no-store' : 'public, max-age=86400, s-maxage=2592000, immutable');
        res.send(toVtt(text, f));
    });

    router.get('/subai', async (req, res) => {
        if (!aiService) {
            throw new AppError('Terjemahan subtitle AI belum diaktifkan di server ini (GEMINI_API_KEY belum diisi).', { status: 503, code: 'AI_DISABLED' });
        }
        if (Object.keys(req.query).some((k) => !SUBAI_PARAMS.has(k))) throw badRequest('Parameter tidak dikenal.');
        const f = String(req.query.f || '');
        const l = String(req.query.l || '');
        const v = String(req.query.v || '');
        if (!SUB_FORMAT_RE.test(f) || !(LANG_RE.test(l) || l === 'und') || !/^\d{1,3}$/.test(v)) throw badRequest('Parameter subtitle AI tidak valid.');
        const target = verified(req.query.u, req.query.s, `|ai|${f}|${l}|${v}`);
        if (Number(v) !== aiVersion) {
            throw new AppError('Versi subtitle AI sudah berganti — muat ulang halaman.', { status: 409, code: 'AI_STALE' });
        }
        const p = String(req.query.p ?? '0');
        if (!/^\d{1,2}$/.test(p)) throw badRequest('Nomor bagian tidak valid.');
        const data = await aiService.translate({ target, format: f, sourceLang: l, part: Number(p) });
        // Hasil sama untuk semua penonton → cache CDN/browser lama. Bagian yang masih ada baris asli: cache pendek.
        res.set('Cache-Control', data.untranslated
            ? 'public, max-age=3600, s-maxage=86400'
            : 'public, max-age=604800, s-maxage=2592000, immutable');
        res.json({ ok: true, source: 'gemini', generatedAt: new Date().toISOString(), data });
    });

    /** Info untuk /api/health (tanpa key). */
    router.aiHealth = () => (aiService ? aiService.health() : { enabled: false });

    return router;
}
