/**
 * Kazanime backend — lib/concurrency.js
 * Menjalankan tugas async untuk banyak item dengan batas konkurensi, hasil tetap
 * sesuai urutan asli (24 Okt 2026).
 *
 * Dipakai pencarian donghua: lima kueri berurutan ke host yang sama menghabiskan
 * ~1 dtk pacing per kueri (SCRAPER_MIN_INTERVAL_MS), sehingga permintaan panel
 * beranda bisa melewati batas waktu klien. Antrean per-host di RequestManager tetap
 * menahan laju; helper ini hanya menghilangkan penjumlahan waktu tunggu respons.
 */

/**
 * @template T, R
 * @param {Iterable<T>} items
 * @param {number} limit jumlah tugas bersamaan (minimal 1)
 * @param {(item: T, index: number) => Promise<R>} run
 * @returns {Promise<R[]>} hasil dengan urutan sama seperti `items`
 */
export async function mapLimit(items, limit, run) {
    const list = Array.from(items || []);
    const results = new Array(list.length);
    const width = Math.min(Math.max(1, Math.trunc(Number(limit)) || 1), list.length);
    let cursor = 0;
    const workers = Array.from({ length: width }, async () => {
        for (;;) {
            const index = cursor;
            if (index >= list.length) return;
            cursor += 1;
            results[index] = await run(list[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}
