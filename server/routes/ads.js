/**
 * Kazanime backend — routes/ads.js
 * Bantuan penyaring iklan (putaran 11, 24 Okt 2026).
 *
 *   GET /api/ads/status?host=a,b       → ringkasan penyaring + (opsional) hasil cek DoH
 *   GET /api/ads/check?host=a,b        → { hosts: { [host]: { blocked, source, reason } } }
 *   GET /api/ads/blocklist             → { hosts: [...], patterns: n, version, dohEndpoint }
 *
 * Kenapa ada endpoint cek DNS di sini: halaman web tidak bisa mengubah DNS pengunjung, tetapi
 * server bisa menanyakan daftar blokir **AdGuard DNS** (DoH) — persis resolver yang diminta
 * pengguna — lalu memberi tahu frontend apakah host embed itu domain iklan. Frontend memakai
 * hasilnya untuk memberi peringatan + menaruh server tersebut di urutan belakang, BUKAN untuk
 * memblokir otomatis (host video yang sah kadang masuk daftar blokir).
 *
 * Semua endpoint fail-open: DoH mati → `blocked: null` ("tidak diketahui").
 */
import { Router } from 'express';
import { badRequest } from '../lib/errors.js';
import { AD_HOSTS, AD_URL_PATTERNS, adFilterSummary, inspectAdUrl } from '../lib/adblock.js';
import { createDnsFilter } from '../lib/dns.js';

/** Host yang boleh ditanyakan: hostname polos (tanpa skema/path), maks 20. */
export function readHosts(value) {
    const raw = Array.isArray(value) ? value.join(',') : String(value || '');
    const hosts = [...new Set(raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))];
    if (!hosts.length) throw badRequest('Parameter host wajib diisi (pisahkan dengan koma).');
    if (hosts.length > 20) throw badRequest('Maksimal 20 host per permintaan.');
    for (const host of hosts) {
        if (!/^[a-z0-9.-]{1,253}$/.test(host) || host.startsWith('.') || host.endsWith('..')) {
            throw badRequest(`Host tidak valid: ${host.slice(0, 60)}`);
        }
    }
    return hosts;
}

/**
 * @param {{dns?: ReturnType<typeof createDnsFilter>}} [opts]
 */
export function adsRouter({ dns = createDnsFilter() } = {}) {
    const router = Router();
    const noStore = (res) => res.set('Cache-Control', 'no-store');

    router.get('/status', async (req, res, next) => {
        try {
            const summary = adFilterSummary();
            const hosts = req.query.host === undefined ? null : readHosts(req.query.host);
            const checked = hosts ? await dns.checkMany(hosts) : null;
            noStore(res);
            res.json({
                ok: true,
                source: 'ads',
                data: {
                    ...summary,
                    dns: dns.status(),
                    // `hosts` = jumlah aturan host (ringkasan); hasil per host ditaruh di `checked`
                    // supaya kedua bentuk tidak saling menimpa.
                    ...(checked ? { checked: Object.fromEntries(Object.entries(checked).map(([host, blocked]) => [host, { blocked }])) } : {}),
                },
            });
        } catch (error) {
            next(error);
        }
    });

    router.get('/check', async (req, res, next) => {
        try {
            const hosts = readHosts(req.query.host ?? req.query.hosts);
            const byRule = Object.fromEntries(hosts.map((host) => [host, inspectAdUrl(`https://${host}/`)]));
            // Hanya tanya DoH untuk host yang tidak sudah pasti iklan (hemat request).
            const needDns = hosts.filter((host) => !byRule[host].blocked);
            const dnsResult = needDns.length ? await dns.checkMany(needDns) : {};
            noStore(res);
            res.json({
                ok: true,
                source: 'ads',
                data: {
                    hosts: Object.fromEntries(hosts.map((host) => {
                        const rule = byRule[host];
                        if (rule.blocked) return [host, { blocked: true, source: 'rule', reason: rule.reason }];
                        const dnsBlocked = dnsResult[host];
                        if (dnsBlocked === true) return [host, { blocked: true, source: 'adguard-dns', reason: 'Ada di daftar blokir AdGuard DNS.' }];
                        if (dnsBlocked === false) return [host, { blocked: false, source: 'adguard-dns', reason: '' }];
                        return [host, { blocked: null, source: 'none', reason: 'Tidak bisa diperiksa (server tidak menjangkau DNS AdGuard).' }];
                    })),
                },
            });
        } catch (error) {
            next(error);
        }
    });

    router.get('/blocklist', (req, res) => {
        res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
        res.json({
            ok: true,
            source: 'ads',
            data: {
                version: 1,
                hosts: AD_HOSTS,
                patterns: AD_URL_PATTERNS.map((rx) => String(rx)),
                dohEndpoint: dns.endpoint,
                note: 'DNS perangkat tidak bisa diubah oleh halaman web; daftar ini dipakai untuk menolak URL iklan yang jelas.',
            },
        });
    });

    return router;
}
