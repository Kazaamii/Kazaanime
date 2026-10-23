/**
 * Kazanime — verifikasi katalog Sub Indo untuk section terpisah di homepage.
 * Hanya judul dari katalog scraper yang diperiksa; hasil metadata cadangan
 * dan server tanpa bukti subtitle Indonesia tidak dimasukkan.
 */

const SUB_INDO_SOURCE_IDS = new Set([
    'samehadaku',
    'otakudesu',
    'kuramanime',
    'anoboy',
    'sakunime',
    'animeindo',
]);

const SOURCE_CHECK_LIMIT = 18;
const RESULT_LIMIT = 12;
const CONCURRENCY = 3;

function sourceIdOf(anime) {
    const explicit = String(anime?.source || '').trim().toLowerCase().replace(/^backend:/, '');
    const slugPrefix = String(anime?.slug || '').split(/[~:]/, 1)[0].trim().toLowerCase();
    if (SUB_INDO_SOURCE_IDS.has(explicit)) return explicit;
    if (SUB_INDO_SOURCE_IDS.has(slugPrefix)) return slugPrefix;
    return '';
}

function isIndonesianLanguage(value) {
    const lang = String(value || '').trim().toLowerCase().replace(/_/g, '-');
    return lang === 'id' || lang === 'ind' || lang === 'indonesian'
        || lang === 'bahasa indonesia' || lang.startsWith('id-');
}

function hasIndonesianSubtitle(servers) {
    return (Array.isArray(servers) ? servers : []).some((server) => {
        if (!server || server.available === false) return false;
        if (isIndonesianLanguage(server.lang)) return true;
        if (/(?:sub[\s-]*indo|bahasa indonesia|indonesian)/i.test(String(server.name || ''))) return true;
        return (Array.isArray(server.subtitles) ? server.subtitles : []).some((track) =>
            isIndonesianLanguage(track?.lang)
            || /(?:bahasa indonesia|indonesian|sub[\s-]*indo)/i.test(String(track?.label || '')));
    });
}

function episodeOf(anime) {
    const value = Number(anime?.latestEpisode ?? anime?.episode ?? 1);
    return Number.isInteger(value) && value >= 1 && value <= 5000 ? value : 1;
}

function titleKey(anime) {
    return String(anime?.title || anime?.titleAlt || anime?.slug || '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '');
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error('Permintaan dibatalkan.');
    error.name = 'AbortError';
    throw error;
}

/**
 * Periksa sebagian kandidat secara bersamaan dengan batas agar homepage tidak
 * melakukan permintaan episode dalam jumlah tak terbatas.
 *
 * Dependencies diinjeksi supaya logika pemilihan bisa dites tanpa jaringan.
 */
export async function getVerifiedSubIndoAnime({
    getLatest,
    getEpisode,
    signal,
    limit = RESULT_LIMIT,
    maxChecks = SOURCE_CHECK_LIMIT,
    concurrency = CONCURRENCY,
} = {}) {
    if (typeof getLatest !== 'function' || typeof getEpisode !== 'function') {
        throw new TypeError('getLatest dan getEpisode wajib berupa fungsi.');
    }
    throwIfAborted(signal);

    const catalog = await getLatest({ signal });
    throwIfAborted(signal);
    if (!catalog || catalog.fallback) {
        return { items: [], checked: 0, unavailable: true };
    }

    const candidates = (Array.isArray(catalog.items) ? catalog.items : [])
        .filter((anime) => anime?.slug && sourceIdOf(anime))
        .slice(0, Math.max(0, Math.min(60, Number(maxChecks) || SOURCE_CHECK_LIMIT)));

    if (!candidates.length) {
        return { items: [], checked: 0, unavailable: false };
    }

    const checks = new Array(candidates.length).fill(null);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(6, Number(concurrency) || CONCURRENCY));

    const worker = async () => {
        while (true) {
            throwIfAborted(signal);
            const index = cursor++;
            if (index >= candidates.length) return;
            const anime = candidates[index];
            const episode = episodeOf(anime);
            try {
                const media = await getEpisode(anime.slug, episode, { signal });
                if (hasIndonesianSubtitle(media?.servers)) {
                    checks[index] = { anime: { ...anime, latestEpisode: episode }, key: titleKey(anime) };
                }
            } catch (error) {
                if (signal?.aborted || error?.kind === 'abort' || error?.name === 'AbortError') throw error;
                // Satu penyedia gagal tidak membatalkan kandidat dari sumber lain.
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(workerCount, candidates.length) }, worker));
    throwIfAborted(signal);

    const seen = new Set();
    const items = [];
    for (const check of checks) {
        if (!check) continue;
        if (check.key && seen.has(check.key)) continue;
        if (check.key) seen.add(check.key);
        items.push(check.anime);
        if (items.length >= Math.max(1, Number(limit) || RESULT_LIMIT)) break;
    }

    return { items, checked: candidates.length, unavailable: false };
}

export { hasIndonesianSubtitle, sourceIdOf };
