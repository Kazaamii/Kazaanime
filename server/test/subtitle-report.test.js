import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, evidenceReport, summarize } from '../scripts/check-subtitle-evidence.js';

/**
 * Laporan `npm run check:subindo` adalah alat bukti yang dipakai untuk menjawab
 * "ini Sub Indo karena episode ini, atau karena situsnya memang situs Indonesia?".
 * Test ini menjaga agar laporannya tetap jujur: halaman bertanda bukti lolos,
 * halaman tanpa penanda dari situs yang sama TIDAK lolos.
 */
const rows = evidenceReport();

const row = (file) => rows.find((item) => item.file === file);

test('laporan bukti: halaman berpenanda terbukti, kontrol negatif tidak', () => {
    const positive = row('samehadaku-episode.html');
    assert.ok(positive.proven > 0);
    assert.equal(positive.evidence, 'episode-page');
    assert.match(positive.detail, /subtitle indonesia/i);

    const negative = row('samehadaku-fx-senshi-episode.html');
    assert.equal(negative.source, positive.source, 'kontrol negatif harus dari situs yang sama');
    assert.equal(negative.proven, 0);
    assert.equal(negative.unproven, negative.servers);
    assert.equal(negative.evidence, '');
});

test('laporan bukti: bukti dibaca dari judul episode, label download, atau label server', () => {
    assert.equal(row('otakudesu-episode.html').evidence, 'episode-title');
    assert.equal(row('sakunime-episode.html').evidence, 'episode-title');
    assert.equal(row('anoboy-episode.html').evidence, 'episode-title');
    assert.equal(row('animexin-episode.html').evidence, 'server-label');
    assert.equal(row('anichin-episode.html').evidence, 'episode-title');
});

test('laporan bukti: Kuramanime tidak mengklaim bahasa yang tidak ditulis halaman', () => {
    for (const file of ['kuramanime-episode.html', 'kuramanime-episode-public.html']) {
        const item = row(file);
        assert.equal(item.evidence, '', file);
        assert.equal(item.proven, 0, file);
    }
});

test('laporan bukti: ringkasan menghitung halaman, bukan nama situs', () => {
    const sum = summarize(rows);
    assert.equal(sum.pages, rows.length);
    assert.equal(sum.proven + sum.unproven, sum.pages);
    assert.ok(sum.unproven >= 2, 'kontrol negatif + Kuramanime harus muncul sebagai tanpa bukti');
    assert.ok(sum.provenServers < sum.servers, 'tidak semua server boleh otomatis ber-label Indonesia');
});

test('laporan bukti: setiap kasus menunjuk fixture yang benar-benar ada', () => {
    assert.ok(CASES.length >= 9);
    for (const item of CASES) {
        assert.ok(item.parse, `${item.file} tanpa parser`);
        assert.equal(typeof item.base, 'string');
    }
});
