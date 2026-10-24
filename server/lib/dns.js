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
 * Protokol: **DoH wireformat RFC 8484** ke `https://dns.adguard.com/dns-query` (POST
 * `application/dns-message` berisi paket DNS biner) — endpoint yang diminta pengguna memang
 * wireformat, bukan JSON; permintaan `?name=…` ke sana dijawab "no 'dns' query parameter found".
 * Bila endpoint itu tidak menjawab, dipakai **JSON** AdGuard `https://dns.adguard.com/resolve?name=…&type=A`.
 * Jawaban `Status: 0` tanpa Answer, atau Answer berisi 0.0.0.0 / ::, berarti diblokir daftar blokir.
 *
 * Seluruh modul fail-open: bila DoH tidak terjangkau (offline/firewall), hasilnya `null`
 * ("tidak diketahui") dan fitur lain tetap berjalan. Tidak ada retry agresif.
 */
import { ADS } from '../config.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;      // hasil valid 6 jam
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;   // DoH gagal → berhenti mencoba 10 menit
const MAX_ENTRIES = 500;

/* ------------------------------------------------------------------ */
/* Wireformat DNS (RFC 1035 / RFC 8484)                                */
/* ------------------------------------------------------------------ */

/**
 * Bangun paket DNS query tipe A untuk satu host.
 * @param {string} host
 * @param {number} [id] pengenal 16-bit (acak bila kosong)
 * @returns {Uint8Array}
 */
export function buildDnsQuery(host, id = Math.floor(Math.random() * 0xffff)) {
    const labels = String(host || '').replace(/\.$/, '').split('.').filter(Boolean);
    const size = 12 + labels.reduce((n, label) => n + 1 + Buffer.byteLength(label), 0) + 1 + 4;
    const buf = Buffer.alloc(size);
    buf.writeUInt16BE(id & 0xffff, 0);
    buf.writeUInt16BE(0x0100, 2); // RD (recursion desired)
    buf.writeUInt16BE(1, 4);      // QDCOUNT
    let offset = 12;
    for (const label of labels) {
        const bytes = Buffer.from(label, 'utf8');
        buf.writeUInt8(bytes.length, offset);
        bytes.copy(buf, offset + 1);
        offset += bytes.length + 1;
    }
    buf.writeUInt8(0, offset);    // akar
    offset += 1;
    buf.writeUInt16BE(1, offset); // QTYPE A
    buf.writeUInt16BE(1, offset + 2); // QCLASS IN
    return new Uint8Array(buf);
}

/**
 * Baca jawaban DNS biner → `{ status, addresses }`.
 * Hanya butuh bagian header, question, dan record A/AAAA.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{status: number, answers: number, addresses: string[]}}
 */
export function parseDnsResponse(data) {
    const buf = Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));
    if (buf.length < 12) throw new Error('Jawaban DNS terlalu pendek');
    const status = buf.readUInt16BE(2) & 0x0f; // RCODE
    const qdcount = buf.readUInt16BE(4);
    const ancount = buf.readUInt16BE(6);
    let offset = 12;
    /** Lewati satu nama (label atau pointer kompresi). */
    const skipName = () => {
        while (offset < buf.length) {
            const len = buf.readUInt8(offset);
            if (len === 0) { offset += 1; return; }
            if ((len & 0xc0) === 0xc0) { offset += 2; return; }
            offset += len + 1;
        }
        throw new Error('Nama DNS tidak lengkap');
    };
    for (let i = 0; i < qdcount; i += 1) {
        skipName();
        offset += 4; // QTYPE + QCLASS
    }
    /** @type {string[]} */
    const addresses = [];
    for (let i = 0; i < ancount && offset + 10 <= buf.length; i += 1) {
        skipName();
        const type = buf.readUInt16BE(offset);
        const rdlength = buf.readUInt16BE(offset + 8);
        const rdata = offset + 10;
        if (type === 1 && rdlength === 4) {
            addresses.push(`${buf[rdata]}.${buf[rdata + 1]}.${buf[rdata + 2]}.${buf[rdata + 3]}`);
        } else if (type === 28 && rdlength === 16) {
            const groups = [];
            for (let g = 0; g < 16; g += 2) groups.push(buf.readUInt16BE(rdata + g).toString(16));
            addresses.push(groups.join(':'));
        }
        offset = rdata + rdlength;
    }
    return { status, answers: ancount, addresses };
}

/** Apakah hasil DNS berarti "diblokir daftar blokir"? */
export const isBlockedResult = (status, answers, addresses) => status !== 0
    || !answers
    || addresses.every((ip) => ['0.0.0.0', '::', '::1'].includes(String(ip).trim()));

/**
 * @param {{
 *   endpoint?: string, jsonEndpoint?: string|null, enabled?: boolean, timeoutMs?: number,
 *   cacheTtlMs?: number, fetchImpl?: typeof fetch, now?: () => number,
 * }} [opts]
 */
export function createDnsFilter({
    endpoint = ADS.dohEndpoint,
    jsonEndpoint = ADS.dnsJsonEndpoint || null,
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
            const result = await query(name);
            remember(name, result);
            return result;
        } catch {
            failures += 1;
            downUntil = now() + FAILURE_COOLDOWN_MS;
            return null;
        }
    }

    /**
     * Tanya resolver: wireformat dulu (URL yang diminta pengguna), lalu JSON sebagai cadangan.
     * @param {string} name
     * @returns {Promise<boolean>}
     */
    async function query(name) {
        try {
            return await queryWire(name);
        } catch (wireError) {
            if (!jsonEndpoint || jsonEndpoint === endpoint) throw wireError;
            return queryJson(name);
        }
    }

    /** DoH wireformat RFC 8484: POST paket DNS biner ke {endpoint}. */
    async function queryWire(name) {
        const res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { accept: 'application/dns-message', 'content-type': 'application/dns-message' },
            body: buildDnsQuery(name),
            signal: AbortSignal.timeout(timeoutMs),
            cache: 'no-store',
        });
        if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
        const parsed = parseDnsResponse(await res.arrayBuffer());
        return isBlockedResult(parsed.status, parsed.answers, parsed.addresses);
    }

    /** JSON API (AdGuard `/resolve`, Cloudflare/Google `?name=`). */
    async function queryJson(name) {
        const res = await fetchImpl(`${jsonEndpoint}?name=${encodeURIComponent(name)}&type=A`, {
            method: 'GET',
            headers: { accept: 'application/dns-json' },
            signal: AbortSignal.timeout(timeoutMs),
            cache: 'no-store',
        });
        if (!res.ok) throw new Error(`DoH(JSON) HTTP ${res.status}`);
        const json = await res.json();
        const answers = Array.isArray(json?.Answer) ? json.Answer : [];
        return isBlockedResult(Number(json?.Status), answers.length, answers.map((a) => a?.data));
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
                jsonEndpoint,
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
