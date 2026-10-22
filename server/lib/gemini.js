/**
 * Kazanime backend — lib/gemini.js (ditambahkan 22 Okt 2026)
 * Klien minimal Gemini API untuk terjemahan subtitle (lib/subtitle-ai.js).
 *
 *  - Endpoint: POST {apiBase}/models/{model}:generateContent (REST v1beta). Sejak Juni 2026 Google menyebutnya
 *    "legacy" tetapi tetap didukung penuh (https://ai.google.dev/gemini-api/docs/interactions); dipilih karena
 *    stateless — request tidak disimpan di server Google seperti default Interactions API.
 *  - Request keluar tetap lewat lib/fetcher.js (allowlist host, timeout, batas ukuran respons). robots.txt
 *    tidak berlaku untuk API resmi ber-key. Key dikirim di header `x-goog-api-key` (bukan di URL → tidak ikut
 *    tercatat di log) dan tidak pernah dikembalikan ke klien / ditulis ke log.
 *  - Thinking diminimalkan per model (dokumentasi "Gemini thinking", 22 Okt 2026): 3.6 Flash & Flash-Lite
 *    mendukung `minimal`; 3.8 Flash menolak `minimal` (error) → `low`; seri 2.5 memakai `thinkingBudget: 0`.
 *    Bila model tetap menolak pengaturan thinking (HTTP 400), diulang sekali tanpa pengaturan itu.
 *  - Safety filter tidak diatur: default Gemini 2.5+ = Off (dokumentasi "Safety settings").
 *  - Model dicoba berurutan (utama → cadangan). Model yang gagal "didinginkan" di memori instance:
 *      429 kuota harian   → sampai tengah malam waktu Pasifik (jadwal reset kuota Gemini)
 *      429 per menit      → retryDelay dari respons (15 dtk – 15 mnt)
 *      402 kredit habis   → 1 jam
 *      404 model          → 1 jam (nama salah / model dipensiunkan)
 *      400/401/403 key    → 10 menit, error AI_CONFIG (key salah/diblokir/API belum aktif) — model lain tidak dicoba
 *      5xx / timeout      → 30 dtk
 */
import { AppError } from './errors.js';

/** Sisa waktu minimal sebelum mencoba satu model (ms). */
const MIN_CALL_MS = 6000;

/**
 * Pengaturan thinking paling hemat yang didukung model.
 * @param {string} model
 * @returns {Record<string, string|number>|null}
 */
export function thinkingConfigFor(model) {
    const m = String(model || '').toLowerCase();
    if (/gemini-2\.5/.test(m)) return { thinkingBudget: 0 };
    if (/flash-lite|gemini-3\.6-flash|gemini-3-flash/.test(m)) return { thinkingLevel: 'minimal' };
    return { thinkingLevel: 'low' }; // mis. gemini-3.8-flash (minimal = error), gemini-flash-latest
}

/** ms sampai tengah malam waktu Pasifik (kuota harian Gemini direset saat itu) + 1 menit. */
export function msUntilPacificMidnight(now = Date.now()) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(now));
        const get = (type) => Number(parts.find((p) => p.type === type)?.value);
        const elapsed = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000;
        if (!Number.isFinite(elapsed)) throw new Error('jam Pasifik tidak terbaca');
        return Math.max(60_000, 24 * 3600 * 1000 - elapsed + 60_000);
    } catch {
        return 6 * 3600 * 1000;
    }
}

/** "37s" / "37.5s" / {seconds} → ms */
function parseDelay(v) {
    if (typeof v === 'string') {
        const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
        return m ? Math.ceil(Number(m[1]) * 1000) : 0;
    }
    if (v && typeof v === 'object') return (Number(v.seconds) || 0) * 1000;
    return 0;
}

/**
 * Tafsirkan respons error Gemini (format: {error: {code, message, status, details[]}}).
 * @param {number} status
 * @param {string} text body respons
 * @param {number} [now]
 * @returns {{kind: 'quota-day'|'quota-minute'|'model'|'config'|'thinking'|'request'|'overload', retryAfterMs: number, detail: string}}
 */
export function classifyGeminiError(status, text, now = Date.now()) {
    let err = {};
    try {
        err = JSON.parse(text)?.error || {};
    } catch { /* body bukan JSON */ }
    const message = String(err.message || '').slice(0, 300);
    const details = Array.isArray(err.details) ? err.details : [];
    const reasons = details.map((d) => d?.reason).filter(Boolean).join(',');
    const quotas = details.flatMap((d) => (Array.isArray(d?.violations) ? d.violations : []))
        .map((v) => `${v?.quotaId || ''} ${v?.quotaMetric || ''}`).join(' ');
    const retryInfo = details.find((d) => String(d?.['@type'] || '').endsWith('RetryInfo'));
    const detail = `HTTP ${status} ${err.status || ''} ${reasons} ${message}`.replace(/\s+/g, ' ').trim();

    if (status === 429) {
        if (/perday|per day|daily/i.test(quotas) || /per day|daily/i.test(message)) {
            return { kind: 'quota-day', retryAfterMs: msUntilPacificMidnight(now), detail };
        }
        const fromMsg = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(message);
        const ms = parseDelay(retryInfo?.retryDelay) || (fromMsg ? Math.ceil(Number(fromMsg[1]) * 1000) : 0) || 60_000;
        return { kind: 'quota-minute', retryAfterMs: Math.min(Math.max(ms, 15_000), 15 * 60_000), detail };
    }
    if (status === 402) return { kind: 'quota-day', retryAfterMs: 3600_000, detail };
    if (status === 404) return { kind: 'model', retryAfterMs: 3600_000, detail };
    if (status === 401 || status === 403) return { kind: 'config', retryAfterMs: 10 * 60_000, detail };
    if (status === 400) {
        if (/API_KEY|api key/i.test(`${reasons} ${message}`) || err.status === 'FAILED_PRECONDITION') {
            return { kind: 'config', retryAfterMs: 10 * 60_000, detail };
        }
        if (/thinking/i.test(message)) return { kind: 'thinking', retryAfterMs: 0, detail };
        return { kind: 'request', retryAfterMs: 10 * 60_000, detail };
    }
    return { kind: 'overload', retryAfterMs: 30_000, detail };
}

/**
 * Teks jawaban (tanpa bagian "thought") + alasan berhenti/diblokir.
 * @param {any} json GenerateContentResponse
 */
export function extractText(json) {
    const cand = Array.isArray(json?.candidates) ? json.candidates[0] : null;
    const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
    const text = parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
    const blockReason = String(json?.promptFeedback?.blockReason || '') || (cand ? '' : 'NO_CANDIDATE');
    return { text, finishReason: String(cand?.finishReason || ''), blockReason };
}

/** Gabungkan kegagalan semua model jadi satu error untuk respons API (pesan untuk penonton). */
function failure(tried) {
    const kinds = tried.map((t) => t.kind);
    const retrySec = (list) => Math.max(1, Math.ceil(Math.min(...list.map((t) => t.retryAfterMs || 60_000)) / 1000));
    if (kinds.includes('config')) {
        return new AppError('Terjemahan AI belum bisa dipakai: kunci Gemini ditolak (salah, diblokir, atau Gemini API belum aktif untuk key ini).', { status: 503, code: 'AI_CONFIG', retryAfter: 600 });
    }
    if (tried.length && kinds.every((k) => k === 'quota-day' || k === 'quota-minute')) {
        const daily = kinds.every((k) => k === 'quota-day');
        return new AppError(
            daily ? 'Kuota harian terjemahan AI (Gemini) sudah habis. Coba lagi besok (kuota direset ±14.00–15.00 WIB).' : 'Batas permintaan terjemahan AI per menit tercapai. Coba lagi sebentar lagi.',
            { status: 503, code: 'AI_QUOTA', retryAfter: retrySec(tried) },
        );
    }
    if (kinds.includes('timeout')) return new AppError('AI terlalu lama menerjemahkan. Coba lagi sebentar lagi.', { status: 504, code: 'AI_TIMEOUT', retryAfter: 20 });
    if (tried.length && kinds.every((k) => k === 'model' || k === 'request')) {
        return new AppError('Model Gemini yang diatur tidak tersedia (periksa GEMINI_MODEL).', { status: 503, code: 'AI_CONFIG', retryAfter: 600 });
    }
    if (kinds.includes('blocked')) return new AppError('Gemini menolak menerjemahkan bagian subtitle ini.', { status: 502, code: 'AI_BLOCKED', retryAfter: 300 });
    return new AppError('Layanan terjemahan AI (Gemini) sedang gangguan. Coba lagi sebentar lagi.', { status: 502, code: 'AI_UPSTREAM', retryAfter: 30 });
}

/**
 * @param {{
 *   client: {request: Function},   klien lib/fetcher.js (allowedHosts = host apiBase, robots: false, retries: 0)
 *   apiKey: string,
 *   apiBase: string,
 *   models: readonly string[],     urutan coba (utama → cadangan)
 *   timeoutMs?: number,            batas satu panggilan
 *   now?: () => number,
 * }} opts
 */
export function createGemini({ client, apiKey, apiBase, models, timeoutMs = 40000, now = Date.now }) {
    if (!apiKey) throw new Error('GEMINI_API_KEY kosong.');
    /** @type {Map<string, {until: number, kind: string, detail: string}>} */
    const cooldown = new Map();
    const cool = (model, kind, ms, detail) => {
        if (ms > 0) cooldown.set(model, { until: now() + ms, kind, detail: String(detail || '').slice(0, 300) });
    };

    function call(model, body, deadline, signal) {
        return client.request(`${apiBase}/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            accept: 'application/json',
            deadline: Math.min(deadline, now() + timeoutMs),
            signal,
            passErrors: true,
        });
    }

    /**
     * @param {{system: string, prompt: string, deadline: number, maxOutputTokens?: number, skip?: string[], signal?: AbortSignal}} q
     * @returns {Promise<{model: string, text: string, finishReason: string, usage: object|null}>}
     */
    async function generate({ system, prompt, deadline, maxOutputTokens = 8192, skip = [], signal }) {
        const tried = [];
        for (const model of models) {
            if (skip.includes(model)) continue;
            const cd = cooldown.get(model);
            if (cd && cd.until > now()) {
                tried.push({ model, kind: cd.kind, retryAfterMs: cd.until - now(), detail: cd.detail });
                if (cd.kind === 'config') break;
                continue;
            }
            if (deadline - now() < MIN_CALL_MS) {
                tried.push({ model, kind: 'timeout', retryAfterMs: 20_000, detail: 'waktu habis sebelum model dicoba' });
                break;
            }
            let thinking = thinkingConfigFor(model);
            for (let attempt = 0; attempt < 2; attempt++) {
                const body = {
                    systemInstruction: { parts: [{ text: system }] },
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { maxOutputTokens, ...(thinking ? { thinkingConfig: thinking } : {}) },
                };
                let res;
                try {
                    res = await call(model, body, deadline, signal);
                } catch (err) {
                    if (err?.kind === 'abort') throw err;
                    const kind = err?.kind === 'timeout' ? 'timeout' : 'overload';
                    cool(model, kind, 30_000, err?.message);
                    tried.push({ model, kind, retryAfterMs: 30_000, detail: String(err?.message || err) });
                    console.warn(`[gemini] ${model}: ${kind} — ${err?.message || err}`);
                    break;
                }
                if (res.status === 200) {
                    let json = null;
                    try { json = JSON.parse(res.text); } catch { /* ditangani di bawah */ }
                    const out = extractText(json);
                    if (out.blockReason || !out.text.trim()) {
                        // Isi tertentu ditolak (safety/recitation) atau jawaban kosong → model berikutnya, tanpa pendinginan.
                        tried.push({ model, kind: 'blocked', retryAfterMs: 300_000, detail: out.blockReason || out.finishReason || 'jawaban kosong' });
                        console.warn(`[gemini] ${model}: jawaban diblokir/kosong (${out.blockReason || out.finishReason || '-'})`);
                        break;
                    }
                    return { model, text: out.text, finishReason: out.finishReason, usage: json?.usageMetadata || null };
                }
                const e = classifyGeminiError(res.status, res.text, now());
                if (e.kind === 'thinking' && thinking) {
                    thinking = null; // model menolak pengaturan thinking → ulangi sekali tanpa pengaturan itu
                    continue;
                }
                cool(model, e.kind, e.retryAfterMs, e.detail);
                tried.push({ model, ...e });
                console.warn(`[gemini] ${model}: ${e.kind} — ${e.detail}`);
                break;
            }
            if (tried.at(-1)?.kind === 'config') break; // key ditolak → model lain pasti sama
        }
        throw failure(tried);
    }

    return {
        generate,
        health: () => ({
            models: models.map((model) => {
                const cd = cooldown.get(model);
                const left = cd ? Math.max(0, Math.ceil((cd.until - now()) / 1000)) : 0;
                return left ? { model, status: cd.kind, cooldownSec: left } : { model, status: 'ready' };
            }),
        }),
    };
}
