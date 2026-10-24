/**
 * Kazanime — services/subindo-slots.js
 * Dua tombol server Sub Indo (AnimeKu & Animeloverz) SELALU tampil — putaran 16 (24 Okt 2026).
 *
 * Permintaan pengguna: *"mana server sub indo nya kembalikan"*. Penyebabnya bukan tombol yang
 * dihapus: bila backend tidak bisa menjangkau AnimeKu/Oploverz (sumber mati, jaringan server,
 * episode belum ada), daftar server hanya berisi server luar — tombol Sub Indo seolah hilang.
 *
 * Aturan baru:
 *  - Daftar server Sub Indo selalu berisi **dua** entri, urut AnimeKu → Animeloverz.
 *  - Server asli dari backend dipakai apa adanya. Situs yang tidak mengirim server diisi
 *    *placeholder* (`available:false`, `placeholder:true`, `url:null`) dengan alasan yang jelas,
 *    sehingga tombolnya tetap terlihat dan bisa diklik untuk mencari ulang.
 *  - Placeholder tidak pernah diputar otomatis (`available:false`) dan tidak punya URL, jadi
 *    tidak bisa membuka halaman apa pun tanpa sengaja.
 */
import { PLAYER } from '../config.js';

/** Situs Sub Indo + urutan tombolnya: AnimeKu lalu Animeloverz. */
export const SUB_INDO_SITES = Object.freeze(['animeku', 'oploverz']);

/** Keterangan pada tombol saat sumber tidak mengirim server untuk episode ini. */
export const SUB_INDO_OFFLINE_REASON = 'Sumber sedang tidak terjangkau. Klik untuk mencari ulang server Sub Indo.';

/** Badge kecil di tombol placeholder. */
export const SUB_INDO_OFFLINE_BADGE = 'tidak terjangkau';

/**
 * Situs asal server: `backend:animeku` / `animeku~slug` → `animeku`.
 * @param {{source?: string}|null} server
 * @returns {string}
 */
export function subIndoSiteOf(server) {
    return String(server?.source || '').replace(/^backend:/, '').split('~')[0].toLowerCase();
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
 * Lengkapi daftar server Sub Indo supaya selalu berisi dua situs, urut `SUB_INDO_SITES`.
 * Server asli dipertahankan (satu per situs); situs yang kosong diisi placeholder.
 * @param {object[]} list server Sub Indo hasil scraping (boleh kosong)
 * @param {{sites?: readonly string[]}} [opts]
 * @returns {object[]} tepat satu entri per situs pada `SUB_INDO_SITES`
 */
export function fillSubIndoServers(list = [], { sites = SUB_INDO_SITES } = {}) {
    const bySite = new Map();
    for (const server of Array.isArray(list) ? list : []) {
        const site = subIndoSiteOf(server);
        if (!site || bySite.has(site)) continue;
        bySite.set(site, server);
    }
    return sites.map((site) => bySite.get(site) || subIndoPlaceholder(site));
}
