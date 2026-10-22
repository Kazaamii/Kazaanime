/**
 * Kazanime backend — lib/stream-proxy.js
 * Fungsi MURNI (tanpa I/O) untuk proxy HLS & subtitle (dipakai server/routes/stream.js):
 *   - createSigner      : tanda tangan HMAC untuk URL target → proxy tidak bisa dipakai sebagai
 *                         open proxy oleh pihak lain (ditambah allowlist host di fetcher).
 *   - rewritePlaylist   : semua URI di playlist m3u8 (baris segmen + atribut URI="…" pada
 *                         EXT-X-MEDIA / EXT-X-KEY / EXT-X-MAP / I-FRAME) → URL proxy kita.
 *   - assToVtt / srtToVtt : subtitle ASS/SRT (format AniZone) → WebVTT (satu-satunya format
 *                         <track> yang didukung browser). Posisi \pos/\an diperkirakan lewat
 *                         pengaturan cue VTT (line/position); efek & gaya lain dibuang.
 * Kenapa perlu proxy: CDN video AniZone (xin-cdn.xyz) TIDAK memeriksa Referer (diukur 22 Okt 2026),
 * tetapi mengirim `Access-Control-Allow-Origin: https://anizone.to` → hls.js (MSE) di domain lain
 * ditolak CORS. Safari/iOS (HLS native) tidak butuh CORS → diputar langsung tanpa proxy.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** @param {string} secret */
export function createSigner(secret) {
    const key = String(secret || '');
    if (key.length < 16) throw new Error('Secret proxy stream terlalu pendek (min. 16 karakter).');
    const sign = (value) => createHmac('sha256', key).update(String(value)).digest('base64url').slice(0, 22);
    return {
        sign,
        verify(value, sig) {
            const a = Buffer.from(sign(value));
            const b = Buffer.from(String(sig || ''));
            return a.length === b.length && timingSafeEqual(a, b);
        },
    };
}

export const encodeTarget = (url) => Buffer.from(String(url), 'utf8').toString('base64url');
export function decodeTarget(value) {
    const s = String(value || '');
    if (!s || s.length > 4000 || !/^[A-Za-z0-9_-]+$/.test(s)) return '';
    try {
        return Buffer.from(s, 'base64url').toString('utf8');
    } catch {
        return '';
    }
}

/**
 * @param {string} text isi m3u8
 * @param {string} baseUrl URL playlist (untuk URI relatif)
 * @param {(absoluteUrl: string) => string} toProxy
 */
export function rewritePlaylist(text, baseUrl, toProxy) {
    const abs = (u) => {
        try { return new URL(u, baseUrl).href; } catch { return ''; }
    };
    return String(text || '').split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
            return line.replace(/URI="([^"]+)"/g, (m, u) => {
                const a = abs(u);
                return a && /^https?:/i.test(a) ? `URI="${toProxy(a)}"` : m;
            });
        }
        const a = abs(t);
        return a && /^https?:/i.test(a) ? toProxy(a) : line;
    }).join('\n');
}

export const isPlaylist = (text) => /^\s*#EXTM3U/.test(String(text || '').slice(0, 64));

const pad = (n, w = 2) => String(n).padStart(w, '0');
function vttTime(totalMs) {
    const ms = Math.max(0, Math.round(totalMs));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}
/** "0:01:02.34" (ASS, sentidetik) → ms */
function assTime(t) {
    const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(t || '').trim());
    if (!m) return null;
    const frac = m[4] ? Number(m[4].padEnd(3, '0').slice(0, 3)) : 0;
    return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + frac;
}
const escapeVtt = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * ASS/SSA → WebVTT.
 * @param {string} text
 * @returns {string}
 */
export function assToVtt(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    let section = '';
    let playX = 384;
    let playY = 288;
    let format = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const cues = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (/^\[.+\]$/.test(line)) {
            section = line.toLowerCase();
            continue;
        }
        if (section === '[script info]') {
            const m = /^PlayRes([XY])\s*:\s*(\d+)/i.exec(line);
            if (m) {
                if (m[1].toUpperCase() === 'X') playX = Number(m[2]) || playX;
                else playY = Number(m[2]) || playY;
            }
            continue;
        }
        if (section !== '[events]') continue;
        if (/^format\s*:/i.test(line)) {
            format = line.replace(/^format\s*:/i, '').split(',').map((f) => f.trim().toLowerCase());
            continue;
        }
        if (!/^dialogue\s*:/i.test(line)) continue;
        const body = line.replace(/^dialogue\s*:/i, '');
        const parts = [];
        let rest = body;
        for (let i = 0; i < format.length - 1; i++) {
            const k = rest.indexOf(',');
            if (k < 0) break;
            parts.push(rest.slice(0, k));
            rest = rest.slice(k + 1);
        }
        parts.push(rest);
        const f = Object.fromEntries(format.map((name, i) => [name, parts[i] ?? '']));
        const start = assTime(f.start);
        const end = assTime(f.end);
        if (start == null || end == null || end <= start) continue;
        const rawText = String(f.text || '');
        if (/\\p[1-9]/.test(rawText)) continue; // gambar vektor (bukan teks)
        const overrides = (rawText.match(/\{[^}]*\}/g) || []).join('');
        const clean = rawText
            .replace(/\{[^}]*\}/g, '')
            .replace(/\\[Nn]/g, '\n')
            .replace(/\\h/g, ' ')
            .split('\n').map((s) => s.trim()).filter(Boolean).join('\n');
        if (!clean) continue;
        let settings = '';
        const pos = /\\(?:pos|move)\(\s*([\d.]+)\s*,\s*([\d.]+)/.exec(overrides);
        const an = /\\an([1-9])/.exec(overrides);
        if (pos) {
            const x = Math.min(100, Math.max(0, Math.round((Number(pos[1]) / playX) * 100)));
            const y = Math.min(95, Math.max(0, Math.round((Number(pos[2]) / playY) * 100)));
            settings = ` line:${y}% position:${x}% align:center`;
        } else if (an && ['7', '8', '9'].includes(an[1])) {
            settings = ' line:5%';
        }
        cues.push({ start, end, text: escapeVtt(clean), settings });
    }
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    const out = ['WEBVTT', ''];
    let prev = null;
    for (const c of cues) {
        const key = `${c.start}|${c.end}|${c.text}|${c.settings}`;
        if (key === prev) continue;
        prev = key;
        out.push(`${vttTime(c.start)} --> ${vttTime(c.end)}${c.settings}`, c.text, '');
    }
    return out.join('\n');
}

/**
 * SRT → WebVTT.
 * @param {string} text
 */
export function srtToVtt(text) {
    const body = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const blocks = body.split(/\n{2,}/);
    const out = ['WEBVTT', ''];
    for (const block of blocks) {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        const i = lines.findIndex((l) => /-->/.test(l));
        if (i < 0) continue;
        const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(lines[i]);
        if (!m) continue;
        const toMs = (h, mi, s, ms) => ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Number(String(ms).padEnd(3, '0'));
        const start = toMs(m[1], m[2], m[3], m[4]);
        const end = toMs(m[5], m[6], m[7], m[8]);
        if (end <= start) continue;
        const textLines = lines.slice(i + 1)
            .map((l) => l.replace(/\{\\[^}]*\}/g, '').replace(/<(?!\/?(?:i|b|u)>)[^>]*>/gi, '').trim())
            .filter(Boolean);
        if (!textLines.length) continue;
        const safe = textLines.join('\n').replace(/&(?!amp;|lt;|gt;)/g, '&amp;');
        out.push(`${vttTime(start)} --> ${vttTime(end)}`, safe, '');
    }
    return out.join('\n');
}

/** Konversi sesuai format ('ass' | 'ssa' | 'srt' | 'vtt'); format tak dikenal → dideteksi dari isi. */
export function toVtt(text, format = '') {
    const f = String(format || '').toLowerCase();
    const head = String(text || '').slice(0, 2000);
    if (f === 'vtt' || /^\uFEFF?WEBVTT/.test(head)) return /^\uFEFF?WEBVTT/.test(head) ? String(text).replace(/^\uFEFF/, '') : srtToVtt(text);
    if (f === 'ass' || f === 'ssa' || /\[Script Info\]|\[Events\]/i.test(head)) return assToVtt(text);
    return srtToVtt(text);
}
