/**
 * Kazanime — katalog Sub Indo per situs untuk beranda.
 *
 * 24 Okt 2026 (permintaan pengguna): **verifikasi per episode dihapus**. AnimeKu dan
 * Oploverz adalah situs Sub Indo dengan ekosistemnya sendiri; katalognya ditampilkan
 * apa adanya — tanpa pencocokan bukti, tanpa batas waktu, tanpa menyembunyikan judul
 * yang "belum terbukti". Panel beranda cukup menampilkan judul yang dikirim backend.
 *
 * Server tetap menandai `subtitleEvidence` pada data episode (dipakai halaman nonton
 * dan `npm run check:subindo`), tetapi beranda tidak menunggu pemeriksaan apa pun.
 */
import { SUB_INDO } from '../config.js';

/**
 * Panel yang boleh tampil di beranda: AnimeKu & Oploverz saja (23 Okt 2026).
 * Backend sudah menentukan daftar panel lewat `SUB_INDO_LATEST_SOURCE_ORDER`; filter ini
 * adalah jaring pengaman untuk respons lama yang masih tersimpan di cache CDN/browser
 * (atau panel yang diminta manual) supaya sumber lama (Samehadaku/Sakunime/Otakudesu,
 * serta Kuramanime/Anichin yang sudah dihapus) tidak muncul lagi.
 */
export const PANEL_SOURCE_IDS = Object.freeze(['animeku', 'oploverz']);
const PANEL_SOURCE_SET = new Set(PANEL_SOURCE_IDS);

const normalizeId = (value) => String(value || '').trim().toLowerCase();

/** Saring daftar section feed ke panel yang masih dipakai. */
export function panelSections(sections) {
    return (Array.isArray(sections) ? sections : [])
        .filter((source) => PANEL_SOURCE_SET.has(normalizeId(source?.id)));
}

const dedupeKey = (item) => String(item?.slug || item?.title || '').trim().toLowerCase();

/**
 * Kelompokkan katalog backend menjadi panel beranda tanpa pemeriksaan episode.
 * @param {{sections?: Array<object>}} catalog hasil `getLatestSubIndoBySource()`
 * @param {{sourceIds?: string[], limit?: number}} [opts]
 *   sourceIds: batasi ke situs tertentu (tombol "Coba lagi" per panel).
 * @returns {Array<{id:string,name:string,homeUrl:string,stale:boolean,error:object|null,
 *   browse:boolean,total:number,items:Array<object>}>}
 */
export function groupSubIndoSources(catalog, { sourceIds = null, limit = SUB_INDO.resultLimit } = {}) {
    const only = Array.isArray(sourceIds) && sourceIds.length
        ? new Set(sourceIds.map(normalizeId).filter(Boolean))
        : null;
    const max = Math.max(1, Math.min(Number(limit) || SUB_INDO.resultLimit, 120));
    return panelSections(catalog?.sections)
        .filter((source) => (only ? only.has(normalizeId(source.id)) : true))
        .map((source) => {
            const seen = new Set();
            const items = (Array.isArray(source.items) ? source.items : []).filter((item) => {
                if (!item || !item.title) return false;
                const key = dedupeKey(item);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            return {
                id: normalizeId(source.id),
                name: String(source.name || source.id),
                homeUrl: String(source.homeUrl || ''),
                stale: Boolean(source.stale),
                error: source.error || null,
                browse: Boolean(source.browse),
                total: items.length,
                items: items.slice(0, max),
            };
        });
}

/**
 * Ambil panel Sub Indo dari backend, tanpa verifikasi episode.
 * `getSources` diinjeksi supaya modul ini bisa diuji tanpa jaringan.
 * @param {{getSources: Function, signal?: AbortSignal, sourceIds?: string[], refresh?: boolean}} opts
 * @returns {Promise<{sections: Array<object>, unavailable: boolean}>}
 */
export async function loadSubIndoSources({ getSources, signal, sourceIds, refresh = false } = {}) {
    if (typeof getSources !== 'function') throw new TypeError('getSources wajib berupa fungsi.');
    const catalog = await getSources({ signal, refresh });
    if (!catalog || catalog.fallback) return { sections: [], unavailable: true };
    return { sections: groupSubIndoSources(catalog, { sourceIds }), unavailable: false };
}
