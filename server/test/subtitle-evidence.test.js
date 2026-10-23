import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applySubtitleEvidence,
    detectSubtitleEvidence,
    isIndonesianLanguageTag,
    textShowsIndonesianSubtitle,
} from '../lib/subtitle-evidence.js';

test('tag bahasa Indonesia dikenali tanpa menyeret bahasa lain', () => {
    for (const tag of ['id', 'ID', 'ind', 'id-ID', 'in', 'Indonesian', 'Bahasa Indonesia']) {
        assert.equal(isIndonesianLanguageTag(tag), true, tag);
    }
    for (const tag of ['en', 'eng', 'jpn', 'ja', 'ms', '', null, undefined, 'idn-other']) {
        assert.equal(isIndonesianLanguageTag(tag), false, String(tag));
    }
});

test('teks subtitle Indonesia dikenali, tagline/istilah lain tidak', () => {
    assert.equal(textShowsIndonesianSubtitle('Episode 3 Subtitle Indonesia'), true);
    assert.equal(textShowsIndonesianSubtitle('Hardsub Indonesia Rumble'), true);
    assert.equal(textShowsIndonesianSubtitle('Sub Indo'), true);
    assert.equal(textShowsIndonesianSubtitle('Server (Sub English)'), false);
    assert.equal(textShowsIndonesianSubtitle('MP4 720p (Hardsub)'), false);
    assert.equal(textShowsIndonesianSubtitle('Nonton anime subtitle indonesia'), true);
    assert.equal(textShowsIndonesianSubtitle('Multi Sub'), false);
    // Label majemuk yang memang menyebut Indo tetap diterima; "Hardsub" saja tidak.
    assert.equal(textShowsIndonesianSubtitle('Hardsub Indo'), true);
    assert.equal(textShowsIndonesianSubtitle('Softsub Indo'), true);
    assert.equal(textShowsIndonesianSubtitle('Hardsub Multi'), false);
});

test('track subtitle adalah bukti terkuat', () => {
    const evidence = detectSubtitleEvidence({
        title: 'Episode 3',
        tracks: [{ lang: 'en', label: 'English' }, { lang: 'id', label: 'Indonesian' }],
        labels: ['Server (Sub Indo)'],
    });
    assert.deepEqual(evidence, { verified: true, evidence: 'subtitle-track', detail: 'Indonesian' });
});

test('judul episode, label download, label server, dan deskripsi episode semuanya diterima', () => {
    assert.equal(detectSubtitleEvidence({ title: 'Anime X Episode 3 Subtitle Indonesia' }).evidence, 'episode-title');
    assert.equal(detectSubtitleEvidence({ downloads: [{ quality: '720p', subtitle: 'Sub Indo' }] }).evidence, 'download-label');
    assert.equal(detectSubtitleEvidence({ labels: ['Mirror (Hardsub Indonesia)'] }).evidence, 'server-label');
    assert.equal(
        detectSubtitleEvidence({ pageText: 'download <b>Anime X Episode 3</b> HD Subtitle Indonesia terbaru di Situs!' }).evidence,
        'episode-page',
    );
});

test('tanpa bukti apa pun hasilnya kosong (bukan asumsi situs Indonesia)', () => {
    assert.deepEqual(detectSubtitleEvidence({}), { verified: false, evidence: '', detail: '' });
    assert.deepEqual(
        detectSubtitleEvidence({ title: 'Sousou no Frieren (Episode 28)', labels: ['Kuramadrive 720p'], downloads: [{ subtitle: '' }] }),
        { verified: false, evidence: '', detail: '' },
    );
});

test('applySubtitleEvidence menempel bukti dan membuang klaim bahasa tanpa bukti', () => {
    const verified = applySubtitleEvidence(
        [{ name: 'Server 1', url: 'https://cdn.test/1.mp4', subtitleType: 'hard' }],
        { title: 'Anime X Episode 3 Subtitle Indonesia' },
    );
    assert.deepEqual(verified.servers[0], {
        name: 'Server 1',
        url: 'https://cdn.test/1.mp4',
        subtitleType: 'hard',
        lang: 'id',
        subtitleEvidence: 'episode-title',
    });

    const unproven = applySubtitleEvidence(
        [{ name: 'Server 1', url: 'https://cdn.test/1.mp4', lang: 'id', subtitleType: 'hard' }],
        { title: 'Sousou no Frieren (Episode 28)' },
    );
    assert.equal(unproven.verified, false);
    assert.equal(unproven.evidence, '');
    assert.deepEqual(unproven.servers[0], { name: 'Server 1', url: 'https://cdn.test/1.mp4' });
});

test('bukti yang sudah eksplisit per server tidak ditimpa atau dibuang', () => {
    const result = applySubtitleEvidence(
        [{ name: 'Mirror (Sub Indo)', url: 'https://cdn.test/1.mp4', lang: 'id', subtitleEvidence: 'server-label' }],
        { title: 'Episode 3' },
    );
    assert.equal(result.servers[0].subtitleEvidence, 'server-label');
    assert.equal(result.servers[0].lang, 'id');
});
