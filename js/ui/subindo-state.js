/**
 * Kazanime — ui/subindo-state.js (disederhanakan 24 Okt 2026)
 * Aturan teks panel Sub Indo **tanpa DOM**, supaya bisa diuji lewat `node --test`.
 * `js/home.js` hanya merender hasilnya; keputusan label/diagnosis ada di sini.
 *
 * Verifikasi per episode sudah dihapus (permintaan pengguna): panel menampilkan
 * katalog AnimeKu/Oploverz apa adanya. Jadi label hanya menghitung judul dan
 * menjelaskan kegagalan jaringan/kebijakan situs — tidak ada "tanpa bukti",
 * "sebagian dicek", atau batas waktu.
 */
import { friendlyError } from '../api/http.js';

/** Jenis error yang berarti situs membatasi akses otomatis (bukan halaman rusak). */
const POLICY_KINDS = Object.freeze(['blocked', 'policy', 'rate_limited', 'robots']);

/** true = situs membatasi akses otomatis; bukan berarti halamannya rusak. */
export function isPolicyStop(source) {
    const kind = String(source?.error?.kind || '');
    return POLICY_KINDS.includes(kind);
}

/** Hanya URL http(s) yang boleh dirender menjadi tautan "Buka situs". */
export function safeHomeUrl(url) {
    const value = String(url || '').trim();
    return /^https?:\/\/[^\s"'<>\\]+$/i.test(value) ? value : '';
}

/**
 * Label chip di kepala panel.
 * @param {{error?: any, stale?: boolean}} source
 * @param {number} count jumlah judul yang tampil
 */
export function sourceStatusLabel(source, count = 0) {
    const items = Number(count) || 0;
    if (!items && source?.error) return isPolicyStop(source) ? 'Akses dibatasi' : 'Sumber bermasalah';
    if (source?.stale) return `${items} judul · cache`;
    return `${items} judul`;
}

/**
 * Satu kalimat diagnosis untuk panel tanpa judul.
 * Pesan backend dipakai apa adanya lewat `friendlyError` agar sebabnya spesifik.
 */
export function sourceDiagnosis(source) {
    if (source?.error) return friendlyError(source.error);
    if (source?.stale) return 'Menampilkan cache karena feed belum berhasil diperbarui.';
    return 'Situs tidak mengirim judul untuk panel ini saat halaman diperiksa.';
}
