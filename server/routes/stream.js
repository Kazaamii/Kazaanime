/**
 * Kazanime backend — routes/stream.js (ditambahkan 22 Okt 2026)
 *   GET /api/stream/servers?ep=&anilist=&title=&title=&year=
 *        → server dari penyedia berbasis id/judul: ReAnime (embed) + AniZone (HLS "Multi Sub")
 *   GET /api/stream/hls?u=&s=   → proxy HLS AniZone: playlist ditulis ulang (semua URI → proxy),
 *                                segmen/key diteruskan apa adanya (stream, mendukung Range)
 *   GET /api/stream/sub?u=&f=&s= → subtitle ASS/SRT → WebVTT (untuk <track>)
 *
 * Keamanan proxy: hanya URL yang DITANDATANGANI server ini (HMAC, lihat lib/stream-proxy.js) dan
 * hanya host media yang diizinkan (STREAMS.anizone.mediaHosts, dicek lagi di fetcher termasuk
 * setelah redirect) → bukan open proxy. Rate limit per IP terpisah (lebih longgar: 1 episode =
 * ratusan segmen). Respons segmen/subtitle boleh di-cache lama oleh CDN (isinya tidak berubah).
 */
import { Readable } from 'node:stream';
import { Router } from 'express';
import { STREAMS } from '../config.js';
import { AppError, badRequest } from '../lib/errors.js';
import { looksLikeChallenge, readBody } from '../lib/fetcher.js';
import { sleep } from '../lib/rate-limit.js';
import { decodeTarget, encodeTarget, isPlaylist, rewritePlaylist, toVtt } from '../lib/stream-proxy.js';
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

/**
 * @param {{
 *   providers: ReturnType<import('../providers/index.js').createStreamProviders>,
 *   mediaClient: {stream: Function},
 *   signer: {sign: (v: string) => string, verify: (v: string, s: string) => boolean},
 *   budgetMs: number,
 *   subRetryDelayMs?: number,
 * }} deps
 */
export function streamRouter({ providers, mediaClient, signer, budgetMs, subRetryDelayMs = 1500 }) {
    const router = Router();
    const hlsUrl = (u) => `/api/stream/hls?u=${encodeTarget(u)}&s=${signer.sign(u)}`;
    const subUrl = (u, f) => `/api/stream/sub?u=${encodeTarget(u)}&f=${f}&s=${signer.sign(`${u}|${f}`)}`;

    function verified(u, s, suffix = '') {
        const target = decodeTarget(u);
        if (!target || !signer.verify(`${target}${suffix}`, String(s || ''))) {
            throw new AppError('Tautan stream tidak valid.', { status: 403, code: 'BAD_SIGNATURE' });
        }
        return target;
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
        const target = verified(req.query.u, req.query.s);
        const range = typeof req.headers.range === 'string' && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : null;
        const ac = new AbortController();
        // Pengguna menutup koneksi sebelum respons selesai → batalkan fetch ke CDN.
        // (BUKAN req.on('close'): sejak Node 16 event itu terpicu begitu request GET selesai dibaca.)
        res.on('close', () => { if (!res.writableFinished) ac.abort(); });
        const up = await mediaClient.stream(target, {
            signal: ac.signal,
            headers: range ? { Range: range } : {},
            timeoutMs: STREAMS.proxyTimeoutMs,
            maxBytes: STREAMS.maxSegmentBytes,
        });
        if (up.status >= 400) {
            await up.body?.cancel().catch(() => {});
            throw new AppError(`Server video membalas HTTP ${up.status}.`, { status: up.status === 404 ? 404 : 502, code: 'UPSTREAM' });
        }
        const ct = up.headers.get('content-type') || '';
        if (/mpegurl/i.test(ct) || /\.m3u8$/i.test(new URL(target).pathname)) {
            const text = await readBody({ body: up.body }, 2 * 1024 * 1024, { source: 'anizone-media' });
            if (!isPlaylist(text)) throw new AppError('Playlist video tidak valid.', { status: 502, code: 'UPSTREAM' });
            res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            res.set('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
            res.send(rewritePlaylist(text, up.url || target, hlsUrl));
            return;
        }
        res.status(up.status === 206 ? 206 : 200);
        for (const h of PASS_HEADERS) {
            const v = up.headers.get(h);
            if (v) res.set(h, v);
        }
        res.set('Cache-Control', 'public, max-age=86400, s-maxage=604800, immutable');
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
        if (!/^(ass|ssa|srt|vtt)$/.test(f)) throw badRequest('Format subtitle tidak valid.');
        const target = verified(req.query.u, req.query.s, `|${f}`);
        let text = null;
        let lastStatus = 0;
        // Berkas subtitle di CDN AniZone kadang kena challenge Cloudflare secara acak → ulangi.
        for (let attempt = 0; attempt < STREAMS.subtitleAttempts && text == null; attempt++) {
            if (attempt) await sleep(subRetryDelayMs * attempt);
            const up = await mediaClient.stream(target, { timeoutMs: 10000, maxBytes: 4 * 1024 * 1024 });
            const body = await readBody({ body: up.body }, 4 * 1024 * 1024, { source: 'anizone-media' });
            lastStatus = up.status;
            if (looksLikeChallenge({ status: up.status, headers: up.headers, text: body })) continue;
            if (up.status >= 400) throw new AppError(`Subtitle tidak tersedia (HTTP ${up.status}).`, { status: up.status === 404 ? 404 : 502, code: 'UPSTREAM' });
            text = body;
        }
        if (text == null) {
            throw new AppError('Subtitle sedang dibatasi situs sumber, coba lagi sebentar.', { status: 503, code: 'UPSTREAM_BLOCKED', details: { status: lastStatus } });
        }
        res.set('Content-Type', 'text/vtt; charset=utf-8');
        res.set('Cache-Control', 'public, max-age=86400, s-maxage=2592000, immutable');
        res.send(toVtt(text, f));
    });

    return router;
}
