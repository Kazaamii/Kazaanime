/**
 * Kazanime backend — lib/challenge-handler.js
 * Fail-closed detection for access restrictions. It identifies HTTP 403/429 and
 * common CAPTCHA/security-challenge pages, but never solves, retries, or changes
 * identity/proxy in response to a challenge.
 */
import { SourceError } from './errors.js';

const CLOUDFLARE_MARKERS = /Just a moment\.|Attention Required!\s*\|\s*Cloudflare|Sorry, you have been blocked|cf-chl-|challenge-platform|cf_chl_opt|Enable JavaScript and cookies to continue/i;
const CAPTCHA_MARKERS = /(?:g-recaptcha|h-captcha|cf-turnstile|captcha-container|captcha\/|\/captcha(?:[/?#"'])|verify (?:that )?you are human|human verification|security verification|checking your browser|complete the security check|robot check|bot verification|perimeterx|datadome|imperva|incapsula)/i;
const CHALLENGE_MARKERS = /(?:security challenge|browser verification|challenge-platform|cf-chl-|cf_chl_opt|please enable cookies to continue)/i;

function header(headers, name) {
    try { return String(headers?.get?.(name) || ''); } catch { return ''; }
}

/** "120" atau tanggal HTTP → detik. */
export function retryAfterSeconds(value, now = Date.now()) {
    if (!value) return 0;
    const raw = String(value).trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && String(n) === raw) return Math.max(0, n);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

/**
 * Deteksi isi halaman CAPTCHA/challenge, tanpa menganggap semua halaman 403 sebagai challenge.
 * @param {{status?: number, headers?: Headers, text?: string}} response
 */
export function looksLikeChallenge({ status = 0, headers, text = '' }) {
    if (header(headers, 'cf-mitigated').toLowerCase() === 'challenge') return true;
    const sample = String(text).slice(0, 50000);
    if (CAPTCHA_MARKERS.test(sample) || CHALLENGE_MARKERS.test(sample)) return true;
    if (![403, 429, 503].includes(Number(status))) return false;
    const viaCloudflare = /cloudflare/i.test(header(headers, 'server')) || Boolean(header(headers, 'cf-ray'));
    return viaCloudflare && CLOUDFLARE_MARKERS.test(sample);
}

/**
 * Mengubah respons upstream yang membatasi akses menjadi SourceError yang konsisten.
 * Caller bertanggung jawab membuka circuit; tidak ada retry atau fallback browser di kelas ini.
 */
export class ChallengeHandler {
    constructor({ circuit = null, blockedMs = 30 * 60 * 1000, now = Date.now } = {}) {
        this.circuit = circuit;
        this.blockedMs = blockedMs;
        this.now = now;
    }

    /** @returns {SourceError|null} null bila respons tidak menunjukkan pembatasan */
    inspect({ source, status, headers, text, passErrors = false, blockedMs = this.blockedMs } = {}) {
        const httpStatus = Number(status) || 0;
        const challenge = looksLikeChallenge({ status: httpStatus, headers, text });
        if (challenge) {
            this.circuit?.failure(source, { reason: 'challenge', immediate: true, openMs: blockedMs });
            return new SourceError(`${source} mengirim CAPTCHA atau challenge keamanan (HTTP ${httpStatus || 'tidak diketahui'}); akses dihentikan tanpa percobaan ulang.`, {
                kind: 'blocked', source, httpStatus,
            });
        }
        if (passErrors) return null;
        if (httpStatus === 403) {
            this.circuit?.failure(source, { reason: 'HTTP 403', immediate: true, openMs: blockedMs });
            return new SourceError(`${source} menolak akses (HTTP 403); akses dihentikan tanpa percobaan ulang.`, {
                kind: 'blocked', source, httpStatus,
            });
        }
        if (httpStatus === 429) {
            const retryAfter = retryAfterSeconds(header(headers, 'retry-after'), this.now()) || 60;
            const cooldownMs = Math.min(Math.max(retryAfter, 30), 900) * 1000;
            this.circuit?.failure(source, { reason: 'HTTP 429', immediate: true, openMs: cooldownMs });
            return new SourceError(`${source} membatasi permintaan (HTTP 429); tidak dicoba ulang.`, {
                kind: 'rate_limited', source, httpStatus, retryAfter,
            });
        }
        return null;
    }
}
