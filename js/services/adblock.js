/**
 * Kazanime — services/adblock.js
 * Penyaring domain iklan di sisi peramban (putaran 11, 24 Okt 2026).
 *
 * Permintaan pengguna: *"iklan masih saja muncul dan memaksa new tab … gunakan dns seperti
 * ini https://dns.adguard.com/dns-query atau terapkan di web saya agar tidak ada iklan"*.
 *
 * Yang bisa dilakukan halaman web (dan yang tidak):
 *  - TIDAK bisa mengubah DNS perangkat pengunjung; DNS diatur di perangkat/router
 *    (tombol "Panduan AdGuard DNS" menjelaskan langkahnya).
 *  - BISA menolak URL yang jelas jaringan iklan/gateway klik sebelum dipasang sebagai iframe,
 *    dan bisa meminta backend menanyakan daftar blokir **AdGuard DNS** (DoH) untuk host yang
 *    tidak dikenal — hasilnya dipakai sebagai peringatan/urutan, bukan pemblokiran otomatis.
 *
 * Daftar pola di bawah adalah cermin `server/lib/adblock.js`; dipakai juga saat perangkat
 * offline atau backend mati. Daftar sengaja konservatif: host video yang sah tidak disaring.
 */
import { API_CONFIG, STORAGE_KEYS } from '../config.js';
import { storage } from './storage.js';

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Domain iklan/tracker/gateway klik (cek akhiran host). */
export const AD_HOSTS = Object.freeze([
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
    'adsystem.com', 'amazon-adsystem.com', 'adnxs.com', 'criteo.com', 'criteo.net',
    'taboola.com', 'outbrain.com', 'revcontent.com', 'mgid.com', 'zergnet.com',
    'popads.net', 'popcash.net', 'popmyads.com', 'popunder.net', 'popunders.net',
    'propellerads.com', 'propellerads.biz', 'propeller-network.com', 'onclickads.net',
    'adsterra.com', 'adsterra.net', 'hilltopads.net', 'hilltopads.com', 'adcash.com',
    'clickadilla.com', 'exoclick.com', 'exosrv.com', 'juicyads.com', 'trafficjunky.com',
    'trafficfactory.biz', 'a-ads.com', 'coinzilla.com', 'bitmedia.io', 'cointraffic.io',
    'ad-maven.com', 'admaven.com', 'clickaine.com', 'adnium.com', 'adspy.com',
    'monetag.com', 'onclickalgo.com', 'clickadu.com', 'adprovider.net', 'adpushup.com',
    'adroll.com', 'smartadserver.com', 'rubiconproject.com', 'pubmatic.com',
    'openx.net', 'sharethrough.com', 'teads.tv', 'spotxchange.com', 'yieldmo.com',
]);

/** Pola jalur/query "klik iklan" (contoh nyata: `/iclick?...` → "iclick link error"). */
export const AD_URL_PATTERNS = Object.freeze([
    /(?:^|[/?&._-])iclick(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])adclick(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])onclickads?(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])popunder(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])popads?(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])adsterra(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])clickadilla(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])directlink(?:[/?&._-]|$)/i,
    /\/ad(?:s|v)?\/(?:click|redirect|go|link)/i,
    /[?&](?:ad_?id|adzone|zoneid|aff_?id|affiliate_?id|click_?id|campaign_?id)=[^&]*/i,
]);

/** Host iklan yang cocok (atau null). */
export function adHostMatch(host) {
    const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
    if (!h) return null;
    return AD_HOSTS.find((rule) => h === rule || h.endsWith(`.${rule}`)) || null;
}

/**
 * URL menuju jaringan iklan / gateway klik?
 * @param {string} value
 * @returns {{blocked: boolean, reason?: string}}
 */
export function inspectAdUrl(value) {
    let url;
    try {
        url = new URL(String(value || ''));
    } catch {
        return { blocked: false };
    }
    if (!/^https?:$/.test(url.protocol)) return { blocked: true, reason: 'Bukan http(s).' };
    const hostRule = adHostMatch(url.hostname);
    if (hostRule) return { blocked: true, reason: `domain iklan (${hostRule})` };
    if (AD_URL_PATTERNS.some((rx) => rx.test(`${url.pathname}${url.search}`))) {
        return { blocked: true, reason: 'URL berpola klik iklan' };
    }
    return { blocked: false };
}

/**
 * Saring server: buang yang URL-nya jelas iklan. Server media (hls/video) & URL internal
 * (`/api/stream/...`) selalu lolos.
 * @template {{url?: string, kind?: string}} T
 * @param {T[]} servers
 * @returns {{servers: T[], blocked: {name?: string, url: string, reason: string}[]}}
 */
export function filterAdServers(servers = []) {
    const kept = [];
    const blocked = [];
    for (const server of Array.isArray(servers) ? servers : []) {
        const url = String(server?.url || '');
        if (server?.kind === 'hls' || server?.kind === 'video' || !/^https?:\/\//i.test(url)) {
            kept.push(server);
            continue;
        }
        const verdict = inspectAdUrl(url);
        if (verdict.blocked) blocked.push({ name: String(server?.name || ''), url, reason: verdict.reason || 'iklan' });
        else kept.push(server);
    }
    return { servers: kept, blocked };
}

/* ------------------------------------------------------------------ */
/* Pemeriksaan reputasi host lewat DNS AdGuard (DoH) di backend         */
/* ------------------------------------------------------------------ */
const CACHE_KEY = 'kz:adcheck:';

const readCache = () => {
    const raw = storage.get(STORAGE_KEYS.adCheckCache, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
};

const writeCache = (cache) => {
    // Buang entri kedaluwarsa supaya localStorage tidak tumbuh terus.
    const now = Date.now();
    const trimmed = Object.fromEntries(Object.entries(cache).filter(([, v]) => v && now - Number(v.at || 0) < MAX_AGE_MS).slice(-200));
    storage.set(STORAGE_KEYS.adCheckCache, trimmed);
};

/**
 * Tanya backend (yang menanyakan AdGuard DNS) apakah host-host ini domain iklan.
 * Fail-open: tanpa backend/DNS, hasilnya objek kosong dan pemutaran tidak terpengaruh.
 * @param {string[]} hosts
 * @param {{timeout?: number}} [opts]
 * @returns {Promise<Record<string, boolean|null>>}
 */
export async function checkHosts(hosts = [], { timeout = 4000 } = {}) {
    const wanted = [...new Set(hosts.map((h) => String(h || '').trim().toLowerCase()).filter(Boolean))];
    if (!wanted.length) return {};
    const cache = readCache();
    const now = Date.now();
    const fresh = {};
    const missing = [];
    for (const host of wanted) {
        const hit = cache[CACHE_KEY + host];
        if (hit && now - Number(hit.at || 0) < MAX_AGE_MS) fresh[host] = Boolean(hit.blocked);
        else missing.push(host);
    }
    if (!missing.length) return fresh;

    const base = API_CONFIG.backend;
    if (!base.enabled) return fresh;
    try {
        const query = encodeURIComponent(missing.slice(0, 20).join(','));
        const res = await fetch(`${base.baseUrl || ''}/api/ads/check?host=${query}`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const hostsResult = json?.data?.hosts;
        if (!hostsResult || typeof hostsResult !== 'object') throw new Error('bentuk respons tidak dikenal');
        for (const [host, info] of Object.entries(hostsResult)) {
            if (info?.blocked === true || info?.blocked === false) {
                cache[CACHE_KEY + host] = { blocked: Boolean(info.blocked), at: now };
                fresh[host] = Boolean(info.blocked);
            }
        }
        writeCache(cache);
    } catch {
        // backend mati / DNS AdGuard tidak terjangkau → tidak ada info, bukan error pengguna
    }
    return fresh;
}

/**
 * Tandai server dengan `adRisk` (true = host ada di daftar blokir AdGuard DNS).
 * Hanya memberi peringatan; server tetap bisa dipilih (host video sah bisa ikut terdaftar).
 * @template {{url?: string}} T
 * @param {T[]} servers
 * @returns {Promise<T[]>}
 */
export async function annotateRisk(servers = []) {
    const list = Array.isArray(servers) ? servers : [];
    const hosts = list
        .filter((s) => /^https?:\/\//i.test(String(s?.url || '')))
        .map((s) => {
            try { return new URL(s.url).hostname; } catch { return ''; }
        })
        .filter(Boolean);
    if (!hosts.length) return list;
    const result = await checkHosts(hosts);
    if (!Object.keys(result).length) return list;
    return list.map((server) => {
        try {
            const host = new URL(server.url).hostname.toLowerCase();
            return Object.prototype.hasOwnProperty.call(result, host) ? { ...server, adRisk: Boolean(result[host]) } : server;
        } catch {
            return server;
        }
    });
}
