/**
 * Kazanime — ui/subindo-state.js (23 Okt 2026)
 * Aturan teks panel Sub Indo **tanpa DOM**, supaya bisa diuji lewat `node --test`.
 * `js/home.js` hanya merender hasilnya; semua keputusan label/diagnosis ada di sini.
 *
 * Alasan pemisahan: panel yang gagal dulu menampilkan kotak kosong besar
 * ("Sumber belum dapat dimuat") padahal kalimat yang sama sudah ada di kepala
 * panel. Sekarang panel tanpa judul terverifikasi memakai satu baris ringkas
 * dengan diagnosis + tindakan yang jelas.
 */
import { friendlyError } from '../api/http.js';

/** Jenis error yang berarti pemeriksaan DIHENTIKAN karena kebijakan situs (bukan halaman rusak). */
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
 * @param {{error?: any, timedOut?: boolean, failedChecks?: number, stale?: boolean}} source
 * @param {number} count jumlah judul terverifikasi yang tampil
 */
export function sourceStatusLabel(source, count = 0) {
    const items = Number(count) || 0;
    if (source?.error) return isPolicyStop(source) ? 'Akses dibatasi' : 'Sumber bermasalah';
    if (source?.timedOut) return 'Batas waktu';
    if (Number(source?.failedChecks) > 0) return 'Sebagian dicek';
    if (source?.stale) return 'Data cache';
    return items > 0 ? `${items} terverifikasi` : 'Belum ada terverifikasi';
}

/**
 * Satu kalimat diagnosis untuk panel tanpa judul terverifikasi.
 * Pesan backend dipakai apa adanya lewat `friendlyError` agar sebabnya spesifik.
 */
export function sourceDiagnosis(source) {
    if (source?.error) return friendlyError(source.error);
    if (source?.timedOut) return 'Batas waktu tercapai sebelum bukti Sub Indo ditemukan; coba lagi untuk memeriksa ulang.';
    if (Number(source?.failedChecks) > 0) {
        return 'Pemeriksaan server episode gagal; judul tanpa bukti subtitle Indonesia tidak ditampilkan.';
    }
    if (source?.stale) return 'Menampilkan cache karena feed belum berhasil diperbarui.';
    return 'Tidak ada episode terbaru dari situs ini yang terkonfirmasi memiliki subtitle Indonesia.';
}

/**
 * Rekap penyebab kegagalan lintas panel: kalimat diagnosis yang sama digabung
 * sekali, lalu daftar situs yang mengalaminya.
 * @param {Array<object>} sections
 * @returns {{count:number, causes:Array<{message:string,names:string[]}>, text:string}}
 */
export function issuesSummary(sections) {
    const causes = [];
    const byMessage = new Map();
    const add = (message, name) => {
        if (!message) return;
        const found = byMessage.get(message);
        if (found) {
            if (!found.names.includes(name)) found.names.push(name);
            return;
        }
        const cause = { message, names: [name] };
        byMessage.set(message, cause);
        causes.push(cause);
    };

    let count = 0;
    (Array.isArray(sections) ? sections : []).forEach((source) => {
        const name = String(source?.name || source?.id || 'sumber');
        const failedChecks = Number(source?.failedChecks) || 0;
        if (!source?.error && !source?.timedOut && failedChecks <= 0) return;
        count++;
        if (source.error) add(sourceDiagnosis(source), name);
        else if (source.timedOut) add('Batas waktu verifikasi tercapai.', name);
        else add('Sebagian episode belum bisa diperiksa.', name);
    });

    if (!count) return { count: 0, causes, text: '' };
    const detail = causes
        .map((cause) => `${cause.message} (${cause.names.join(', ')})`)
        .join(' · ');
    return {
        count,
        causes,
        text: `Penyebab: ${detail} Judul tanpa bukti Sub Indo tidak ditampilkan.`,
    };
}
