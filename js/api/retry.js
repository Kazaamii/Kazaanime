/**
 * Kazanime — api/retry.js
 * Percobaan ulang otomatis untuk kegagalan yang sifatnya SEMENTARA.
 *
 * Dipakai panel AnimeKu & Oploverz di beranda dan halaman Jelajah ("tambahkan auto
 * refresh nya untuk animeloverz dan animeku agar tidak gagal memuat", 24 Okt 2026).
 *
 * Yang diulang hanya: timeout, jaringan putus, HTTP 5xx, dan circuit breaker yang
 * baru terbuka karena kegagalan tadi. Yang TIDAK PERNAH diulang: 403, 429,
 * challenge keamanan, robots.txt, dan permintaan yang dibatalkan — permintaan ulang
 * di kasus itu sama dengan menembus pembatasan situs.
 */
const SERVER_ERROR_MIN = 500;

/** true bila error layak dicoba ulang otomatis. */
export function isRetryableError(error) {
    if (!error || error.kind === 'abort') return false;
    if (error.kind === 'timeout' || error.kind === 'network' || error.kind === 'circuit') return true;
    return error.kind === 'http' && Number(error.status) >= SERVER_ERROR_MIN;
}

/**
 * Jalankan `task(attempt)`; ulangi bila gagal karena sebab sementara.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} task
 * @param {{
 *   attempts?: number,              jumlah percobaan total (default 2)
 *   delay?: number,                 jeda dasar ms; percobaan ke-N menunggu delay × N
 *   onRetry?: (nextAttempt: number, error: unknown) => void,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [opts]
 * @returns {Promise<T>}
 */
export async function withAutoRetry(task, {
    attempts = 2,
    delay = 900,
    onRetry,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
    const total = Math.max(1, Number(attempts) || 1);
    let lastError = null;
    for (let attempt = 1; attempt <= total; attempt += 1) {
        try {
            return await task(attempt);
        } catch (error) {
            lastError = error;
            if (attempt >= total || !isRetryableError(error)) throw error;
            onRetry?.(attempt + 1, error);
            await sleep(delay * attempt);
        }
    }
    throw lastError || new Error('Permintaan gagal.');
}
