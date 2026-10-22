/**
 * "Subtitle Indonesia (AI)" (22 Okt 2026): lib/subtitle-ai.js, lib/gemini.js, GET /api/stream/subai.
 * Gemini TIDAK dipanggil sungguhan di sini: klien palsu / server HTTP lokal meniru format respons resmi
 * (GenerateContentResponse & error {error:{code,message,status,details}} dari dokumentasi Gemini API).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { AppError } from '../lib/errors.js';
import { createClient, createNetwork } from '../lib/fetcher.js';
import { classifyGeminiError, createGemini, extractText, msUntilPacificMidnight, thinkingConfigFor } from '../lib/gemini.js';
import { createSigner, decodeTarget, encodeTarget } from '../lib/stream-proxy.js';
import {
    buildPrompt, createAiSubtitleService, parseRows, parseVtt, partRanges, pickAiSource, planParts, toCueText, translatePart,
} from '../lib/subtitle-ai.js';
import { startServer } from './helpers.js';

const SECRET = 'rahasia-uji-yang-cukup-panjang-123';
const AI_CONFIG = Object.freeze({
    enabled: true, apiKey: 'kunci-uji', models: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'], apiBase: 'https://generativelanguage.googleapis.com/v1beta',
    label: 'Indonesia (AI)', partLines: 3, partChars: 9000, timeoutMs: 20000, requestBudgetMs: 30000, rateLimitPerMinute: 0, version: 1,
});

/** Baris "n|teks" dari prompt → jawaban "n|ID: teks" (tiruan model yang patuh format). */
function fakeTranslate(prompt, { drop = [], prefix = 'ID: ' } = {}) {
    return prompt.split('\n').map((l) => /^(\d+)\|(.*)$/.exec(l)).filter(Boolean)
        .filter((m) => !drop.includes(Number(m[1])))
        .map((m) => `${m[1]}|${prefix}${m[2]}`).join('\n');
}

const geminiOk = (text, extra = {}) => JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: 'pikiran rahasia', thought: true }, { text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
    ...extra,
});
const geminiErr = (code, status, message, details = []) => JSON.stringify({ error: { code, status, message, details } });
const QUOTA_DAY = geminiErr(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' },
]);
const QUOTA_MINUTE = geminiErr(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded. Please retry in 37.2s.', [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
]);

/* ------------------------------------------------------------------ */
/* Fungsi murni                                                        */
/* ------------------------------------------------------------------ */
test('parseVtt: cue + pengaturan aman, NOTE/STYLE/waktu rusak dibuang, urut waktu', () => {
    const vtt = [
        'WEBVTT', '', 'STYLE', '::cue { color: red }', '', 'NOTE catatan', '',
        '00:00:05.000 --> 00:00:06.000 line:5% position:50% align:center region:x evil:1', 'Atas', '',
        'id-1', '00:00:01.500 --> 00:00:03.200', 'Halo, dunia!', 'Baris dua', '',
        '00:00:09.000 --> 00:00:08.000', 'mundur', '',
        '01:02:07.000 --> 01:02:08.000', 'a &lt; b &amp; c', '',
    ].join('\n');
    const cues = parseVtt(vtt);
    assert.deepEqual(cues.map((c) => c.text), ['Halo, dunia!\nBaris dua', 'Atas', 'a &lt; b &amp; c']);
    assert.equal(cues[0].start, 1.5);
    assert.equal(cues[0].end, 3.2);
    assert.equal(cues[1].settings, 'line:5% position:50% align:center');
    assert.equal(cues[2].start, 3727);
    assert.deepEqual(parseVtt(''), []);
});

test('planParts: batas baris unik & karakter, teks kembar dihitung sekali, baris simbol tidak dihitung, rentang waktu', () => {
    const mk = (t, s) => ({ start: s, end: s + 1, text: t, settings: '' });
    const cues = [mk('A', 0), mk('B', 2), mk('A', 4), mk('♪♪', 5), mk('C', 6), mk('D', 8), mk('E', 10), mk('...', 11)];
    const parts = planParts(cues, { maxLines: 3, maxChars: 1000 });
    assert.deepEqual(parts.map((p) => [p.from, p.to, p.lines]), [[0, 5, 3], [5, 8, 2]]);
    assert.deepEqual(partRanges(parts), [[0, 8], [8, 12]]);
    const byChars = planParts([mk('x'.repeat(60), 0), mk('y'.repeat(60), 1), mk('z', 2)], { maxLines: 100, maxChars: 100 });
    assert.deepEqual(byChars.map((p) => [p.from, p.to]), [[0, 1], [1, 3]]);
    assert.deepEqual(planParts(cues, { maxLines: 3, maxChars: 1000 }), parts, 'deterministik');
});

test('prompt & jawaban: entitas didekode, <br> untuk baris baru, parseRows tahan format longgar, toCueText aman', () => {
    const p = buildPrompt(['Halo &amp; selamat\n<i>datang</i>', 'a &lt; b'], 'en-US');
    assert.match(p, /from English into Indonesian/);
    assert.match(p, /\n1\|Halo & selamat<br><i>datang<\/i>\n2\|a < b$/);
    const rows = parseRows('Berikut terjemahannya:\n1| Halo\n 2 ｜ Dua\n- 3|Tiga\n2|duplikat\n9|di luar\n4|\n```', 4);
    assert.deepEqual([...rows], [[1, 'Halo'], [2, 'Dua'], [3, 'Tiga']]);
    assert.equal(toCueText('Halo<br>dunia & <i>kamu</i> <script>x</script> --> <B>tebal</B>\\n\n\nakhir'), 'Halo\ndunia &amp; <i>kamu</i> &lt;script&gt;x&lt;/script&gt; → <b>tebal</b>\nakhir');
});

test('pickAiSource: Indonesia ada → null; Inggris non-SDH → SDH → Melayu → apa saja', () => {
    const en = { label: 'English', lang: 'en' };
    const sdh = { label: 'English (SDH)', lang: 'en' };
    assert.equal(pickAiSource([en, { label: 'Indonesia', lang: 'id' }]), null);
    assert.equal(pickAiSource([sdh, en]), en);
    assert.equal(pickAiSource([sdh, { label: 'Arab', lang: 'ar' }]), sdh);
    const malay = { label: 'Malay', lang: 'my' };
    assert.equal(pickAiSource([{ label: 'Arab', lang: 'ar' }, malay]), malay);
    assert.equal(pickAiSource([{ label: 'Burma', lang: 'my' }, { label: 'Arab', lang: 'ar' }]).label, 'Burma');
    assert.equal(pickAiSource([]), null);
});

test('gemini: thinking per model, klasifikasi error resmi, reset kuota tengah malam Pasifik, teks tanpa "thought"', () => {
    assert.deepEqual(thinkingConfigFor('gemini-3.6-flash'), { thinkingLevel: 'minimal' });
    assert.deepEqual(thinkingConfigFor('gemini-3.5-flash-lite'), { thinkingLevel: 'minimal' });
    assert.deepEqual(thinkingConfigFor('gemini-3.8-flash'), { thinkingLevel: 'low' }, '3.8 Flash menolak minimal');
    assert.deepEqual(thinkingConfigFor('gemini-2.5-flash'), { thinkingBudget: 0 });

    const now = Date.UTC(2026, 9, 22, 7, 30, 0); // 00:30 PDT
    const day = classifyGeminiError(429, QUOTA_DAY, now);
    assert.equal(day.kind, 'quota-day');
    assert.ok(Math.abs(day.retryAfterMs - (23.5 * 3600 + 60) * 1000) < 2000, `sisa ±23,5 jam, dapat ${day.retryAfterMs}`);
    assert.deepEqual(classifyGeminiError(429, QUOTA_MINUTE, now).kind, 'quota-minute');
    assert.equal(classifyGeminiError(429, QUOTA_MINUTE, now).retryAfterMs, 37000);
    assert.equal(classifyGeminiError(429, geminiErr(429, 'RESOURCE_EXHAUSTED', 'Please retry in 20.5s.'), now).retryAfterMs, 20500);
    assert.equal(classifyGeminiError(404, geminiErr(404, 'NOT_FOUND', 'models/x is not found'), now).kind, 'model');
    assert.equal(classifyGeminiError(403, geminiErr(403, 'PERMISSION_DENIED', 'Your API key was reported as leaked.'), now).kind, 'config');
    assert.equal(classifyGeminiError(400, geminiErr(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [{ reason: 'API_KEY_INVALID' }]), now).kind, 'config');
    assert.equal(classifyGeminiError(400, geminiErr(400, 'INVALID_ARGUMENT', 'thinking_level is not supported by this model.'), now).kind, 'thinking');
    assert.equal(classifyGeminiError(503, geminiErr(503, 'UNAVAILABLE', 'The model is overloaded.'), now).kind, 'overload');
    assert.equal(classifyGeminiError(500, '<html>bukan json</html>', now).kind, 'overload');
    const ms = msUntilPacificMidnight();
    assert.ok(ms >= 60_000 && ms <= 25 * 3600 * 1000);

    assert.deepEqual(extractText(JSON.parse(geminiOk('1|Halo'))), { text: '1|Halo', finishReason: 'STOP', blockReason: '' });
    assert.equal(extractText({ promptFeedback: { blockReason: 'SAFETY' } }).blockReason, 'SAFETY');
});

/* ------------------------------------------------------------------ */
/* createGemini (klien palsu)                                          */
/* ------------------------------------------------------------------ */
function fakeGeminiClient(handler) {
    const calls = [];
    return {
        calls,
        async request(url, opts) {
            const body = JSON.parse(opts.body);
            const model = /models\/([^:]+):generateContent$/.exec(url)?.[1];
            calls.push({ url, model, opts, body });
            const r = await handler({ model, body, n: calls.filter((c) => c.model === model).length });
            if (r instanceof Error) throw r;
            return { status: r.status || 200, text: r.text, headers: new Headers(), url };
        },
    };
}
const askBody = { system: 'S', prompt: 'Translate these 1 subtitle rows into Indonesian.\n\n1|Hello', deadline: Date.now() + 30000 };

test('createGemini: request resmi (POST, x-goog-api-key, thinking minimal, passErrors), teks tanpa thought', async () => {
    const client = fakeGeminiClient(() => ({ text: geminiOk('1|Halo') }));
    const g = createGemini({ client, apiKey: 'kunci-rahasia', apiBase: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-3.6-flash'] });
    const r = await g.generate({ ...askBody, deadline: Date.now() + 30000 });
    assert.deepEqual([r.model, r.text], ['gemini-3.6-flash', '1|Halo']);
    const c = client.calls[0];
    assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
    assert.equal(c.opts.method, 'POST');
    assert.equal(c.opts.headers['x-goog-api-key'], 'kunci-rahasia');
    assert.ok(!c.url.includes('kunci-rahasia'), 'key tidak di URL');
    assert.equal(c.opts.passErrors, true);
    assert.deepEqual(c.body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
    assert.equal(c.body.systemInstruction.parts[0].text, 'S');
    assert.equal(c.body.contents[0].parts[0].text, askBody.prompt);
    assert.equal(c.body.safetySettings, undefined, 'default Off untuk Gemini 2.5+');
    assert.deepEqual(g.health(), { models: [{ model: 'gemini-3.6-flash', status: 'ready' }] });
});

test('createGemini: kuota harian model utama → cadangan dipakai & utama didinginkan; semua habis → AI_QUOTA', async () => {
    let liteQuota = false;
    const client = fakeGeminiClient(({ model }) => {
        if (model === 'gemini-3.6-flash') return { status: 429, text: QUOTA_DAY };
        return liteQuota ? { status: 429, text: QUOTA_MINUTE } : { text: geminiOk('1|Halo (lite)') };
    });
    const g = createGemini({ client, apiKey: 'k', apiBase: 'https://x.test/v1beta', models: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'] });
    assert.equal((await g.generate({ ...askBody, deadline: Date.now() + 30000 })).model, 'gemini-3.5-flash-lite');
    assert.equal((await g.generate({ ...askBody, deadline: Date.now() + 30000 })).model, 'gemini-3.5-flash-lite');
    assert.equal(client.calls.filter((c) => c.model === 'gemini-3.6-flash').length, 1, 'model utama tidak dihantam lagi selama didinginkan');
    assert.equal(g.health().models[0].status, 'quota-day');
    liteQuota = true;
    await assert.rejects(g.generate({ ...askBody, deadline: Date.now() + 30000 }), (err) => {
        assert.equal(err.code, 'AI_QUOTA');
        assert.equal(err.status, 503);
        assert.equal(err.retryAfter, 37, 'retry terdekat (per menit)');
        return true;
    });
});

test('createGemini: key ditolak → AI_CONFIG tanpa mencoba model lain; thinking ditolak → ulang tanpa thinking; error jaringan/blokir → model berikutnya', async () => {
    const bad = fakeGeminiClient(() => ({ status: 403, text: geminiErr(403, 'PERMISSION_DENIED', 'Your API key was reported as leaked.') }));
    const g1 = createGemini({ client: bad, apiKey: 'k', apiBase: 'https://x.test/v1beta', models: ['a-1', 'b-2'] });
    await assert.rejects(g1.generate({ ...askBody, deadline: Date.now() + 30000 }), (err) => err.code === 'AI_CONFIG');
    assert.equal(bad.calls.length, 1);

    const thinking = fakeGeminiClient(({ body }) => (body.generationConfig.thinkingConfig
        ? { status: 400, text: geminiErr(400, 'INVALID_ARGUMENT', 'Thinking level minimal is not supported for this model.') }
        : { text: geminiOk('1|Halo') }));
    const g2 = createGemini({ client: thinking, apiKey: 'k', apiBase: 'https://x.test/v1beta', models: ['gemini-3.6-flash'] });
    assert.equal((await g2.generate({ ...askBody, deadline: Date.now() + 30000 })).text, '1|Halo');
    assert.equal(thinking.calls.length, 2);
    assert.equal(thinking.calls[1].body.generationConfig.thinkingConfig, undefined);

    const flaky = fakeGeminiClient(({ model }) => {
        if (model === 'm-1') return Object.assign(new Error('putus'), { kind: 'network' });
        if (model === 'm-2') return { text: JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }) };
        return { text: geminiOk('1|Halo m3') };
    });
    const g3 = createGemini({ client: flaky, apiKey: 'k', apiBase: 'https://x.test/v1beta', models: ['m-1', 'm-2', 'm-3'] });
    assert.equal((await g3.generate({ ...askBody, deadline: Date.now() + 30000 })).model, 'm-3');
    assert.equal(g3.health().models[0].status, 'overload');
    assert.equal(g3.health().models[1].status, 'ready', 'blokir isi tidak mendinginkan model');

    const timeout = fakeGeminiClient(() => Object.assign(new Error('lama'), { kind: 'timeout' }));
    const g4 = createGemini({ client: timeout, apiKey: 'k', apiBase: 'https://x.test/v1beta', models: ['t-1'] });
    await assert.rejects(g4.generate({ ...askBody, deadline: Date.now() + 30000 }), (err) => err.code === 'AI_TIMEOUT' && err.status === 504);
});

test('createGemini lewat fetcher SUNGGUHAN + server lokal: header key terkirim, body error 429 terbaca (passErrors)', async () => {
    const seen = [];
    const upstream = await startServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            seen.push({ url: req.url, key: req.headers['x-goog-api-key'], type: req.headers['content-type'], body: JSON.parse(raw) });
            if (req.url.includes('kuota-habis')) {
                res.writeHead(429, { 'content-type': 'application/json' });
                res.end(QUOTA_DAY);
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(geminiOk(fakeTranslate(JSON.parse(raw).contents[0].parts[0].text)));
        });
    });
    try {
        const network = createNetwork();
        const client = createClient(network, { source: 'gemini', allowedHosts: ['127.0.0.1'], robots: false, intervalMs: 0, retries: 0, timeoutMs: 5000 });
        const g = createGemini({ client, apiKey: 'kunci-lokal', apiBase: `${upstream.url}/v1beta`, models: ['kuota-habis', 'gemini-3.5-flash-lite'] });
        const r = await g.generate({ ...askBody, deadline: Date.now() + 10000 });
        assert.equal(r.model, 'gemini-3.5-flash-lite');
        assert.equal(r.text, '1|ID: Hello');
        assert.deepEqual(seen.map((s) => s.url), ['/v1beta/models/kuota-habis:generateContent', '/v1beta/models/gemini-3.5-flash-lite:generateContent']);
        assert.ok(seen.every((s) => s.key === 'kunci-lokal' && s.type === 'application/json'));
        assert.equal(g.health().models[0].status, 'quota-day');
    } finally {
        await upstream.close();
    }
});

/* ------------------------------------------------------------------ */
/* translatePart                                                       */
/* ------------------------------------------------------------------ */
const CUES = parseVtt([
    'WEBVTT', '',
    '00:00:01.000 --> 00:00:02.000', 'Hello &amp; welcome', '',
    '00:00:03.000 --> 00:00:04.000 line:5%', '<i>Sign</i>', '',
    '00:00:05.000 --> 00:00:06.000', '♪ ♪', '',
    '00:00:07.000 --> 00:00:08.000', 'Hello &amp; welcome', '',
    '00:00:09.000 --> 00:00:10.000', 'Bye', '',
].join('\n'));

test('translatePart: teks kembar sekali kirim, simbol tidak dikirim, pengaturan cue dipertahankan, hasil di-escape', async () => {
    const prompts = [];
    const gemini = { async generate(q) { prompts.push(q.prompt); return { model: 'gemini-3.6-flash', text: fakeTranslate(q.prompt) }; } };
    const r = await translatePart(gemini, CUES, { from: 0, to: CUES.length }, { sourceLang: 'en', deadline: Date.now() + 30000 });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /^Translate these 3 subtitle rows from English/);
    assert.ok(!prompts[0].includes('♪'));
    assert.deepEqual(r.cues, [
        [1, 2, 'ID: Hello &amp; welcome', ''],
        [3, 4, 'ID: <i>Sign</i>', 'line:5%'],
        [5, 6, '♪ ♪', ''],
        [7, 8, 'ID: Hello &amp; welcome', ''],
        [9, 10, 'ID: Bye', ''],
    ]);
    assert.deepEqual([r.model, r.untranslated, r.calls], ['gemini-3.6-flash', 0, 1]);
});

test('translatePart: baris terlewat diminta ulang sekali; tetap hilang → baris asli + dihitung untranslated', async () => {
    let n = 0;
    const gemini = {
        async generate(q) {
            n++;
            if (n === 1) return { model: 'm', text: fakeTranslate(q.prompt, { drop: [3] }) }; // "Bye" terlewat
            return { model: 'm', text: '' }; // susulan juga gagal
        },
    };
    const r = await translatePart(gemini, CUES, { from: 0, to: CUES.length }, { sourceLang: 'en', deadline: Date.now() + 30000 });
    assert.equal(r.calls, 2);
    assert.equal(r.untranslated, 1);
    assert.equal(r.cues[4][2], 'Bye', 'tetap bahasa asli, bukan teks karangan');
});

test('translatePart: format jawaban rusak → coba model lain sekali → tetap rusak = AI_BAD_OUTPUT', async () => {
    const skips = [];
    const gemini = { async generate(q) { skips.push(q.skip || []); return { model: q.skip?.length ? 'lite' : 'flash', text: 'Maaf, saya tidak bisa.' }; } };
    await assert.rejects(translatePart(gemini, CUES, { from: 0, to: 5 }, { deadline: Date.now() + 30000 }), (err) => err.code === 'AI_BAD_OUTPUT');
    assert.deepEqual(skips, [[], ['flash']]);
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
const fakeRegistry = () => ({
    async latest() { return { source: 'x', data: [], fallback: false, stale: false, errors: [] }; },
    health: () => ({ sources: [], metadata: { enabled: false }, cache: { entries: 0 } }),
});
const fakeStreams = (servers) => ({ async servers() { return { servers, status: { anizone: 'ok' }, errors: [] }; }, health: () => [] });
const EN_ASS = 'https://suzaku.xin-cdn.xyz/u/subtitles/1_en.ass';
const ASS_TEXT = [
    '[Script Info]', 'PlayResY: 1080', '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello there!',
    'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\an8}Where are you going?',
    'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,Wait for me!',
    'Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,I said wait!',
    'Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,Fine.',
].join('\n');

function fakeMedia() {
    const calls = [];
    return {
        calls,
        async stream(url) {
            calls.push(url);
            if (url !== EN_ASS) return { status: 404, headers: new Headers(), body: new Response('nope').body, url };
            return { status: 200, headers: new Headers({ 'content-type': 'text/plain' }), body: new Response(ASS_TEXT).body, url };
        },
    };
}

async function withApp(opts, fn) {
    const signer = createSigner(SECRET);
    const app = createApp({ registry: fakeRegistry(), log: false, rateLimitPerMinute: 0, proxyRateLimitPerMinute: 0, aiRateLimitPerMinute: 0, budgetMs: 5000, signer, ...opts });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        await fn(`http://127.0.0.1:${server.address().port}`, signer);
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
}

const hlsServer = (subtitles) => ({ provider: 'anizone', kind: 'hls', name: 'AniZone', lang: 'multi', src: 'https://suzaku.xin-cdn.xyz/u/master.m3u8', subtitles });
const EN_SUB = { label: 'English', lang: 'en', format: 'ass', file: EN_ASS, default: true };
const ID_SUB = { label: 'Indonesia', lang: 'id', format: 'ass', file: 'https://suzaku.xin-cdn.xyz/u/subtitles/8_id.ass', default: true };

function countingGemini() {
    const g = {
        calls: 0,
        async generate(q) {
            g.calls++;
            return { model: 'gemini-3.6-flash', text: fakeTranslate(q.prompt) };
        },
        health: () => ({ models: [{ model: 'gemini-3.6-flash', status: 'ready' }] }),
    };
    return g;
}

test('GET /api/stream/servers: `ai` ditawarkan (URL ditandatangani) hanya bila subtitle Indonesia tidak ada & AI aktif', async () => {
    const gemini = countingGemini();
    await withApp({ streams: fakeStreams([hlsServer([EN_SUB, { ...EN_SUB, label: 'English (SDH)', file: EN_ASS.replace('1_en', '2_en') }])]), mediaClient: fakeMedia(), gemini, aiConfig: AI_CONFIG }, async (base, signer) => {
        const json = await (await fetch(`${base}/api/stream/servers?ep=1&anilist=1`)).json();
        const ai = json.data.servers[0].ai;
        assert.deepEqual([ai.from, ai.sourceLabel, ai.label], ['en', 'English', 'Indonesia (AI)']);
        const u = new URL(ai.url, base);
        assert.equal(u.pathname, '/api/stream/subai');
        assert.equal(decodeTarget(u.searchParams.get('u')), EN_ASS);
        assert.ok(signer.verify(`${EN_ASS}|ai|ass|en|1`, u.searchParams.get('s')));
        const health = await (await fetch(`${base}/api/health`)).json();
        assert.equal(health.data.aiSubtitles.enabled, true);
        assert.ok(!JSON.stringify(health).includes('kunci-uji'), 'key tidak pernah keluar');
    });
    await withApp({ streams: fakeStreams([hlsServer([ID_SUB, EN_SUB])]), mediaClient: fakeMedia(), gemini: countingGemini(), aiConfig: AI_CONFIG }, async (base) => {
        const json = await (await fetch(`${base}/api/stream/servers?ep=1&anilist=1`)).json();
        assert.equal(json.data.servers[0].ai, null, 'Indonesia ada → tanpa AI');
    });
    await withApp({ streams: fakeStreams([hlsServer([EN_SUB])]), mediaClient: fakeMedia(), gemini: null }, async (base) => {
        const json = await (await fetch(`${base}/api/stream/servers?ep=1&anilist=1`)).json();
        assert.equal(json.data.servers[0].ai, null, 'tanpa GEMINI_API_KEY → tanpa AI');
        const r = await fetch(`${base}/api/stream/subai?u=x&f=ass&l=en&v=1&s=x&p=0`);
        assert.equal(r.status, 503);
        assert.equal((await r.json()).code, 'AI_DISABLED');
    });
});

test('GET /api/stream/subai: validasi & tanda tangan, bagian diterjemahkan + cache CDN lama, cache memori & dedupe, error kuota no-store', async () => {
    const gemini = countingGemini();
    const media = fakeMedia();
    await withApp({ streams: fakeStreams([hlsServer([EN_SUB])]), mediaClient: media, gemini, aiConfig: AI_CONFIG }, async (base) => {
        const json = await (await fetch(`${base}/api/stream/servers?ep=1&anilist=1`)).json();
        const url = `${base}${json.data.servers[0].ai.url}`;

        const [r0, r0b] = await Promise.all([fetch(`${url}&p=0`), fetch(`${url}&p=0`)]);
        assert.equal(r0.status, 200);
        assert.match(r0.headers.get('cache-control'), /s-maxage=2592000, immutable/);
        const d0 = (await r0.json()).data;
        await r0b.json();
        assert.equal(gemini.calls, 1, 'dua request bersamaan → satu panggilan Gemini');
        assert.deepEqual([d0.part, d0.parts, d0.lang, d0.label, d0.model, d0.untranslated], [0, 2, 'id', 'Indonesia (AI)', 'gemini-3.6-flash', 0]);
        assert.deepEqual(d0.ranges, [[1, 7], [7, 10]], 'partLines 3 → 2 bagian');
        assert.deepEqual(d0.cues, [[1, 2, 'ID: Hello there!', ''], [3, 4, 'ID: Where are you going?', 'line:5%'], [5, 6, 'ID: Wait for me!', '']]);
        const d1 = (await (await fetch(`${url}&p=1`)).json()).data;
        assert.deepEqual(d1.cues.map((c) => c[2]), ['ID: I said wait!', 'ID: Fine.']);
        await fetch(`${url}&p=0`);
        assert.equal(gemini.calls, 2, 'bagian 0 diambil dari cache memori');
        assert.equal(media.calls.length, 1, 'subtitle sumber diambil sekali');

        assert.equal((await fetch(`${url}&p=2`)).status, 404);
        assert.equal((await fetch(`${url}&p=x`)).status, 400);
        assert.equal((await fetch(`${url}&p=0&bust=1`)).status, 400, 'parameter asing ditolak (anti pembobol cache)');
        assert.equal((await fetch(url.replace(/s=[^&]+/, 's=palsu'))).status, 403);
        assert.equal((await fetch(url.replace('l=en', 'l=fr'))).status, 403, 'bahasa sumber ikut ditandatangani');
        const u = new URL(url);
        const target = decodeTarget(u.searchParams.get('u'));
        const signer = createSigner(SECRET);
        const v2 = `${base}/api/stream/subai?u=${encodeTarget(target)}&f=ass&l=en&v=2&s=${signer.sign(`${target}|ai|ass|en|2`)}&p=0`;
        const stale = await fetch(v2);
        assert.equal(stale.status, 409);
        assert.equal((await stale.json()).code, 'AI_STALE');
    });

    const quota = {
        async generate() { throw new AppError('Kuota harian terjemahan AI (Gemini) sudah habis.', { status: 503, code: 'AI_QUOTA', retryAfter: 50000 }); },
        health: () => ({ models: [] }),
    };
    await withApp({ streams: fakeStreams([hlsServer([EN_SUB])]), mediaClient: fakeMedia(), gemini: quota, aiConfig: AI_CONFIG }, async (base) => {
        const json = await (await fetch(`${base}/api/stream/servers?ep=1&anilist=1`)).json();
        const r = await fetch(`${base}${json.data.servers[0].ai.url}&p=0`);
        assert.equal(r.status, 503);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        assert.equal(r.headers.get('retry-after'), '3600');
        assert.equal((await r.json()).code, 'AI_QUOTA');
    });
});

test('GET /api/stream/subai: rate limit per IP terpisah dari proxy', async () => {
    await withApp({ streams: fakeStreams([hlsServer([EN_SUB])]), mediaClient: fakeMedia(), gemini: countingGemini(), aiConfig: AI_CONFIG, aiRateLimitPerMinute: 2 }, async (base) => {
        const json = await (await fetch(`${base}/api/stream/servers?ep=1&anilist=1`)).json();
        const url = `${base}${json.data.servers[0].ai.url}&p=0`;
        assert.equal((await fetch(url)).status, 200);
        assert.equal((await fetch(url)).status, 200);
        const third = await fetch(url);
        assert.equal(third.status, 429);
        assert.equal((await third.json()).code, 'RATE_LIMITED');
        assert.equal((await fetch(`${base}/api/stream/sub?u=x&f=ass&s=x`)).status, 403, '/sub tidak ikut terkena batas AI');
    });
});

test('createAiSubtitleService: subtitle sumber kosong → 404; bagian dengan baris asli di-cache lebih pendek', async () => {
    const svc = createAiSubtitleService({
        gemini: { async generate(q) { return { model: 'm', text: fakeTranslate(q.prompt, { drop: [1] }) }; }, health: () => ({ models: [] }) },
        config: { ...AI_CONFIG, partLines: 10 },
        loadVtt: async (target) => (target === 'kosong' ? 'WEBVTT\n\n' : 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n\n00:00:03.000 --> 00:00:04.000\nTwo\n'),
    });
    await assert.rejects(svc.translate({ target: 'kosong', format: 'vtt', sourceLang: 'en', part: 0 }), (err) => err.status === 404);
    const r = await svc.translate({ target: 'ada', format: 'vtt', sourceLang: 'en', part: 0 });
    assert.equal(r.untranslated, 1);
    assert.deepEqual(r.cues.map((c) => c[2]), ['One', 'ID: Two']);
});
