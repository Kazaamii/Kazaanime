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
});

test('laporan bukti: AnimeKu & Oploverz terbukti dari halaman episode, bukan dari nama situs', () => {
    for (const [source, detail] of [['animeku', /sub indo/i], ['oploverz', /subtitle indonesia/i]]) {
        const positive = rows.find((item) => item.source === source && item.proven > 0);
        assert.ok(positive, `${source} tanpa baris terbukti`);
        assert.equal(positive.evidence, 'episode-title', source);
        assert.match(positive.detail, detail, source);

        const negative = rows.find((item) => item.source === source && item.note.includes('kontrol negatif'));
        assert.ok(negative, `${source} tanpa kontrol negatif`);
        assert.equal(negative.proven, 0, `${source} kontrol negatif tidak boleh lolos`);
        assert.equal(negative.unproven, negative.servers, source);
        assert.equal(negative.evidence, '', source);
    }
});

test('laporan bukti: ringkasan menghitung halaman, bukan nama situs', () => {
    const sum = summarize(rows);
    assert.equal(sum.pages, rows.length);
    assert.equal(sum.proven + sum.unproven, sum.pages);
    assert.ok(sum.unproven >= 2, 'kontrol negatif harus muncul sebagai tanpa bukti');
    assert.ok(sum.provenServers < sum.servers, 'tidak semua server boleh otomatis ber-label Indonesia');
});

test('laporan bukti: sumber pengganti (AnimeKu, Oploverz) punya kontrol negatif halaman yang sama', () => {
    for (const source of ['animeku', 'oploverz']) {
        const cases = CASES.filter((item) => item.source === source);
        assert.equal(cases.length, 2, `${source} harus punya 1 halaman + 1 kontrol negatif`);
        assert.ok(cases.some((item) => item.strip), `${source} tanpa kontrol negatif`);
        const [positive, negative] = evidenceReport(cases);
        assert.equal(positive.proven, 1, source);
        assert.equal(negative.proven, 0, source);
        assert.equal(negative.detail, '', `${source} kontrol negatif tidak boleh punya kutipan bukti`);
        assert.match(positive.detail, /sub/i, `${source} kontrol positif harus mengutip penanda`);
    }
});

test('laporan bukti: setiap kasus menunjuk fixture yang benar-benar ada', () => {
    assert.ok(CASES.length >= 11);
    for (const item of CASES) {
        assert.ok(item.parse, `${item.file} tanpa parser`);
        assert.equal(typeof item.base, 'string');
    }
});
