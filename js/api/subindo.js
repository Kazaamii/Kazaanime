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
const LATEST_FEED_SOURCE_IDS = new Set(['samehadaku', 'sakunime', 'otakudesu', 'kuramanime']);

function slugSourceOf(anime) {
    return String(anime?.slug || '').split(/[~:]/, 1)[0].trim().toLowerCase();
}

function sourceIdOf(anime) {
    const explicit = String(anime?.source || '').trim().toLowerCase().replace(/^backend:/, '');
    const slugPrefix = slugSourceOf(anime);
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
 * Legacy verifier untuk konsumen yang membutuhkan satu daftar datar. Homepage
 * memakai getVerifiedSubIndoSources agar judul lintas penyedia tetap terpisah.
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

/**
 * Versi berkelompok dari verifier: cek episode terbaru dengan batas global,
 * tetapi pertahankan panel dan duplikat judul antar-sumber.
 */
export async function getVerifiedSubIndoSources({
    getSources,
    getEpisode,
    signal,
    limit = RESULT_LIMIT,
    maxChecks = SOURCE_CHECK_LIMIT,
    concurrency = CONCURRENCY,
} = {}) {
    if (typeof getSources !== 'function' || typeof getEpisode !== 'function') {
        throw new TypeError('getSources dan getEpisode wajib berupa fungsi.');
    }
    throwIfAborted(signal);

    const catalog = await getSources({ signal });
    throwIfAborted(signal);
    if (!catalog || catalog.fallback) return { sections: [], checked: 0, unavailable: true };

    const sources = (Array.isArray(catalog.sections) ? catalog.sections : [])
        .filter((source) => LATEST_FEED_SOURCE_IDS.has(String(source?.id || '').trim().toLowerCase()))
        .map((source) => ({
            id: String(source.id).trim().toLowerCase(),
            name: String(source.name || source.id),
            stale: Boolean(source.stale),
            error: source.error || null,
            checked: 0,
            failedChecks: 0,
            items: [],
            candidates: (Array.isArray(source.items) ? source.items : [])
                .filter((anime) => anime?.slug
                    && sourceIdOf(anime) === String(source.id).trim().toLowerCase()
                    && slugSourceOf(anime) === String(source.id).trim().toLowerCase()),
        }));

    const checkLimit = Math.max(0, Math.min(60, Number(maxChecks) || SOURCE_CHECK_LIMIT));
    const candidates = [];
    for (let index = 0; candidates.length < checkLimit; index++) {
        let added = false;
        for (const source of sources) {
            const anime = source.candidates[index];
            if (!anime || candidates.length >= checkLimit) continue;
            candidates.push({ source, anime });
            added = true;
        }
        if (!added) break;
    }

    const checks = new Array(candidates.length).fill(null);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(6, Number(concurrency) || CONCURRENCY));
    const worker = async () => {
        while (true) {
            throwIfAborted(signal);
            const index = cursor++;
            if (index >= candidates.length) return;
            const { source, anime } = candidates[index];
            const episode = episodeOf(anime);
            source.checked++;
            try {
                const media = await getEpisode(anime.slug, episode, { signal });
                if (hasIndonesianSubtitle(media?.servers)) {
                    checks[index] = { source, anime: { ...anime, latestEpisode: episode }, key: titleKey(anime) };
                }
            } catch (error) {
                if (signal?.aborted || error?.kind === 'abort' || error?.name === 'AbortError') throw error;
                source.failedChecks++;
            }
        }
    };

    if (candidates.length) {
        await Promise.all(Array.from({ length: Math.min(workerCount, candidates.length) }, worker));
    }
    throwIfAborted(signal);

    const seenBySource = new Map(sources.map((source) => [source.id, new Set()]));
    const resultLimit = Math.max(1, Number(limit) || RESULT_LIMIT);
    for (const check of checks) {
        if (!check || check.source.items.length >= resultLimit) continue;
        const seen = seenBySource.get(check.source.id);
        if (check.key && seen.has(check.key)) continue;
        if (check.key) seen.add(check.key);
        check.source.items.push(check.anime);
    }

    return {
        sections: sources.map(({ id, name, stale, error, checked, failedChecks, items }) => ({
            id, name, stale, error, checked, failedChecks, items,
        })),
        checked: candidates.length,
        unavailable: Boolean(catalog.unavailable),
    };
}

export { hasIndonesianSubtitle, sourceIdOf };
