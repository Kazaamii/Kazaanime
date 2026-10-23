/**
 * Kazanime backend — lib/errors.js
 * Error bertipe supaya route bisa memilih status HTTP & pesan yang ramah,
 * dan aggregator bisa memutuskan kapan fallback ke API metadata.
 */

/** Jenis kegagalan sumber → status HTTP + kode untuk respons API. */
const KIND_MAP = Object.freeze({
    timeout: { status: 504, code: 'UPSTREAM_TIMEOUT' },
    network: { status: 502, code: 'UPSTREAM_UNREACHABLE' },
    http: { status: 502, code: 'UPSTREAM_ERROR' },
    parse: { status: 502, code: 'UPSTREAM_CHANGED' },
    blocked: { status: 503, code: 'SOURCE_BLOCKED' },
    robots: { status: 503, code: 'SOURCE_DISALLOWED' },
    policy: { status: 503, code: 'SOURCE_DISABLED' },
    disabled: { status: 503, code: 'SOURCE_DISABLED' },
    circuit: { status: 503, code: 'SOURCE_COOLDOWN' },
    rate_limited: { status: 503, code: 'SOURCE_BUSY' },
    proxy_unavailable: { status: 503, code: 'PROXY_UNAVAILABLE' },
    not_found: { status: 404, code: 'NOT_FOUND' },
    abort: { status: 499, code: 'CLIENT_CLOSED' },
});

export class AppError extends Error {
    /**
     * @param {string} message  pesan untuk pengguna (Bahasa Indonesia)
     * @param {{status?: number, code?: string, retryAfter?: number, cause?: unknown, details?: unknown}} [opts]
     */
    constructor(message, { status = 500, code = 'INTERNAL', retryAfter = 0, cause, details } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        this.retryAfter = retryAfter;
        this.details = details;
    }
}

/** Kegagalan saat mengambil/mengurai data dari satu sumber. */
export class SourceError extends AppError {
    /**
     * @param {string} message
     * @param {{kind: keyof typeof KIND_MAP, source?: string, httpStatus?: number, retryAfter?: number, cause?: unknown}} opts
     */
    constructor(message, { kind, source = '', httpStatus = 0, retryAfter = 0, cause } = {}) {
        const mapped = KIND_MAP[kind] || KIND_MAP.http;
        super(message, { status: mapped.status, code: mapped.code, retryAfter, cause });
        this.name = 'SourceError';
        this.kind = kind;
        this.source = source;
        this.httpStatus = httpStatus;
    }
}

export const badRequest = (message) => new AppError(message, { status: 400, code: 'BAD_REQUEST' });
export const notFound = (message, source = '') => new SourceError(message, { kind: 'not_found', source });

/** Ringkasan error yang aman dikirim ke klien (tanpa stack trace). */
export function describeError(err) {
    const summary = {
        source: err?.source || '',
        kind: err?.kind || (err instanceof AppError ? err.code.toLowerCase() : 'internal'),
        message: String(err?.message || 'Kesalahan tidak diketahui').slice(0, 200),
    };
    // Simpan status upstream, bukan hanya status 502/503 internal, agar tiap panel
    // bisa membedakan 403, 429, kegagalan robots.txt, dan perubahan parser.
    const httpStatus = Number(err?.httpStatus) || 0;
    const retryAfter = Number(err?.retryAfter) || 0;
    if (httpStatus > 0) summary.httpStatus = httpStatus;
    if (retryAfter > 0) summary.retryAfter = Math.min(retryAfter, 3600);
    if (typeof err?.stage === 'string' && err.stage) summary.stage = err.stage;
    return summary;
}

/** Error karena klien membatalkan / batas waktu request habis. */
export function isAbort(err) {
    return err?.kind === 'abort' || err?.name === 'AbortError';
}

/**
 * Gabungkan beberapa kegagalan sumber jadi satu error untuk respons.
 * Status dipilih dari yang paling "informatif": 404 bila semua bilang tidak ada,
 * 504 bila ada timeout, selain itu 503/502.
 * @param {SourceError[]} errors
 * @param {string} message
 */
export function combineErrors(errors, message) {
    const list = errors.filter(Boolean);
    if (!list.length) return new AppError(message, { status: 502, code: 'UPSTREAM_ERROR' });
    if (list.length === 1 && list[0] instanceof AppError) return list[0];
    const all = (k) => list.every((e) => e.kind === k);
    const some = (k) => list.some((e) => e.kind === k);
    let status = 502;
    let code = 'UPSTREAM_ERROR';
    if (all('not_found')) { status = 404; code = 'NOT_FOUND'; }
    else if (some('timeout')) { status = 504; code = 'UPSTREAM_TIMEOUT'; }
    else if (list.every((e) => e.status === 503)) { status = 503; code = 'SOURCES_UNAVAILABLE'; }
    const retryAfter = Math.max(0, ...list.map((e) => e.retryAfter || 0));
    return new AppError(message, { status, code, retryAfter, details: list.map(describeError) });
}
