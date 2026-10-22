/**
 * Browser-local subtitle helpers for Kazanime's in-page HLS <video> player.
 * Files stay in memory in the browser: they are never sent to the backend.
 */
export const MAX_LOCAL_SUBTITLE_BYTES = 10 * 1024 * 1024;

const SRT_TIMING = /^\s*(\d{1,2}):(\d{2}):(\d{2}),(\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2}),(\d{1,3})(?:\s+.*)?\s*$/;

function toMilliseconds(hours, minutes, seconds, millis) {
    const h = Number(hours);
    const m = Number(minutes);
    const s = Number(seconds);
    if (m > 59 || s > 59) return null;
    return ((h * 60 + m) * 60 + s) * 1000 + Number(String(millis).padEnd(3, '0'));
}

function vttTimestamp(hours, minutes, seconds, millis) {
    return `${String(hours).padStart(2, '0')}:${minutes}:${seconds}.${String(millis).padEnd(3, '0')}`;
}

function convertSrt(source) {
    const blocks = source.trim().split(/\n[ \t]*\n+/);
    const cues = [];
    for (const block of blocks) {
        const lines = block.split('\n');
        const timingIndex = lines.findIndex((line) => SRT_TIMING.test(line.trim()));
        if (timingIndex < 0) continue;
        const match = lines[timingIndex].trim().match(SRT_TIMING);
        if (!match) continue;
        const start = toMilliseconds(match[1], match[2], match[3], match[4]);
        const end = toMilliseconds(match[5], match[6], match[7], match[8]);
        if (start == null || end == null || end <= start) continue;
        const text = lines.slice(timingIndex + 1).join('\n').trim();
        if (!text) continue;
        cues.push(`${vttTimestamp(match[1], match[2], match[3], match[4])} --> ${vttTimestamp(match[5], match[6], match[7], match[8])}\n${text}`);
    }
    if (!cues.length) throw new Error('Format .srt tidak dikenali atau tidak berisi subtitle yang valid.');
    return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

/** Convert SRT or normalize/validate WebVTT, returning browser-readable WebVTT. */
export function convertLocalSubtitle(source, format) {
    if (typeof source !== 'string') throw new TypeError('Isi berkas subtitle tidak dapat dibaca.');
    const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const ext = String(format || '').toLowerCase().replace(/^\./, '');
    if (ext === 'srt') return convertSrt(normalized);
    if (ext === 'vtt') {
        const body = normalized.trimStart();
        if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(body)) {
            throw new Error('Header WebVTT tidak ditemukan. Pastikan berkas .vtt valid.');
        }
        const clean = body.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
        return `${clean}\n`;
    }
    throw new Error('Pilih berkas subtitle .srt atau .vtt.');
}

function safeFilename(name) {
    return String(name || 'Subtitle Lokal')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 80) || 'Subtitle Lokal';
}

/** Read and validate a browser File without sending it anywhere. */
export async function readLocalSubtitleFile(file) {
    if (!file || typeof file.text !== 'function') throw new Error('Berkas subtitle tidak dapat dibaca.');
    const name = String(file.name || '');
    const ext = name.split('.').at(-1)?.toLowerCase();
    if (ext !== 'srt' && ext !== 'vtt') throw new Error('Pilih berkas subtitle .srt atau .vtt.');
    if (Number.isFinite(file.size) && file.size > MAX_LOCAL_SUBTITLE_BYTES) {
        throw new Error('Ukuran subtitle maksimal 10 MB.');
    }
    const vtt = convertLocalSubtitle(await file.text(), ext);
    return { vtt, label: safeFilename(name) };
}

/**
 * Attach an in-memory WebVTT blob to a video and select it. The returned disposer
 * removes the track and revokes its object URL; callers should invoke it whenever
 * the active source/video changes.
 */
export function attachLocalSubtitleTrack(video, subtitle, {
    createTrack = () => document.createElement('track'),
    createUrl = (vtt) => URL.createObjectURL(new Blob([vtt], { type: 'text/vtt;charset=utf-8' })),
    revokeUrl = (url) => URL.revokeObjectURL(url),
} = {}) {
    if (!video || !subtitle?.vtt) throw new Error('Tidak ada video atau subtitle lokal yang valid.');
    const objectUrl = createUrl(subtitle.vtt);
    const element = createTrack();
    try {
        element.kind = 'subtitles';
        element.label = `Subtitle Lokal — ${safeFilename(subtitle.label)}`;
        element.srclang = 'id';
        element.src = objectUrl;
        video.append(element);
        const localTrack = element.track;
        if (!localTrack) throw new Error('Browser tidak dapat membuat track subtitle lokal.');
        for (const track of Array.from(video.textTracks || [])) {
            if (track !== localTrack && track.mode === 'showing') track.mode = 'hidden';
        }
        localTrack.mode = 'showing';
    } catch (error) {
        try { element.remove?.(); } catch { /* lanjutkan melepas Blob URL */ }
        revokeUrl(objectUrl);
        throw error;
    }

    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        try { element.remove(); } finally { revokeUrl(objectUrl); }
    };
}
