#!/usr/bin/env node
/**
 * PROBE SEMENTARA (dihapus sebelum PR) — memeriksa apakah API yang dipakai
 * aplikasi Miku Moe 3.6 (apps.animekita.org) bisa dijangkau klien luar.
 *
 * Fakta dari APK (androguard):
 *   Animeku      : https://apps.animekita.org/api/v1.2.5/baruupload.php?page=
 *                  https://apps.animekita.org/api/v1.2.5/home/ongoing.php?page=&type=all
 *                  https://apps.animekita.org/api/v1.2.5/genreseries.php?page=
 *                  https://apps.animekita.org/api/v1.2.5/search.php?keyword=donghua&page=
 *   Animeloverz  : baruupload.php + home/ongoing.php (host yang SAMA)
 *   header app   : user-agent "Dart/3.9 (dart:io)", accept "application/json"
 *
 * Probe ini HANYA memakai User-Agent bot jujur — tidak meniru UA aplikasi,
 * tidak mengulang saat 403, tidak memakai proxy.
 */
const UA = 'KazanimeBot/1.0 (+https://github.com/Kazaamii/Kazaanime)';
const TIMEOUT_MS = 15000;

const TARGETS = [
    { id: 'api-baru-GET', url: 'https://apps.animekita.org/api/v1.2.5/baruupload.php?page=1', method: 'GET' },
    { id: 'api-baru-POST', url: 'https://apps.animekita.org/api/v1.2.5/baruupload.php?page=1', method: 'POST' },
    { id: 'api-donghua-search', url: 'https://apps.animekita.org/api/v1.2.5/search.php?keyword=donghua&page=1', method: 'GET' },
    { id: 'api-genre', url: 'https://apps.animekita.org/api/v1.2.5/genreseries.php?page=1', method: 'GET' },
    { id: 'api-ongoing', url: 'https://apps.animekita.org/api/v1.2.5/home/ongoing.php?page=1&type=all', method: 'GET' },
    { id: 'api-http', url: 'http://apps.animekita.org/api/v1.2.5/baruupload.php?page=1', method: 'GET' },
    { id: 'root-https', url: 'https://apps.animekita.org/', method: 'GET' },
    { id: 'apex-https', url: 'https://animekita.org/', method: 'GET' },
];

function clean(text, max = 160) {
    return String(text || '').replace(/\s+/g, ' ').replace(/%/g, '%25').slice(0, max);
}

const results = [];
for (const t of TARGETS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(t.url, {
            method: t.method,
            headers: { 'User-Agent': UA, Accept: 'application/json,text/html;q=0.8,*/*;q=0.5' },
            body: t.method === 'POST' ? '' : undefined,
            redirect: 'follow',
            signal: controller.signal,
        });
        const text = await res.text();
        results.push({
            id: t.id,
            status: res.status,
            final: res.url,
            type: res.headers.get('content-type') || '',
            server: res.headers.get('server') || '',
            cfRay: res.headers.get('cf-ray') || '',
            bytes: text.length,
            head: clean(text),
        });
    } catch (err) {
        results.push({ id: t.id, error: `${err?.name || 'Error'}: ${clean(err?.message || err, 100)}` });
    } finally {
        clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 1200));
}

const lines = results.map((r) => (r.error
    ? `${r.id} -> ERROR ${r.error}`
    : `${r.id} -> ${r.status} ${r.final} [${r.type}]${r.server ? ` server=${r.server}` : ''}${r.cfRay ? ` cf-ray=${r.cfRay}` : ''} bytes=${r.bytes} :: ${r.head}`));

for (const line of lines) console.log(line);
console.log(`::error::${lines.join(' %0A ').replace(/%/g, '%25')}`);
