/**
 * Kazanime — verifikasi katalog Sub Indo untuk section terpisah di homepage.
 * Hanya judul dari katalog scraper yang diperiksa; hasil metadata cadangan
 * dan server tanpa bukti subtitle Indonesia tidak dimasukkan.
 *
 * Penguatan 23 Okt 2026:
 *  - batas waktu total (`SUB_INDO.timeBudgetMs`) → panel tidak menunggu selamanya;
 *    hasil yang sudah terverifikasi tetap ditampilkan dengan penanda "batas waktu";
 *  - batas kandidat per sumber (`perSourceChecks`) supaya satu situs tidak menghabiskan
 *    jatah pemeriksaan situs lain;
 *  - bila episode terbaru belum punya bukti Sub Indo, episode sebelumnya diperiksa
 *    (terbatas) dan kartu menunjuk episode yang benar-benar terverifikasi.
 */
import { SUB_INDO } from '../config.js';

const SUB_INDO_SOURCE_IDS = new Set([
    'samehadaku',
    'otakudesu',
    'kuramanime',
    'anoboy',
    'sakunime',
    'animeindo',
]);

const SOURCE_CHECK_LIMIT = SUB_INDO.maxChecks;
const RESULT_LIMIT = SUB_INDO.resultLimit;
const CONCURRENCY = SUB_INDO.concurrency;
const LATEST_FEED_SOURCE_IDS = new Set(['samehadaku', 'sakunime', 'otakudesu', 'kuramanime']);

function limitOf(value, fallback, min = 1, max = 60) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function budgetOf(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(60 * 1000, Math.floor(n));
}

function budgetAbortError() {
    const error = new Error('Batas waktu pemeriksaan tercapai.');
    error.name = 'AbortError';
    return error;
}

/**
 * Berhenti menunggu getEpisode saat anggaran waktu habis. Request asli tetap
 * dibatalkan lewat signal yang sama; race ini menjaga verifier tidak menggantung
 * bila implementasi getEpisode mengabaikan signal.
 */
function raceAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(budgetAbortError());
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(budgetAbortError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

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
 * Versi berkelompok dari verifier: cek episode terbaru dengan batas global dan
 * batas per sumber, lalu pertahankan panel dan duplikat judul antar-sumber.
 *
 * Anggaran waktu: bila `timeBudgetMs` habis, pemeriksaan yang belum selesai
 * dibatalkan dan hasil yang sudah terverifikasi tetap dikembalikan dengan
 * `timedOut: true` pada sumber terkait (bukan error seluruh feed).
 *
 * Episode sebelumnya: bila episode terbaru tidak punya bukti Sub Indo, episode
 * sebelumnya boleh diperiksa (terbatas). Kartu lalu menunjuk episode yang
 * benar-benar terverifikasi (`latestEpisode` diperbarui) agar tautan tidak
 * menjanjikan subtitle yang belum ada.
 */
export async function getVerifiedSubIndoSources({
    getSources,
    getEpisode,
    signal,
    limit = RESULT_LIMIT,
    maxChecks = SOURCE_CHECK_LIMIT,
    perSourceChecks = SUB_INDO.perSourceChecks,
    concurrency = CONCURRENCY,
    timeBudgetMs = SUB_INDO.timeBudgetMs,
    retryPreviousEpisode = SUB_INDO.retryPreviousEpisode,
    previousEpisodeChecks = SUB_INDO.previousEpisodeChecks,
    sourceIds = null,
} = {}) {
    if (typeof getSources !== 'function' || typeof getEpisode !== 'function') {
        throw new TypeError('getSources dan getEpisode wajib berupa fungsi.');
    }
    const startedAt = Date.now();
    throwIfAborted(signal);

    const catalog = await getSources({ signal });
    throwIfAborted(signal);
    if (!catalog || catalog.fallback) {
        return { sections: [], checked: 0, timedOut: false, unavailable: true };
    }

    const normalizeSourceId = (value) => String(value || '').trim().toLowerCase();
    const onlySources = Array.isArray(sourceIds) && sourceIds.length
        ? new Set(sourceIds.map(normalizeSourceId).filter(Boolean))
        : null;
    const sources = (Array.isArray(catalog.sections) ? catalog.sections : [])
        .filter((source) => {
            const id = normalizeSourceId(source?.id);
            return onlySources ? onlySources.has(id) : LATEST_FEED_SOURCE_IDS.has(id);
        })
        .map((source) => {
            const id = normalizeSourceId(source.id);
            const seenSlugs = new Set();
            const candidates = (Array.isArray(source.items) ? source.items : [])
                .filter((anime) => {
                    if (!anime?.slug || sourceIdOf(anime) !== id || slugSourceOf(anime) !== id) return false;
                    if (seenSlugs.has(anime.slug)) return false;
                    seenSlugs.add(anime.slug);
                    return true;
                });
            return {
                id,
                name: String(source.name || source.id),
                homeUrl: String(source.homeUrl || ''),
                stale: Boolean(source.stale),
                error: source.error || null,
                checked: 0,
                failedChecks: 0,
                timedOut: false,
                scheduled: 0,
                processed: 0,
                items: [],
                candidates,
            };
        });

    // Jatah global + jatah per sumber, dibagikan bergiliran agar setiap panel
    // mendapat kesempatan yang sama (sumber dengan kandidat sedikit tidak
    // menghabiskan jatah sumber lain).
    const checkLimit = limitOf(maxChecks, SOURCE_CHECK_LIMIT, 0, 60);
    const perSourceLimit = limitOf(perSourceChecks, SUB_INDO.perSourceChecks, 1, 60);
    const candidates = [];
    for (let index = 0; candidates.length < checkLimit; index++) {
        let added = false;
        for (const source of sources) {
            if (source.scheduled >= perSourceLimit) continue;
            const anime = source.candidates[index];
            if (!anime) continue;
            candidates.push({ source, anime });
            source.scheduled++;
            added = true;
            if (candidates.length >= checkLimit) break;
        }
        if (!added) break;
    }

    // Anggaran waktu dihitung sejak fungsi dipanggil (termasuk katalog), bukan
    // hanya verifikasi, supaya panel tidak menunggu dua kali lipat saat backend lambat.
    const budgetMs = budgetOf(timeBudgetMs);
    const remainingMs = budgetMs ? Math.max(0, budgetMs - (Date.now() - startedAt)) : 0;
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    if (budgetMs && remainingMs <= 0) {
        timedOut = true;
        controller.abort();
    } else if (remainingMs > 0) {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, remainingMs);
    }
    const onUserAbort = () => controller.abort();
    signal?.addEventListener('abort', onUserAbort, { once: true });

    const isBudgetStop = () => controller.signal.aborted && !signal?.aborted;
    const requestEpisode = (anime, episode) => raceAbort(
        getEpisode(anime.slug, episode, { signal: controller.signal }),
        controller.signal,
    );

    const results = new Array(candidates.length).fill(null);
    const previousLimit = retryPreviousEpisode
        ? limitOf(previousEpisodeChecks, 0, 0, checkLimit)
        : 0;
    const previousBudget = { used: 0 };

    /** Periksa satu kandidat; `results[index]` hanya diisi bila bukti Sub Indo ada. */
    const verifyCandidate = async (source, anime, index) => {
        const episode = episodeOf(anime);
        source.checked++;
        try {
            const media = await requestEpisode(anime, episode);
            if (hasIndonesianSubtitle(media?.servers)) {
                results[index] = { source, anime: { ...anime, latestEpisode: episode }, key: titleKey(anime) };
                return;
            }
        } catch {
            if (signal?.aborted) throwIfAborted(signal);
            if (isBudgetStop()) {
                source.timedOut = true;
                return;
            }
            source.failedChecks++;
            return;
        }

        if (!previousLimit || episode <= 1 || previousBudget.used >= previousLimit) return;
        previousBudget.used++;
        const previousEpisode = episode - 1;
        source.checked++;
        try {
            const media = await requestEpisode(anime, previousEpisode);
            if (hasIndonesianSubtitle(media?.servers)) {
                results[index] = {
                    source,
                    anime: { ...anime, latestEpisode: previousEpisode },
                    key: titleKey(anime),
                };
            }
        } catch {
            if (signal?.aborted) throwIfAborted(signal);
            if (isBudgetStop()) {
                source.timedOut = true;
                return;
            }
            source.failedChecks++;
        }
    };

    let cursor = 0;
    const workerCount = limitOf(concurrency, CONCURRENCY, 1, 6);
    const worker = async () => {
        while (true) {
            if (timedOut || controller.signal.aborted) return;
            throwIfAborted(signal);
            const index = cursor++;
            if (index >= candidates.length) return;
            const { source, anime } = candidates[index];
            try {
                await verifyCandidate(source, anime, index);
            } finally {
                source.processed++;
            }
        }
    };

    try {
        if (candidates.length) {
            await Promise.all(Array.from({ length: Math.min(workerCount, candidates.length) }, worker));
        }
    } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onUserAbort);
    }
    throwIfAborted(signal);

    for (const source of sources) {
        if (timedOut && source.processed < source.scheduled) source.timedOut = true;
    }

    const seenBySource = new Map(sources.map((source) => [source.id, new Set()]));
    const resultLimit = limitOf(limit, RESULT_LIMIT, 1, 60);
    for (const check of results) {
        if (!check || check.source.items.length >= resultLimit) continue;
        const seen = seenBySource.get(check.source.id);
        if (check.key && seen.has(check.key)) continue;
        if (check.key) seen.add(check.key);
        check.source.items.push(check.anime);
    }

    return {
        sections: sources.map(({ id, name, homeUrl, stale, error, checked, failedChecks, timedOut: expired, items }) => ({
            id, name, homeUrl, stale, error, checked, failedChecks, timedOut: expired, items,
        })),
        checked: sources.reduce((sum, source) => sum + source.checked, 0),
        timedOut: Boolean(timedOut),
        unavailable: Boolean(catalog.unavailable),
    };
}

export { hasIndonesianSubtitle, sourceIdOf };
