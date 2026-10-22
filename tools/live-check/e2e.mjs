/**
 * Uji end-to-end SEMENTARA (runner GitHub Actions): server Kazanime asli (npm start) memanggil
 * situs sumber live. Hasil → .live-check/e2e.json. Bukan bagian aplikasi.
 */
import { writeFile, mkdir } from 'node:fs/promises';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';
const out = { startedAt: new Date().toISOString(), steps: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(name, path, { raw = false, headers = {} } = {}) {
    const t0 = Date.now();
    const rec = { name, path };
    try {
        const res = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, { headers, signal: AbortSignal.timeout(30000) });
        rec.status = res.status;
        rec.ms = Date.now() - t0;
        rec.type = res.headers.get('content-type');
        rec.cache = res.headers.get('cache-control');
        if (raw) {
            const buf = Buffer.from(await res.arrayBuffer());
            rec.bytes = buf.length;
            rec.head = buf.subarray(0, 120).toString('latin1');
            rec.body = buf;
        } else {
            const json = await res.json().catch(() => null);
            rec.json = json;
        }
    } catch (e) {
        rec.error = String(e?.message || e);
    }
    const { body, json, ...log } = rec;
    const summary = json ? summarize(json) : undefined;
    out.steps.push({ ...log, summary });
    console.log(`${rec.status ?? 'ERR'} ${String(rec.ms ?? '').padStart(5)}ms ${name} ${rec.error || ''} ${summary ? JSON.stringify(summary).slice(0, 300) : (rec.bytes ?? '')}`);
    return rec;
}

function summarize(j) {
    if (!j || typeof j !== 'object') return j;
    const d = j.data;
    const s = { ok: j.ok, source: j.source, fallback: j.fallback, stale: j.stale, errors: (j.errors || []).map((e) => `${e.source}:${e.kind}:${String(e.message || '').slice(0, 80)}`) };
    if (Array.isArray(d)) {
        s.count = d.length;
        s.bySource = d.reduce((m, x) => ({ ...m, [x.source]: (m[x.source] || 0) + 1 }), {});
        s.sample = d.slice(0, 3).map((x) => `${x.slug} | ${x.title} | ep${x.latestEpisode ?? '-'} | img:${x.image ? 'y' : 'n'}`);
    } else if (d?.servers) {
        s.servers = d.servers.map((x) => `${x.provider || ''} ${x.kind || ''} ${x.name} ${x.lang} ${String(x.url).slice(0, 90)}${x.subtitles ? ` subs:${x.subtitles.length}` : ''}`);
        s.downloads = d.downloads?.length;
        s.status = d.status;
    } else if (d?.days) {
        s.days = Object.fromEntries(Object.entries(d.days).map(([k, v]) => [k, `${v.length} (${v.filter((x) => x.time).length} berjam) ${[...new Set(v.map((x) => x.source))].join(',')}`]));
    } else if (d?.sources) {
        s.sources = d.sources.map((x) => `${x.id}:${x.robots}/${x.circuit}${x.reason ? `(${x.reason})` : ''}`);
        s.streams = d.streams;
    } else if (d && typeof d === 'object') {
        s.title = d.title;
        s.slug = d.slug;
        s.latestEpisode = d.latestEpisode;
        s.episodeCount = d.episodeList?.length;
        s.image = Boolean(d.image);
    }
    if (j.ok === false) s.error = `${j.code}: ${j.error}`;
    return s;
}

await mkdir('.live-check', { recursive: true });
for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* belum siap */ }
    await sleep(500);
}

await call('health', '/api/health');
await call('latest (semua adapter)', '/api/anime/latest');
await call('search kusuriya', `/api/anime/search?q=${encodeURIComponent('Kusuriya no Hitorigoto')}`);
await call('search renegade', `/api/anime/search?q=${encodeURIComponent('Renegade Immortal')}`);
await call('search cyberpunk', `/api/anime/search?q=${encodeURIComponent('Cyberpunk Edgerunners')}`);
await call('detail anichin', '/api/anime/anichin~renegade-immortal');
await call('episode anichin 163', '/api/anime/anichin~renegade-immortal/episode/163');
await call('detail hianime', '/api/anime/hianime~cyberpunk-edgerunners-2');
await call('episode hianime 1', '/api/anime/hianime~cyberpunk-edgerunners-2/episode/1');
await call('detail otakudesu', '/api/anime/otakudesu~kusuriya-hitorigoto-s3-sub-indo');
await call('schedule', '/api/anime/schedule');

const s1 = await call('stream servers One Piece ep1', `/api/stream/servers?ep=1&anilist=21&title=${encodeURIComponent('One Piece')}&year=1999`);
const s2 = await call('stream servers Ken Deshita S2 ep3', `/api/stream/servers?ep=3&anilist=159042&title=${encodeURIComponent('Reincarnated as a Sword Season 2')}&title=${encodeURIComponent('Tensei Shitara Ken Deshita 2nd Season')}&year=2026`);
await call('stream servers tanpa anilist (judul)', `/api/stream/servers?ep=1&title=${encodeURIComponent('Frieren: Beyond Journey\'s End')}&title=${encodeURIComponent('Sousou no Frieren')}&year=2023`);

const hls = [...(s2.json?.data?.servers || []), ...(s1.json?.data?.servers || [])].find((x) => x.kind === 'hls');
if (hls) {
    const m = await call('proxy master.m3u8', hls.url, { raw: true });
    const text = m.body?.toString('utf8') || '';
    const audio = /URI="([^"]+)"/.exec(text)?.[1];
    const variant = text.split('\n').find((l) => l && !l.startsWith('#'));
    if (variant) {
        const v = await call('proxy variant.m3u8', new URL(variant, BASE).href, { raw: true });
        const vt = v.body?.toString('utf8') || '';
        const key = /#EXT-X-KEY:[^\n]*URI="([^"]+)"/.exec(vt)?.[1];
        if (key) await call('proxy AES key', new URL(key, BASE).href, { raw: true });
        const seg = vt.split('\n').find((l) => l && !l.startsWith('#'));
        if (seg) {
            const sres = await call('proxy segmen .ts', new URL(seg, BASE).href, { raw: true });
            out.segmentBytes = sres.bytes;
            await call('proxy segmen .ts (Range)', new URL(seg, BASE).href, { raw: true, headers: { Range: 'bytes=0-1023' } });
        }
    }
    if (audio) await call('proxy audio playlist', new URL(audio, BASE).href, { raw: true });
    const sub = hls.subtitles?.[0];
    if (sub) {
        const r = await call(`subtitle ${sub.label} → VTT`, sub.url, { raw: true });
        out.subtitleHead = r.body?.toString('utf8').slice(0, 300);
    }
    out.hlsSubtitleLabels = (hls.subtitles || []).map((x) => `${x.label}${x.default ? '*' : ''}`);
}
await call('health (akhir)', '/api/health');
out.finishedAt = new Date().toISOString();
await writeFile('.live-check/e2e.json', JSON.stringify(out, null, 2));
console.log('selesai');
// pemicu ulang: uji kode backend terbaru
// pemicu ulang #2
