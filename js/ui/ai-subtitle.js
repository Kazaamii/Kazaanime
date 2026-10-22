/**
 * Kazanime — ui/ai-subtitle.js (22 Okt 2026)
 * "Subtitle Indonesia (AI)" untuk player video bawaan (server HLS AniZone "Multi Sub").
 * Dipakai ui/player.js HANYA bila episode tidak punya subtitle Indonesia dan backend menawarkan terjemahan
 * Gemini (`server.ai` — ada hanya bila GEMINI_API_KEY diisi di server; key tidak pernah ada di frontend).
 *
 * Alur:
 *  1. Mulai saat video benar-benar diputar (event `playing`), bukan saat halaman dibuka → bot/pengunjung yang
 *     tidak menonton tidak memakai kuota.
 *  2. Bagian pertama datang → track "Indonesia (AI)" (TextTrack + VTTCue) tampil dan subtitle bawaan
 *     disembunyikan (mode 'hidden': tidak tampil, tetap termuat untuk cadangan). Bila pengguna sudah memilih
 *     subtitle lain / mematikannya lewat menu subtitle player selama menunggu, pilihannya tidak ditimpa ('kept').
 *  3. Bagian berikutnya diambil satu per satu, mulai dari posisi tonton (seek → urutan ikut berubah).
 *  4. Gagal sementara (timeout, 5xx, batas per menit) → diulang (PLAYER.aiSubtitle.retryDelays, Retry-After
 *     dihormati maks 2 menit). Gagal tetap (AI mati, key ditolak, kuota harian habis) → berhenti; bagian yang
 *     tidak terjemah diisi baris subtitle ASLI (bukan teks karangan) dan pengguna diberi tahu.
 *
 * Tidak ada fetch di sini (fetchPart datang dari js/api lewat watch.js → player.js). Tidak memakai DOM global:
 * video, VTTCue, dan timer bisa disuntikkan → diuji di Node (server/test/ai-subtitle-ui.test.js).
 */

/** Kode error backend yang membuat terjemahan dihentikan (mengulang tidak akan berhasil). */
const FATAL_CODES = new Set(['AI_DISABLED', 'AI_CONFIG', 'AI_STALE', 'BAD_SIGNATURE', 'BAD_REQUEST', 'NOT_FOUND']);

/** Kalimat untuk pengguna dari error js/api (pesan backend sudah berbahasa Indonesia). */
export function aiErrorText(err) {
    if (err?.payload?.error) return String(err.payload.error);
    switch (err?.kind) {
        case 'timeout': return 'Server AI terlalu lama merespons.';
        case 'network': return 'Tidak dapat terhubung ke server.';
        case 'parse': return 'Data subtitle AI tidak valid.';
        case 'disabled': return String(err.message || 'Backend tidak aktif.');
        default: return 'Terjemahan AI gagal.';
    }
}

/** Pengaturan cue WebVTT ("line:5% position:50% align:center") → properti VTTCue. */
function applySettings(cue, settings) {
    for (const tok of String(settings || '').split(/\s+/)) {
        const i = tok.indexOf(':');
        if (i < 1) continue;
        const key = tok.slice(0, i);
        const val = tok.slice(i + 1).split(',')[0];
        try {
            if (key === 'line') {
                if (val.endsWith('%')) {
                    cue.snapToLines = false;
                    cue.line = Number.parseFloat(val);
                } else if (/^-?\d+$/.test(val)) {
                    cue.line = Number.parseInt(val, 10);
                }
            } else if (key === 'position' && val.endsWith('%')) {
                cue.position = Number.parseFloat(val);
            } else if (key === 'size' && val.endsWith('%')) {
                cue.size = Number.parseFloat(val);
            } else if (key === 'align' && /^(start|center|end|left|right)$/.test(val)) {
                cue.align = val;
            }
        } catch { /* nilai tidak didukung browser ini → abaikan */ }
    }
}

/**
 * @param {{
 *   video: HTMLVideoElement,
 *   ai: {url: string, from?: string, sourceLabel?: string, label?: string},
 *   fetchPart: (part: number, signal: AbortSignal) => Promise<{part:number, parts:number, ranges:number[][], cues:{start:number,end:number,text:string,settings:string}[], label?:string, untranslated?:number}>,
 *   onState?: (s: {phase: 'translating'|'kept'|'ready'|'partial'|'failed', done: number, failed: number, total: number, label: string, untranslated: number, showing: string, first?: boolean, retrying?: boolean, error?: unknown}) => void,
 *   VTTCueCtor?: typeof VTTCue,
 *   retryDelays?: readonly number[],
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void,
 * }} opts
 */
export function createAiSubtitle({
    video,
    ai,
    fetchPart,
    onState = () => {},
    VTTCueCtor = globalThis.VTTCue,
    retryDelays = [5000, 20000],
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
}) {
    const label = ai?.label || 'Indonesia (AI)';
    let started = false;
    let destroyed = false;
    /** @type {TextTrack|null} */
    let track = null;
    let parts = 0;
    /** @type {number[][]} */
    let ranges = [];
    /** Track yang tampil saat terjemahan dimulai (untuk mendeteksi pilihan pengguna). */
    let before = null;
    let switched = false;
    let kept = false;
    let untranslated = 0;
    let lastError = null;
    let stopped = false;
    const done = new Set();
    const failed = new Set();
    const ctrl = new AbortController();
    let waitTimer = null;

    const tracks = () => Array.from(video.textTracks || []);
    const showing = () => tracks().find((t) => t.mode === 'showing') || null;
    /** Track subtitle sumber terjemahan (untuk mengisi bagian yang gagal dengan baris aslinya). */
    const sourceTrack = () => tracks().find((t) => t !== track
        && (!ai?.sourceLabel || t.label === ai.sourceLabel)
        && (!ai?.from || ai.from === 'und' || t.language === ai.from)) || null;

    function report(phase, extra = {}) {
        if (destroyed) return;
        try {
            onState({ phase, done: done.size, failed: failed.size, total: parts, label, untranslated, showing: showing()?.label || '', ...extra });
        } catch (err) {
            console.error('[ai-subtitle] onState error:', err);
        }
    }

    function sleep(ms) {
        return new Promise((resolve) => {
            if (ctrl.signal.aborted) {
                resolve();
                return;
            }
            const onAbort = () => {
                clearTimer(waitTimer);
                resolve();
            };
            waitTimer = setTimer(() => {
                ctrl.signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            ctrl.signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function addCue(start, end, text, settings, copyFrom) {
        try {
            const cue = new VTTCueCtor(start, end, text);
            if (copyFrom) {
                for (const k of ['snapToLines', 'line', 'position', 'size', 'align']) {
                    if (copyFrom[k] === undefined) continue;
                    try { cue[k] = copyFrom[k]; } catch { /* abaikan */ }
                }
            } else {
                applySettings(cue, settings);
            }
            track.addCue(cue);
            return true;
        } catch {
            return false; // cue rusak dilewati
        }
    }

    /** Bagian yang gagal → baris subtitle asli pada rentang waktu yang sama (tetap jujur: bukan terjemahan). */
    function fillFromOriginal(p) {
        const src = sourceTrack();
        const r = ranges[p];
        if (!track || !src || !r) return 0;
        if (src.mode === 'disabled') src.mode = 'hidden'; // cue hanya tersedia bila track tidak disabled
        let n = 0;
        for (const c of Array.from(src.cues || [])) {
            if (c.startTime >= r[0] && c.startTime < r[1] && addCue(c.startTime, c.endTime, c.text, '', c)) n++;
        }
        return n;
    }

    /** Tampilkan track AI & sembunyikan subtitle bawaan — kecuali pengguna sudah memilih sendiri. */
    function activate() {
        if (showing() !== before) {
            kept = true;
            return;
        }
        for (const t of tracks()) {
            if (t !== track && t.mode === 'showing') t.mode = 'hidden';
        }
        track.mode = 'showing';
        switched = true;
    }

    /** Bagian berikutnya: yang sedang ditonton → sesudahnya → sebelumnya (terdekat). */
    function pickNext() {
        const pending = [];
        for (let i = 0; i < parts; i++) if (!done.has(i) && !failed.has(i)) pending.push(i);
        if (!pending.length) return null;
        const t = Number(video.currentTime) || 0;
        let cur = ranges.findIndex((r) => t >= r[0] && t < r[1]);
        if (cur < 0) cur = t >= (ranges[parts - 1]?.[0] ?? 0) ? parts - 1 : 0;
        return pending.find((i) => i >= cur) ?? pending[pending.length - 1];
    }

    async function load(p) {
        for (let attempt = 0; !destroyed; attempt++) {
            try {
                const data = await fetchPart(p, ctrl.signal);
                if (destroyed) return false;
                if (!track) {
                    parts = data.parts;
                    ranges = data.ranges;
                    track = video.addTextTrack('subtitles', data.label || label, 'id');
                    track.mode = 'hidden';
                }
                for (const c of data.cues || []) addCue(c.start, c.end, c.text, c.settings);
                untranslated += Number(data.untranslated) || 0;
                done.add(p);
                return true;
            } catch (err) {
                if (destroyed || err?.kind === 'abort') return false;
                lastError = err;
                const code = String(err?.payload?.code || '');
                const retryAfter = Math.max(0, Number(err?.retryAfter) || 0);
                const fatal = FATAL_CODES.has(code) || (code === 'AI_QUOTA' && retryAfter > 120)
                    || [400, 403, 404, 409].includes(Number(err?.status)) || err?.kind === 'disabled' || err?.kind === 'parse';
                if (fatal || attempt >= retryDelays.length) {
                    if (fatal) stopped = true;
                    return false;
                }
                report('translating', { retrying: true });
                await sleep(Math.max(retryDelays[attempt], Math.min(retryAfter, 120) * 1000));
            }
        }
        return false;
    }

    async function run() {
        report('translating');
        if (!(await load(0))) {
            if (!destroyed) report('failed', { error: lastError });
            return;
        }
        activate();
        report(kept ? 'kept' : 'translating', { first: true });
        while (!destroyed && !stopped) {
            const next = pickNext();
            if (next == null) break;
            if (!(await load(next))) {
                if (destroyed) return;
                failed.add(next);
                fillFromOriginal(next);
            }
            if (!destroyed && !stopped && pickNext() != null) report(kept ? 'kept' : 'translating');
        }
        if (destroyed) return;
        if (stopped) {
            for (let i = 0; i < parts; i++) {
                if (!done.has(i) && !failed.has(i)) {
                    failed.add(i);
                    fillFromOriginal(i);
                }
            }
        }
        report(failed.size ? 'partial' : kept ? 'kept' : 'ready', { error: failed.size ? lastError : null });
    }

    return {
        /** Mulai menerjemahkan (dipanggil sekali saat video mulai diputar). */
        start() {
            if (started || destroyed) return;
            started = true;
            before = showing();
            run().catch((err) => {
                console.warn('[ai-subtitle] gagal:', err);
                report('failed', { error: err });
            });
        },
        /** Hentikan request & timer (server/episode berganti). */
        destroy() {
            destroyed = true;
            ctrl.abort();
            clearTimer(waitTimer);
        },
        /** Diagnosa/uji. */
        get info() {
            return { started, parts, done: [...done], failed: [...failed], switched, kept, untranslated, track };
        },
    };
}
