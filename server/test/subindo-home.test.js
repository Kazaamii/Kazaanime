import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSubIndoSources, loadSubIndoSources, panelSections } from '../../js/api/subindo.js';

/**
 * 24 Okt 2026: verifikasi per episode dihapus. Panel beranda hanya mengelompokkan
 * katalog AnimeKu & Oploverz dari backend — tanpa memanggil endpoint episode.
 */

const item = (title, extra = {}) => ({ title, slug: `animeku~${title.toLowerCase()}`, source: 'backend:animeku', latestEpisode: 5, ...extra });

const catalog = (sections) => ({ sections, fallback: false, stale: false });

test('panel beranda hanya AnimeKu & Oploverz, katalog ditampilkan apa adanya', () => {
    const sections = groupSubIndoSources(catalog([
        { id: 'samehadaku', name: 'Samehadaku', items: [item('Lama'), item('Lama')] },
        { id: 'animeku', name: 'AnimeKu', browse: true, items: [item('Douluo Dalu'), item('Ni Tian Zhizun')] },
        { id: 'oploverz', name: 'Oploverz (Animeloverz)', browse: true, items: [item('Good Night World')] },
        { id: 'otakudesu', name: 'Otakudesu', items: [] },
        { id: 'kuramanime', name: 'Kuramanime', items: [] },
        { id: 'sakunime', name: 'Sakunime', items: [] },
    ]));
    assert.deepEqual(sections.map((source) => source.id), ['animeku', 'oploverz']);
    assert.deepEqual(sections[0].items.map((anime) => anime.title), ['Douluo Dalu', 'Ni Tian Zhizun']);
    assert.equal(sections[0].browse, true);
    assert.equal(sections[0].total, 2);
});

test('tidak ada penyaringan bukti: judul tanpa subtitleEvidence tetap tampil', () => {
    // Di versi lama judul seperti ini dibuang karena tidak lolos pemeriksaan episode.
    const [animeku] = groupSubIndoSources(catalog([
        { id: 'animeku', items: [item('Tanpa Bukti'), item('Bukti Lama', { subtitleEvidence: 'episode-title' })] },
    ]));
    assert.deepEqual(animeku.items.map((anime) => anime.title), ['Tanpa Bukti', 'Bukti Lama']);
    assert.equal(animeku.items[0].subtitleEvidence, undefined);
    assert.equal(animeku.items[0].latestEpisode, 5, 'nomor episode dari backend tidak diubah');
});

test('judul ganda dibuang dan batas judul per panel dihormati', () => {
    const many = Array.from({ length: 30 }, (_, index) => item(`Judul ${index + 1}`));
    const [animeku] = groupSubIndoSources(catalog([
        { id: 'animeku', items: [...many, item('Judul 1'), { title: '' }, null] },
    ]), { limit: 24 });
    assert.equal(animeku.items.length, 24);
    assert.equal(animeku.total, 30);
    assert.equal(new Set(animeku.items.map((anime) => anime.title)).size, 24);
});

test('sourceIds membatasi panel ke situs yang diminta (tombol coba lagi)', () => {
    const data = catalog([
        { id: 'animeku', name: 'AnimeKu', items: [item('Satu')] },
        { id: 'oploverz', name: 'Oploverz', items: [item('Dua')] },
    ]);
    assert.deepEqual(groupSubIndoSources(data, { sourceIds: ['oploverz'] }).map((source) => source.id), ['oploverz']);
    assert.deepEqual(groupSubIndoSources(data, { sourceIds: ['samehadaku'] }), [], 'situs yang sudah dihapus tidak bisa diminta');
});

test('loadSubIndoSources memakai katalog backend tanpa memanggil episode', async () => {
    const calls = [];
    const result = await loadSubIndoSources({
        getSources: async (opts) => {
            calls.push(opts);
            return catalog([{ id: 'animeku', items: [item('Satu')] }]);
        },
        sourceIds: ['animeku'],
        refresh: true,
    });
    assert.equal(result.unavailable, false);
    assert.deepEqual(result.sections.map((source) => source.id), ['animeku']);
    assert.equal(calls.length, 1, 'hanya satu permintaan katalog, tanpa pemeriksaan episode');
    assert.equal(calls[0].refresh, true);
});

test('loadSubIndoSources melaporkan fallback metadata sebagai tidak tersedia', async () => {
    const result = await loadSubIndoSources({
        getSources: async () => ({ sections: [{ id: 'animeku', items: [item('X')] }], fallback: true }),
    });
    assert.deepEqual(result, { sections: [], unavailable: true });
});

test('loadSubIndoSources menolak tanpa fungsi getSources', async () => {
    await assert.rejects(() => loadSubIndoSources({}), /getSources/);
});

test('panelSections menjaga urutan dan membuang section kosong/tak dikenal', () => {
    const sections = panelSections([{ id: 'oploverz' }, null, { id: 'ANIMEKU' }, { id: 'samehadaku' }, {}]);
    assert.deepEqual(sections.map((source) => source.id), ['oploverz', 'ANIMEKU']);
    assert.deepEqual(panelSections(null), []);
});
