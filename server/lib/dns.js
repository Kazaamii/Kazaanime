/**
 * Kazanime backend — lib/dns.js
 * Pemeriksa reputasi host lewat DNS AdGuard (DoH) — putaran 11 (24 Okt 2026).
 *
 * Pengguna meminta: *"gunakan dns seperti ini https://dns.adguard.com/dns-query"*.
 *
 * Fakta teknis (penting, ditulis juga di UI):
 *  - Halaman web tidak bisa mengubah resolver DNS milik pengunjung. Bila tujuan utamanya
 *    "tidak ada iklan di perangkat saya", DNS harus diatur di perangkat/router (panduan ada
 *    di aplikasi, tombol "Panduan AdGuard DNS").
 *  - Yang BISA dilakukan server: menanyakan **daftar blokir AdGuard** untuk sebuah host, lalu
 *    memberi tahu frontend bahwa host itu domain iklan/tracker. Hasilnya dipakai sebagai
 *    peringatan + urutan server (tidak dipaksakan), supaya host video yang sah tidak ikut mati.
 *
 * Protokol: DoH JSON (`?name=host&type=A`, header `accept: application/dns-json`), format yang
 * dipakai AdGuard/Cloudflare/Google. Jawaban `Status: 0` tanpa Answer, atau Answer berisi
 * 0.0.0.0 / ::, berarti diblokir daftar blokir.
 *
 * Seluruh modul fail-open: bila DoH tidak terjangkau (offline/firewall), hasilnya `null`
 * ("tidak diketahui") dan fitur lain tetap berjalan. Tidak ada retry agresif.
 */
import { ADS } from '../config.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;      // hasil valid 6 jam
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;   // DoH gagal → berhenti mencoba 10 menit
const MAX_ENTRIES = 500;

/**
 * @param {{
 *   endpoint?: string, enabled?: boolean, timeoutMs?: number, cacheTtlMs?: number,
 *   fetchImpl?: typeof fetch, now?: () => number,
 * }} [opts]
 */
export function createDnsFilter({
    endpoint = ADS.dohEndpoint,
    enabled = ADS.dnsCheck,
    timeoutMs = ADS.dnsTimeoutMs,
    cacheTtlMs = CACHE_TTL_MS,
    fetchImpl = globalThis.fetch,
    now = Date.now,
} = {}) {
    /** @type {Map<string, {blocked: boolean|null, at: number, reason?: string}>} */
    const cache = new Map();
    let downUntil = 0;
    let requests = 0;
    let failures = 0;

    /** @param {string} host */
    const normalize = (host) => String(host || '').trim().toLowerCase().replace(/\.$/, '');

    /**
     * Cek satu host. `null` = tidak diketahui (fitur mati, DoH gagal, atau cooldown).
     * @param {string} host
     * @returns {Promise<boolean|null>}
     */
    async function isBlocked(host) {
        const name = normalize(host);
        if (!enabled || !name || !/^[a-z0-9.-]+$/.test(name) || name.length > 253) return null;

        const hit = cache.get(name);
        if (hit && now() - hit.at < cacheTtlMs) return hit.blocked;
        if (now() < downUntil) return null;

        requests += 1;
        try {
            const url = `${endpoint}?name=${encodeURIComponent(name)}&type=A`;
            const res = await fetchImpl(url, {
                method: 'GET',
                headers: { accept: 'application/dns-json' },
                signal: AbortSignal.timeout(timeoutMs),
                cache: 'no-store',
            });
            if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
            const json = await res.json();
            const answers = Array.isArray(json?.Answer) ? json.Answer : [];
            const status = Number(json?.Status);
            // NXDOMAIN/REFUSED dari resolver penyaring = diblokir; tanpa Answer juga.
            const blocked = status !== 0
                || answers.length === 0
                || answers.every((a) => ['0.0.0.0', '::', '::1'].includes(String(a?.data || '').trim()));
            remember(name, blocked);
            return blocked;
        } catch {
            failures += 1;
            downUntil = now() + FAILURE_COOLDOWN_MS;
            return null;
        }
    }

    /** @param {string} name @param {boolean|null} blocked */
    function remember(name, blocked) {
        if (cache.size >= MAX_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(name, { blocked, at: now() });
    }

    return {
        /** Cek satu host (dipakai tes & pemanggil internal). `null` = tidak diketahui. */
        isBlocked,
        get enabled() {
            return enabled && now() >= downUntil;
        },
        get endpoint() {
            return endpoint;
        },
        /**
         * Cek banyak host sekaligus (maks 20) tanpa menggagalkan satu sama lain.
         * @param {string[]} hosts
         * @returns {Promise<Record<string, boolean|null>>}
         */
        async checkMany(hosts = []) {
            const unique = [...new Set((Array.isArray(hosts) ? hosts : []).map(normalize).filter(Boolean))].slice(0, 20);
            /** @type {Record<string, boolean|null>} */
            const out = {};
            await Promise.all(unique.map(async (host) => {
                out[host] = await isBlocked(host);
            }));
            return out;
        },
        status() {
            return {
                enabled,
                endpoint,
                coolingDown: now() < downUntil,
                requests,
                failures,
                cached: cache.size,
            };
        },
        /** Dipakai unit test: isi cache secara langsung tanpa jaringan. */
        __remember: remember,
    };
}
