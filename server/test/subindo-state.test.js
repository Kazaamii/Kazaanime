import test from 'node:test';
import assert from 'node:assert/strict';

// js/api/http.js memasang listener `online` saat modul dimuat; stub minimal
// supaya helper UI bisa diuji tanpa DOM (pola sama seperti frontend-media.test.js).
globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
};

const { evidenceSummary, isPolicyStop, issuesSummary, safeHomeUrl, sourceDiagnosis, sourceStatusLabel } =
    await import('../../js/ui/subindo-state.js');
const { ApiError } = await import('../../js/api/http.js');

const blocked = (status = 0) => new ApiError('Cloudflare', { kind: 'blocked', status, source: 'otakudesu' });

test('isPolicyStop membedakan pembatasan situs dari halaman/struktur yang rusak', () => {
    assert.equal(isPolicyStop({ error: blocked(403) }), true);
    assert.equal(isPolicyStop({ error: new ApiError('x', { kind: 'policy', status: 404 }) }), true);
    assert.equal(isPolicyStop({ error: new ApiError('x', { kind: 'rate_limited', status: 429 }) }), true);
    assert.equal(isPolicyStop({ error: new ApiError('x', { kind: 'robots', status: 503, stage: 'robots' }) }), true);
    assert.equal(isPolicyStop({ error: new ApiError('x', { kind: 'parse' }) }), false);
    assert.equal(isPolicyStop({ error: new ApiError('x', { kind: 'timeout' }) }), false);
    assert.equal(isPolicyStop({}), false);
    assert.equal(isPolicyStop(null), false);
});

test('sourceStatusLabel memakai label yang jujur untuk tiap keadaan panel', () => {
    assert.equal(sourceStatusLabel({ error: blocked(403) }), 'Akses dibatasi');
    assert.equal(sourceStatusLabel({ error: new ApiError('x', { kind: 'parse' }) }), 'Sumber bermasalah');
    assert.equal(sourceStatusLabel({ timedOut: true }), 'Batas waktu');
    assert.equal(sourceStatusLabel({ failedChecks: 2 }), 'Sebagian dicek');
    assert.equal(sourceStatusLabel({ stale: true }), 'Data cache');
    assert.equal(sourceStatusLabel({}, 3), '3 terverifikasi');
    assert.equal(sourceStatusLabel({}, 0), 'Belum ada terverifikasi');
});

test('sourceDiagnosis memakai pesan spesifik backend, bukan kalimat generik', () => {
    assert.equal(
        sourceDiagnosis({ error: new ApiError('apa pun', { kind: 'blocked', status: 403 }) }),
        'Sumber menolak akses (HTTP 403); permintaan dihentikan tanpa menerobos pembatasan.',
    );
    assert.match(sourceDiagnosis({ timedOut: true }), /Batas waktu/);
    assert.match(sourceDiagnosis({ failedChecks: 1 }), /Pemeriksaan server episode gagal/);
    assert.match(sourceDiagnosis({ stale: true }), /cache/);
    assert.match(sourceDiagnosis({}), /subtitle Indonesia/);
});

test('issuesSummary menggabungkan sebab yang sama dan menyebut situsnya', () => {
    const summary = issuesSummary([
        { id: 'samehadaku', name: 'Samehadaku', error: blocked(403), items: [] },
        { id: 'otakudesu', name: 'Otakudesu', error: blocked(403), items: [] },
        { id: 'sakunime', name: 'Sakunime', error: new ApiError('x', { kind: 'parse' }), items: [] },
        { id: 'kuramanime', name: 'Kuramanime', items: [{ title: 'A' }] },
    ]);
    assert.equal(summary.count, 3);
    assert.equal(summary.causes.length, 2, 'dua situs dengan sebab identik jadi satu baris');
    assert.deepEqual(summary.causes[0].names, ['Samehadaku', 'Otakudesu']);
    assert.match(summary.text, /^Penyebab: /);
    assert.match(summary.text, /\(Samehadaku, Otakudesu\)/);
    assert.match(summary.text, /\(Sakunime\)/);
    assert.match(summary.text, /Judul tanpa bukti Sub Indo tidak ditampilkan\.$/);
});

test('issuesSummary menghitung batas waktu dan pemeriksaan sebagian, serta kosong saat sehat', () => {
    const healthy = issuesSummary([{ name: 'Samehadaku', items: [{ title: 'A' }] }, null]);
    assert.deepEqual(healthy, { count: 0, causes: [], text: '' });

    const partial = issuesSummary([
        { name: 'Samehadaku', timedOut: true },
        { name: 'Sakunime', failedChecks: 2 },
    ]);
    assert.equal(partial.count, 2);
    assert.deepEqual(partial.causes.map((cause) => cause.message), [
        'Batas waktu verifikasi tercapai.',
        'Sebagian episode belum bisa diperiksa.',
    ]);
});

test('label "tanpa bukti" jujur saat episode terbaca tetapi tidak menyatakan Sub Indo', () => {
    assert.equal(sourceStatusLabel({ unproven: 3 }, 0), 'Tanpa bukti subtitle');
    assert.match(sourceDiagnosis({ unproven: 2 }), /tidak menyatakan subtitle Indonesia/);
    // Bukti yang ada tetap menang atas status "tanpa bukti".
    assert.equal(sourceStatusLabel({ unproven: 3 }, 2), '2 terverifikasi');
});

test('evidenceSummary merangkum jenis bukti dari judul yang lolos verifikasi', () => {
    assert.equal(evidenceSummary([{ subtitleEvidence: 'episode-title' }, { subtitleEvidence: 'download-label' }]), 'judul episode, label download');
    assert.equal(evidenceSummary([{ subtitleEvidence: 'episode-title' }, { subtitleEvidence: 'episode-title' }]), 'judul episode');
    assert.equal(evidenceSummary([{}]), '');
    assert.equal(evidenceSummary(null), '');
});

test('safeHomeUrl hanya meloloskan tautan http(s)', () => {
    assert.equal(safeHomeUrl('https://samehadaku.how'), 'https://samehadaku.how');
    assert.equal(safeHomeUrl(' http://otakudesu.blog/ '), 'http://otakudesu.blog/');
    assert.equal(safeHomeUrl('javascript:alert(1)'), '');
    assert.equal(safeHomeUrl('data:text/html,<b>x</b>'), '');
    assert.equal(safeHomeUrl(''), '');
    assert.equal(safeHomeUrl(undefined), '');
});
