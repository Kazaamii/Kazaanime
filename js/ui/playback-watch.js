/**
 * Kazanime — ui/playback-watch.js
 * Pengawas pemutaran: mendeteksi video yang BERHENTI (buffering tanpa akhir) dan memutuskan
 * apa yang harus dilakukan — tanpa menyentuh DOM, supaya bisa diuji di Node.
 *
 * Putaran 27 (22 Nov 2026) — permintaan pengguna: *"Perbaiki Web Error kembali Stream selalu
 * bufering"*.
 *
 * Kenapa perlu pengawas terpisah:
 *  - `state = 'playing'` saat ini dipasang begitu iframe mengirim `load` atau `<video>` punya
 *    metadata. Pada embed pihak ketiga `load` hanya berarti "dokumen pemutar selesai dimuat",
 *    BUKAN "video berjalan". Bila embed menampilkan "This video file cannot be played" atau CDN
 *    berhenti mengirim segmen, pemutar tetap berstatus "playing" dan pengguna melihat buffering
 *    yang tidak pernah selesai.
 *  - hls.js hanya mengirim error FATAL setelah menyerah; kegagalan yang di-retry terus-menerus
 *    (mis. proxy membalas 504 berulang) tidak pernah dianggap gagal oleh player lama.
 *
 * Modul ini mengubahnya menjadi keputusan eksplisit:
 *  1. `stalled` → tidak ada kemajuan selama `stallTimeoutMs` → coba pulihkan (nudge / muat ulang
 *     sumber) sebelum menyimpulkan server rusak.
 *  2. `failed`  → server tidak mungkin dipulihkan → pindah server, bukan buffering diam.
 *
 * Waktu selalu diinjeksi (`now`) dan tidak ada timer yang dibuat di sini; pemanggil yang
 * menjalankan `tick()` — jadi tidak ada timer yatim saat episode/server berganti.
 */

/**
 * @typedef {'started'|'progress'|'stalled'|'failed'} WatchPhase
 * @typedef {{ phase: WatchPhase, reason: string, idleMs: number, actions: string[], detail?: any }} WatchEvent
 */

/**
 * @param {{
 *   stallTimeoutMs?: number,   batas diam setelah video sempat berjalan
 *   hardStallMs?: number,      batas diam total sebelum menyerah & pindah server
 *   startupTimeoutMs?: number, batas menunggu gambar pertama
 *   maxRecoveries?: number,    berapa kali boleh mencoba memulihkan sebelum pindah server
 *   failBeforeProgress?: boolean,
 *       `true`  (pemutar video bawaan): tidak ada kemajuan sejak awal = server rusak → pindah server.
 *       `false` (embed pihak ketiga): banyak embed TIDAK mengirim pesan progres sama sekali, jadi
 *       "belum ada kabar" bukan bukti rusak. Pengawas hanya memberi peringatan (aksi `hint`).
 *   autoRecover?: boolean,
 *       `true`  : diam terlalu lama → muat ulang sumber, lalu pindah server.
 *       `false` : JANGAN menyentuh pemutar. Dipakai untuk embed lintas-domain: kita tidak bisa
 *                 membedakan "buffering" dari "dijeda pengguna" atau "embed yang tidak melapor",
 *                 jadi mengambil keputusan otomatis justru merusak pemutaran.
 *   now?: () => number,
 *   onEvent?: (event: WatchEvent) => void,
 *   onRecover?: (event: WatchEvent) => void,
 * }} [opts]
 */
export function createPlaybackWatch({
    stallTimeoutMs = 12000,
    hardStallMs = 30000,
    startupTimeoutMs = 20000,
    maxRecoveries = 2,
    failBeforeProgress = true,
    autoRecover = true,
    now = Date.now,
    onEvent = () => {},
    onRecover = () => {},
} = {}) {
    let started = false;
    /** Sudah pernah benar-benar bergerak (currentTime bertambah)? */
    let moved = false;
    let lastProgressAt = 0;
    let startedAt = 0;
    let recoveries = 0;
    let stopped = false;
    let suspended = false;
    let announcedStall = false;

    const idleMs = () => Math.max(0, now() - (lastProgressAt || startedAt || now()));

    const emit = (phase, reason, extra = {}) => {
        if (stopped) return null;
        const event = { phase, reason, idleMs: idleMs(), actions: [], ...extra };
        try { onEvent(event); } catch { /* pengamat tidak boleh memutus pemutaran */ }
        return event;
    };

    const begin = (reason) => {
        started = true;
        startedAt = now();
        lastProgressAt = startedAt;
        moved = false;
        recoveries = 0;
        announcedStall = false;
        emit('started', reason);
    };

    const recovered = (phase, reason) => {
        recoveries += 1;
        announcedStall = true;
        lastProgressAt = now(); // beri jendela baru; jangan spam keputusan
        const event = emit(phase, reason, { actions: ['reload', 'nudge'] });
        if (event) {
            try { onRecover(event); } catch { /* abaikan */ }
        }
        return event;
    };

    return {
        /** Pemutaran dimulai (metadata siap / iframe loaded). */
        start(reason = 'start') {
            if (stopped) return;
            begin(reason);
        },

        /**
         * Ada kemajuan nyata: `currentTime` bertambah.
         * @param {{ time?: number, percent?: number }} [info]
         */
        progress(info = {}) {
            if (stopped) return;
            const t = Number(info.time);
            if (Number.isFinite(t) && t <= 0) return;
            if (!started) begin('progress');
            moved = true;
            lastProgressAt = now();
            announcedStall = false;
        },

        /** Video mengirim `waiting` (kehabisan buffer) — mulai hitung diam dari titik ini. */
        waiting() {
            if (stopped) return;
            if (!started) {
                begin('waiting');
                return;
            }
            if (!announcedStall) emit('stalled', 'waiting', { actions: [] });
            announcedStall = true;
        },

        /** Video lanjut setelah menunggu. */
        playing() {
            if (stopped) return;
            if (!started) begin('playing');
            else lastProgressAt = now();
            announcedStall = false;
        },

        /**
         * Pemutaran dijeda pengguna → jangan hitung diam. Tanpa ini, video yang dijeda
         * >`stallMs` akan disalahartikan sebagai buffering dan dimuat ulang.
         */
        suspend() {
            suspended = true;
        },

        /** Pemutaran dilanjutkan lagi → hitungan diam mulai dari sekarang. */
        resume() {
            if (stopped) return;
            suspended = false;
            lastProgressAt = now();
            announcedStall = false;
        },

        /** Berhenti mengawasi (ganti server/episode). */
        stop() {
            stopped = true;
        },

        get state() {
            return { started, moved, recoveries, stopped, idleMs: idleMs() };
        },

        /**
         * Dipanggil berkala oleh pemanggil (biasanya tiap 2–5 detik).
         * @returns {WatchEvent|null} keputusan yang harus dijalankan pemanggil
         */
        tick() {
            if (stopped || !started || suspended) return null;
            const idle = idleMs();
            const limit = moved ? stallTimeoutMs : startupTimeoutMs;
            if (idle < limit) return null;
            // Embed yang tidak melaporkan progres: beri tahu sekali, tetapi jangan pindah server
            // hanya karena tidak ada kabar (iklan/penghitung bisa menahan `load` lama).
            if (!moved && !failBeforeProgress) {
                if (announcedStall) return null;
                announcedStall = true;
                return emit('stalled', 'startup', { actions: ['hint'] });
            }
            // Pemutar lintas-domain: kita tidak bisa membedakan macet / dijeda / tidak melapor.
            if (!autoRecover) return null;
            // Batas keras: sudah tidak ada kemajuan sedalam ini → menunggu lagi tidak ada gunanya.
            if (idle >= limit + hardStallMs || recoveries >= maxRecoveries) {
                return emit('failed', moved ? 'stalled' : 'startup', { actions: ['next-server'] });
            }
            return recovered('stalled', moved ? 'progress' : 'startup');
        },

        /** Kegagalan pasti (hls.js fatal, `video.error`, proxy 5xx): tidak perlu menunggu batas. */
        fail(reason = 'error') {
            if (stopped) return;
            return emit('failed', reason, { actions: ['next-server'] });
        },

        /**
         * Batas "tanpa kemajuan" yang dipakai hls.js, sedikit di bawah batas pengawas supaya
         * pemulihan internal hls.js masih sempat bekerja lebih dulu.
         */
        get hlsStallMs() {
            return Math.max(4000, Math.floor(stallTimeoutMs * 0.6));
        },
    };
}

/**
 * Kalimat pendek (bahasa Indonesia) untuk status bar / toast.
 * @param {string} reason alasan teknis dari pengawas (`startup`, `stalled`, `hls …`, …)
 * @returns {string}
 */
export function playbackProblemText(reason = '') {
    const r = String(reason || '').toLowerCase();
    if (r.includes('startup')) return 'Video tidak mulai diputar di server ini.';
    if (r.includes('stalled') || r.includes('buffer')) return 'Video berhenti (buffering) dan tidak lanjut.';
    if (r.includes('timeout')) return 'Server video terlalu lama merespons.';
    if (r.includes('manifest') || r.includes('frag') || r.includes('hls') || r.includes('parse')) {
        return 'Server video mengirim data yang tidak bisa diputar.';
    }
    if (r.includes('proxy') || r.includes('network') || r.includes('5')) return 'Sambungan ke server video terputus.';
    return 'Server video ini gagal memutar episode.';
}
