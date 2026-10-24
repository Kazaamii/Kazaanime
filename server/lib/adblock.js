/**
 * Kazanime backend — lib/adblock.js
 * Penyaring domain iklan (putaran 11, 24 Okt 2026).
 *
 * Permintaan pengguna: *"iklan masih saja muncul dan memaksa new tab … gunakan dns seperti
 * ini (https://dns.adguard.com/dns-query) atau terapkan di web saya agar tidak ada iklan"*.
 *
 * Yang bisa dan tidak bisa dilakukan sebuah situs web (dijelaskan jujur):
 *  - Halaman web TIDAK bisa mengubah DNS perangkat pengunjung; DNS diatur di perangkat/router.
 *  - Yang bisa dilakukan: (a) tidak pernah memuat URL yang jelas-jelas jaringan iklan /
 *    gateway klik, (b) menolak pop-up lewat sandbox opt-in, (c) memulihkan pemutar bila iklan
 *    membajak iframe, (d) memberi panduan DNS AdGuard untuk perangkat pengguna.
 *
 * Modul ini mengerjakan (a): daftar pola domain + bentuk URL gateway iklan. Daftar dibuat
 * konservatif — hanya jaringan iklan/tracker dan pola "klik iklan" yang sangat khas — supaya
 * host video yang sah (mis. puterin.biz, megaplay.buzz) TIDAK ikut tersaring.
 */

/**
 * Domain/subdomain jaringan iklan, tracker, dan gateway klik yang umum dipakai host embed.
 * Dicocokkan sebagai akhiran host (`endsWith`) supaya `ads.example.com` ikut tertangkap.
 * @type {readonly string[]}
 */
export const AD_HOSTS = Object.freeze([
    // Google / Microsoft / besar
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
    'adsystem.com', 'amazon-adsystem.com', 'adnxs.com', 'criteo.com', 'criteo.net',
    'taboola.com', 'outbrain.com', 'revcontent.com', 'mgid.com', 'zergnet.com',
    // Jaringan popunder/pop-up yang sering menempel di host video
    'popads.net', 'popcash.net', 'popmyads.com', 'popunder.net', 'popunders.net',
    'propellerads.com', 'propellerads.biz', 'propeller-network.com', 'onclickads.net',
    'adsterra.com', 'adsterra.net', 'hilltopads.net', 'hilltopads.com', 'adcash.com',
    'clickadilla.com', 'exoclick.com', 'exosrv.com', 'juicyads.com', 'trafficjunky.com',
    'trafficfactory.biz', 'a-ads.com', 'coinzilla.com', 'bitmedia.io', 'cointraffic.io',
    'ad-maven.com', 'admaven.com', 'clickaine.com', 'adnium.com', 'adspy.com',
    'monetag.com', 'onclickalgo.com', 'clickadu.com', 'adprovider.net', 'adpushup.com',
    // Tracker / analytics iklan yang tidak diperlukan pemutar
    'adroll.com', 'smartadserver.com', 'rubiconproject.com', 'pubmatic.com',
    'openx.net', 'sharethrough.com', 'teads.tv', 'spotxchange.com', 'yieldmo.com',
]);

/**
 * Pola jalur/query yang hampir selalu berarti "klik iklan" (bukan halaman pemutar).
 * Contoh nyata dari keluhan pengguna: `…/iclick?…` yang menjawab
 * `{"success":false,"reject_reason":"iclick link error"}`.
 * @type {readonly RegExp[]}
 */
export const AD_URL_PATTERNS = Object.freeze([
    /(?:^|[/?&._-])iclick(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])adclick(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])onclickads?(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])popunder(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])popads?(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])adsterra(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])clickadilla(?:[/?&._-]|$)/i,
    /(?:^|[/?&._-])directlink(?:[/?&._-]|$)/i,
    /\/ad(?:s|v|vert|vertisement)?\/(?:click|redirect|go|link|frame|banner)/i,
    /[?&](?:ad_?id|adzone|zoneid|aff_?id|affiliate_?id|click_?id|campaign_?id)=[^&]*/i,
]);

/**
 * Host iklan? `null` bila bukan.
 * @param {string} host
 * @returns {string|null} aturan yang cocok (untuk log/tes)
 */
export function adHostMatch(host) {
    const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
    if (!h) return null;
    return AD_HOSTS.find((rule) => h === rule || h.endsWith(`.${rule}`)) || null;
}

/**
 * URL ini menuju jaringan iklan / gateway klik?
 * @param {string} value
 * @returns {{blocked: boolean, reason?: string, rule?: string}}
 */
export function inspectAdUrl(value) {
    let url;
    try {
        url = new URL(String(value || ''));
    } catch {
        return { blocked: false };
    }
    if (!/^https?:$/.test(url.protocol)) return { blocked: true, reason: 'Protokol bukan http(s).' };
    const hostRule = adHostMatch(url.hostname);
    if (hostRule) return { blocked: true, reason: `Domain iklan: ${hostRule}`, rule: hostRule };
    const target = `${url.pathname}${url.search}`;
    const pattern = AD_URL_PATTERNS.find((rx) => rx.test(target));
    if (pattern) return { blocked: true, reason: 'URL berpola klik iklan.', rule: String(pattern) };
    return { blocked: false };
}

export const isAdUrl = (value) => inspectAdUrl(value).blocked;

/**
 * Saring daftar server streaming: buang yang URL-nya jelas iklan.
 * Server non-http (mis. URL proxy internal) dibiarkan — pemanggil sudah memvalidasi.
 * @template {{url?: string, kind?: string}} T
 * @param {T[]} servers
 * @returns {{servers: T[], blocked: {name?: string, url: string, reason: string}[]}}
 */
export function filterAdServers(servers = []) {
    const list = Array.isArray(servers) ? servers : [];
    const kept = [];
    const blocked = [];
    for (const server of list) {
        const url = String(server?.url || '');
        // Media milik sendiri (HLS lewat proxy /api/stream/...) bukan iklan.
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

/** Ringkasan untuk /api/health & /api/ads/status. */
export function adFilterSummary() {
    return { enabled: true, hosts: AD_HOSTS.length, patterns: AD_URL_PATTERNS.length };
}
