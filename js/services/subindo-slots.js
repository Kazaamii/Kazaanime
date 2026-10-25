/**
 * Kazanime — services/subindo-slots.js
 * Dua tombol server Sub Indo (AnimeKu & Animeloverz) SELALU tampil — putaran 16 (24 Okt 2026).
 *
 * Permintaan pengguna: *"mana server sub indo nya kembalikan"*. Penyebabnya bukan tombol yang
 * dihapus: bila backend tidak bisa menjangkau AnimeKu/Oploverz (sumber mati, jaringan server,
 * episode belum ada), daftar server hanya berisi server luar — tombol Sub Indo seolah hilang.
 *
 * Aturan:
 *  - Daftar server Sub Indo selalu berisi **dua** entri, urut AnimeKu → Animeloverz.
 *  - Server asli dari backend dipakai apa adanya. Situs yang tidak mengirim server diisi
 *    *placeholder* (`available:false`, `placeholder:true`, `url:null`) dengan alasan yang jelas,
 *    sehingga tombolnya tetap terlihat dan bisa diklik untuk mencari ulang.
 *  - Placeholder tidak pernah diputar otomatis (`available:false`) dan tidak punya URL, jadi
 *    tidak bisa membuka halaman apa pun tanpa sengaja.
 *
 * Putaran 25 (25 Okt 2026) — permintaan pengguna: *"untuk Oploverz bisa di upayakan agar tidak
 * bertabrakan kasih tombol opsi saja jadi oploverz punya 2 server"*.
 *
 * Oploverz/Animeloverz mengirim **dua** server untuk satu episode (`HD-1`, `HD-2`). Menambah
 * tombol situs kedua akan melanggar aturan "tepat dua tombol Sub Indo" (putaran 16), jadi kedua
 * server digabung menjadi **satu slot + opsi**:
 *
 *   { id: 'backend-oploverz-0', name: 'Animeloverz', url: <HD-1>,
 *     mirrors: [<HD-1>, <HD-2>], mirrorLabels: ['HD-1', 'HD-2'],
 *     options: [{ label: 'HD-1', url: <HD-1> }, { label: 'HD-2', url: <HD-2> }] }
 *
 * `mirrors` sudah dipakai pemutar untuk mencoba URL berikutnya bila yang sekarang gagal, dan
 * `options` dipakai halaman nonton untuk menampilkan dropdown pilihan server situs itu.
 */
import { PLAYER } from '../config.js';

/** Situs Sub Indo + urutan tombolnya: AnimeKu lalu Animeloverz. */
export const SUB_INDO_SITES = Object.freeze(['animeku', 'oploverz']);

/** Keterangan pada tombol saat sumber tidak mengirim server untuk episode ini. */
export const SUB_INDO_OFFLINE_REASON = 'Sumber sedang tidak terjangkau. Klik untuk mencari ulang server Sub Indo.';

/** Badge kecil di tombol placeholder. */
export const SUB_INDO_OFFLINE_BADGE = 'tidak terjangkau';

/** Batas jumlah opsi per situs (localStorage & UI tetap kecil). */
export const MAX_SITE_OPTIONS = 4;

/**
 * Situs asal server: `backend:animeku` / `animeku~slug` → `animeku`.
 * @param {{source?: string}|null} server
 * @returns {string}
 */
export function subIndoSiteOf(server) {
    return String(server?.source || '').replace(/^backend:/, '').split('~')[0].toLowerCase();
}

/**
 * Label opsi satu server: nama server dari situs (`HD-1`, `HD-2`, …); bila kosong dipakai
 * nama situs + nomor urut supaya dropdown tidak pernah berisi label kosong.
 * @param {{name?: string}|null} server
 * @param {number} index
 */
function optionLabel(server, index) {
    const name = String(server?.name || '').trim();
    return name ? name.slice(0, 24) : `Server ${index + 1}`;
}

/**
 * Daftar opsi satu server: `[{ label, url }]`. Server yang sudah punya `options` (mis. hasil
 * penggabungan) diteruskan apa adanya.
 * @param {{url?: string, name?: string, options?: {label: string, url: string}[]}} server
 * @returns {{label: string, url: string}[]}
 */
function optionsOf(server) {
    if (Array.isArray(server?.options) && server.options.length) {
        return server.options.filter((option) => option && option.url).slice(0, MAX_SITE_OPTIONS);
    }
    const url = String(server?.url || '');
    return url ? [{ label: optionLabel(server, 0), url }] : [];
}

/**
 * Gabungkan semua server milik satu situs menjadi **satu slot** dengan `options`.
 * Slot pertama mempertahankan id/description server pertama; URL tambahan menjadi opsi.
 * @param {object[]} list server satu situs (boleh kosong)
 * @returns {object|null}
 */
function mergeSite(list) {
    const all = (Array.isArray(list) ? list : []).filter(Boolean);
    if (!all.length) return null;
    const options = [];
    for (const server of all) {
        for (const option of optionsOf(server)) {
            if (options.length >= MAX_SITE_OPTIONS) break;
            // Dua opsi dengan URL identik memutar berkas yang sama → cukup satu.
            if (options.some((kept) => kept.url === option.url)) continue;
            options.push({ label: option.label, url: option.url });
        }
    }
    const primary = all[0];
    if (!options.length) return primary;
    // Satu server saja → objek aslinya dikembalikan apa adanya (identitas & perilaku lama
    // dipertahankan; tes putaran 16 membandingkan objeknya langsung).
    if (options.length === 1) return primary;
    const [first, ...rest] = options;
    return {
        ...primary,
        name: primary.name,
        url: first.url,
        mirrors: options.map((option) => option.url),
        mirrorLabels: options.map((option) => option.label),
        options,
        // Jumlah opsi berguna untuk badge/aria tanpa membuka array.
        optionCount: options.length,
        // Server kedua dst. sudah diwakili `options`, jadi tidak ikut dirender sebagai tombol.
        ...(rest.length ? { hasOptions: true } : {}),
    };
}

/**
 * Server pengganti untuk situs Sub Indo yang tidak mengirim data.
 * @param {string} site `animeku` | `oploverz`
 */
export function subIndoPlaceholder(site) {
    const id = String(site || '').toLowerCase();
    return {
        id: `subindo-${id}-offline`,
        name: PLAYER.siteLabels?.[id] || id,
        flag: '',
        description: SUB_INDO_OFFLINE_REASON,
        badge: '',
        url: null,
        available: false,
        pending: false,
        placeholder: true,
        site: id,
        reason: SUB_INDO_OFFLINE_REASON,
        source: `backend:${id}`,
        lang: 'id',
        origins: [],
        kind: 'embed',
        mirrors: null,
    };
}

/**
 * Satu slot per situs Sub Indo, dengan semua server situs itu sebagai `options`.
 * @param {object[]} list server Sub Indo hasil scraping (boleh kosong)
 * @param {{sites?: readonly string[]}} [opts]
 * @returns {Record<string, object>} peta situs → slot
 */
export function siteSlots(list = [], { sites = SUB_INDO_SITES } = {}) {
    const bySite = new Map();
    for (const server of Array.isArray(list) ? list : []) {
        const site = subIndoSiteOf(server);
        if (!site || !sites.includes(site)) continue;
        if (!bySite.has(site)) bySite.set(site, []);
        bySite.get(site).push(server);
    }
    const out = {};
    for (const site of sites) out[site] = mergeSite(bySite.get(site));
    return out;
}

/**
 * Lengkapi daftar server Sub Indo supaya selalu berisi dua situs, urut `SUB_INDO_SITES`.
 * Server dari situs yang sama digabung menjadi satu slot ber-opsi (putaran 25).
 * @param {object[]} list server Sub Indo hasil scraping (boleh kosong)
 * @param {{sites?: readonly string[]}} [opts]
 * @returns {object[]} tepat satu entri per situs pada `SUB_INDO_SITES`
 */
export function fillSubIndoServers(list = [], { sites = SUB_INDO_SITES } = {}) {
    const slots = siteSlots(list, { sites });
    return sites.map((site) => slots[site] || subIndoPlaceholder(site));
}
