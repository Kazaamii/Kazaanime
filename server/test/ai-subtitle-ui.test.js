/**
 * Frontend js/ui/ai-subtitle.js ("Subtitle Indonesia (AI)") dengan video/TextTrack/VTTCue tiruan.
 * Perilaku browser sungguhan (Chromium + hls.js) diuji terpisah secara manual — lihat README "Tes".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiErrorText, createAiSubtitle } from '../../js/ui/ai-subtitle.js';

class FakeCue {
    constructor(startTime, endTime, text) {
        Object.assign(this, { startTime, endTime, text, line: 'auto', position: 'auto', align: 'center', size: 100, snapToLines: true });
    }
}

class FakeTrack {
    constructor(kind, label, language, mode = 'disabled', cues = []) {
        Object.assign(this, { kind, label, language, mode });
        this.list = cues;
    }
    get cues() { return this.mode === 'disabled' ? null : this.list; } // seperti spesifikasi: disabled → null
    addCue(c) { this.list.push(c); }
}

function fakeVideo(tracks = []) {
    return {
        currentTime: 0,
        textTracks: tracks,
        addTextTrack(kind, label, language) {
            const t = new FakeTrack(kind, label, language, 'hidden');
            this.textTracks.push(t);
            return t;
        },
    };
}

const english = () => new FakeTrack('subtitles', 'English', 'en', 'showing', [
    new FakeCue(1, 2, 'Hello'), new FakeCue(12, 13, 'Original twelve'), new FakeCue(25, 26, 'Original twenty-five'),
]);
const AI = { url: '/api/stream/subai?u=x', from: 'en', sourceLabel: 'English', label: 'Indonesia (AI)' };
const RANGES = [[0, 10], [10, 20], [20, 30]];
const partData = (p, extra = {}) => ({
    part: p, parts: 3, ranges: RANGES, label: 'Indonesia (AI)', untranslated: 0,
    cues: [{ start: p * 10 + 1, end: p * 10 + 2, text: `Bagian ${p}`, settings: p === 0 ? 'line:5% position:50% align:center' : '' }],
    ...extra,
});
const apiError = (status, code, retryAfter = 0, kind = 'http') => Object.assign(new Error(code), { kind, status, retryAfter, payload: { ok: false, code, error: `Pesan ${code}.` } });
/** Timer instan yang mencatat jeda yang diminta. */
function instantTimers() {
    const delays = [];
    return { delays, setTimer: (fn, ms) => { delays.push(ms); setImmediate(fn); return delays.length; }, clearTimer: () => {} };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('ai-subtitle: bagian pertama → track AI tampil, subtitle bawaan disembunyikan; semua bagian → ready', async () => {
    const en = english();
    const video = fakeVideo([en]);
    const states = [];
    const asked = [];
    const ctl = createAiSubtitle({
        video, ai: AI, VTTCueCtor: FakeCue, ...instantTimers(),
        fetchPart: async (p, signal) => { asked.push(p); assert.ok(signal instanceof AbortSignal); return partData(p); },
        onState: (s) => states.push(s),
    });
    assert.equal(video.textTracks.length, 1, 'belum ada apa-apa sebelum diputar');
    ctl.start();
    ctl.start(); // dipanggil dua kali → tetap sekali jalan
    await settle();
    const aiTrack = video.textTracks[1];
    assert.deepEqual([aiTrack.kind, aiTrack.label, aiTrack.language, aiTrack.mode], ['subtitles', 'Indonesia (AI)', 'id', 'showing']);
    assert.equal(en.mode, 'hidden', 'bawaan disembunyikan (tetap termuat)');
    assert.deepEqual(asked, [0, 1, 2]);
    assert.deepEqual(aiTrack.list.map((c) => c.text), ['Bagian 0', 'Bagian 1', 'Bagian 2']);
    const c0 = aiTrack.list[0];
    assert.deepEqual([c0.snapToLines, c0.line, c0.position, c0.align], [false, 5, 50, 'center']);
    assert.deepEqual(states.map((s) => s.phase), ['translating', 'translating', 'translating', 'ready']);
    assert.equal(states[1].first, true);
    assert.deepEqual([states.at(-1).done, states.at(-1).total], [3, 3]);
    assert.deepEqual(ctl.info.switched, true);
});

test('ai-subtitle: pengguna memilih subtitle lain selama menunggu → pilihannya tidak ditimpa (kept)', async () => {
    const en = english();
    const video = fakeVideo([en]);
    const states = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const ctl = createAiSubtitle({
        video, ai: AI, VTTCueCtor: FakeCue, ...instantTimers(),
        fetchPart: async (p) => { if (p === 0) await gate; return partData(p); },
        onState: (s) => states.push(s.phase),
    });
    ctl.start();
    en.mode = 'disabled'; // pengguna mematikan subtitle lewat menu CC
    release();
    await settle();
    assert.equal(video.textTracks[1].mode, 'hidden', 'track AI tersedia di menu, tidak dipaksa tampil');
    assert.equal(en.mode, 'disabled');
    assert.equal(states.at(-1), 'kept');
    assert.equal(ctl.info.kept, true);
});

test('ai-subtitle: bagian gagal sementara terus → diisi baris ASLI pada rentangnya (partial), jeda ulang dihormati', async () => {
    const en = english();
    const video = fakeVideo([en]);
    const states = [];
    const timers = instantTimers();
    const ctl = createAiSubtitle({
        video, ai: AI, VTTCueCtor: FakeCue, retryDelays: [5000, 20000], ...timers,
        fetchPart: async (p) => { if (p === 1) throw apiError(504, 'AI_TIMEOUT', 20); return partData(p); },
        onState: (s) => states.push(s),
    });
    ctl.start();
    await settle();
    const aiTrack = video.textTracks[1];
    assert.deepEqual(aiTrack.list.map((c) => c.text), ['Bagian 0', 'Original twelve', 'Bagian 2'], 'bagian 1 = baris asli (diisi saat gagal), bukan karangan');
    assert.deepEqual(timers.delays, [20000, 20000], 'Retry-After 20 dtk > jeda 5 dtk; jeda kedua 20 dtk');
    assert.equal(states.at(-1).phase, 'partial');
    assert.equal(states.at(-1).error.payload.code, 'AI_TIMEOUT');
    assert.deepEqual(ctl.info.failed, [1]);
});

test('ai-subtitle: error tetap (kuota harian habis) di bagian pertama → tanpa track AI, tanpa mengulang, subtitle asli tetap', async () => {
    const en = english();
    const video = fakeVideo([en]);
    const states = [];
    let calls = 0;
    const ctl = createAiSubtitle({
        video, ai: AI, VTTCueCtor: FakeCue, ...instantTimers(),
        fetchPart: async () => { calls++; throw apiError(503, 'AI_QUOTA', 3600); },
        onState: (s) => states.push(s),
    });
    ctl.start();
    await settle();
    assert.equal(calls, 1);
    assert.equal(video.textTracks.length, 1);
    assert.equal(en.mode, 'showing');
    assert.equal(states.at(-1).phase, 'failed');
    assert.equal(aiErrorText(states.at(-1).error), 'Pesan AI_QUOTA.');
    assert.equal(aiErrorText({ kind: 'timeout' }), 'Server AI terlalu lama merespons.');
});

test('ai-subtitle: kuota per menit (Retry-After pendek) diulang; error tetap di tengah → sisa bagian diisi baris asli', async () => {
    const en = english();
    const video = fakeVideo([en]);
    const timers = instantTimers();
    let first = true;
    const states = [];
    const ctl = createAiSubtitle({
        video, ai: AI, VTTCueCtor: FakeCue, ...timers,
        fetchPart: async (p) => {
            if (p === 0 && first) { first = false; throw apiError(503, 'AI_QUOTA', 40); }
            if (p === 1) throw apiError(503, 'AI_CONFIG', 600);
            return partData(p);
        },
        onState: (s) => states.push(s.phase),
    });
    ctl.start();
    await settle();
    assert.deepEqual(timers.delays, [40000]);
    const aiTrack = video.textTracks[1];
    assert.deepEqual(aiTrack.list.map((c) => c.text), ['Bagian 0', 'Original twelve', 'Original twenty-five'], 'berhenti setelah AI_CONFIG, bagian 2 tidak diminta');
    assert.deepEqual(ctl.info.failed.sort(), [1, 2]);
    assert.equal(states.at(-1), 'partial');
});

test('ai-subtitle: urutan bagian mengikuti posisi tonton; destroy menghentikan semuanya', async () => {
    const video = fakeVideo([english()]);
    video.currentTime = 25; // penonton melanjutkan dari menit akhir
    const asked = [];
    const states = [];
    const ctl = createAiSubtitle({
        video, ai: AI, VTTCueCtor: FakeCue, ...instantTimers(),
        fetchPart: async (p) => { asked.push(p); return partData(p); },
        onState: (s) => states.push(s.phase),
    });
    ctl.start();
    await settle();
    assert.deepEqual(asked, [0, 2, 1], 'bagian yang sedang ditonton didahulukan');

    let signal = null;
    const video2 = fakeVideo([english()]);
    const states2 = [];
    const ctl2 = createAiSubtitle({
        video: video2, ai: AI, VTTCueCtor: FakeCue, ...instantTimers(),
        fetchPart: (p, s) => { signal = s; return new Promise(() => {}); },
        onState: (s) => states2.push(s.phase),
    });
    ctl2.start();
    await settle();
    ctl2.destroy();
    assert.equal(signal.aborted, true);
    await settle();
    assert.deepEqual(states2, ['translating'], 'tidak ada laporan setelah destroy');
    assert.equal(video2.textTracks.length, 1);
});
