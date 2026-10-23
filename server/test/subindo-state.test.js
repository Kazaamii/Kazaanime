import test from 'node:test';
import assert from 'node:assert/strict';

// js/api/http.js memasang listener `online` saat modul dimuat; stub minimal
// supaya helper UI bisa diuji tanpa DOM (pola sama seperti frontend-media.test.js).
globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
};

const state = await import('../../js/ui/subindo-state.js');
const { isPolicyStop, safeHomeUrl, sourceDiagnosis, sourceStatusLabel } = state;
const { ApiError } = await import('../../js/api/http.js');

const blocked = (status = 0) => new ApiError('Cloudflare', { kind: 'blocked', status, source: 'animeku' });

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

test('sourceStatusLabel hanya menghitung judul — tanpa label verifikasi', () => {
    assert.equal(sourceStatusLabel({}, 24), '24 judul');
    assert.equal(sourceStatusLabel({ stale: true }, 12), '12 judul · cache');
    assert.equal(sourceStatusLabel({ error: blocked(403) }, 0), 'Akses dibatasi');
    assert.equal(sourceStatusLabel({ error: new ApiError('x', { kind: 'parse' }) }, 0), 'Sumber bermasalah');
    // Judul yang ada tetap menang atas kegagalan jaringan.
    assert.equal(sourceStatusLabel({ error: new ApiError('x', { kind: 'parse' }) }, 5), '5 judul');
    for (const label of ['terverifikasi', 'Tanpa bukti', 'Sebagian dicek', 'Batas waktu']) {
        assert.doesNotMatch(sourceStatusLabel({}, 3), new RegExp(label));
    }
});

test('sourceDiagnosis memakai pesan spesifik backend, bukan kalimat verifikasi', () => {
    assert.equal(
        sourceDiagnosis({ error: new ApiError('apa pun', { kind: 'blocked', status: 403 }) }),
        'Sumber menolak akses (HTTP 403); permintaan dihentikan tanpa menerobos pembatasan.',
    );
    assert.match(sourceDiagnosis({ stale: true }), /cache/);
    assert.match(sourceDiagnosis({}), /tidak mengirim judul/);
    assert.doesNotMatch(sourceDiagnosis({}), /subtitle|bukti|verifikasi/i);
});

test('safeHomeUrl hanya meloloskan tautan http(s)', () => {
    assert.equal(safeHomeUrl('https://ww2.animeku.lol'), 'https://ww2.animeku.lol');
    assert.equal(safeHomeUrl(' http://oploverz.ch/ '), 'http://oploverz.ch/');
    assert.equal(safeHomeUrl('javascript:alert(1)'), '');
    assert.equal(safeHomeUrl('data:text/html,<b>x</b>'), '');
    assert.equal(safeHomeUrl(''), '');
    assert.equal(safeHomeUrl(undefined), '');
});

test('helper verifikasi lama sudah dihapus dari modul', () => {
    assert.equal(state.evidenceSummary, undefined);
    assert.equal(state.issuesSummary, undefined);
});
