import test from 'node:test';
import assert from 'node:assert/strict';
import {
    attachLocalSubtitleTrack,
    convertLocalSubtitle,
    MAX_LOCAL_SUBTITLE_BYTES,
    readLocalSubtitleFile,
} from '../../js/ui/local-subtitle.js';

test('local subtitle: SRT becomes valid WebVTT with CRLF, BOM, milliseconds and multiline captions normalized', () => {
    const srt = '\uFEFF1\r\n00:00:01,2 --> 00:00:03,003\r\n<i>Halo</i>\r\nApa kabar?\r\n\r\n2\r\n1:02:03,999 --> 1:02:05,0\r\nSampai jumpa.\r\n';
    assert.equal(convertLocalSubtitle(srt, 'srt'), [
        'WEBVTT',
        '',
        '00:00:01.200 --> 00:00:03.003',
        '<i>Halo</i>',
        'Apa kabar?',
        '',
        '01:02:03.999 --> 01:02:05.000',
        'Sampai jumpa.',
        '',
    ].join('\n'));
});

test('local subtitle: invalid or empty SRT cues are rejected', () => {
    assert.throws(
        () => convertLocalSubtitle('1\n00:61:00,000 --> 00:62:00,000\nTidak valid', 'srt'),
        /tidak dikenali|valid/i,
    );
    assert.throws(() => convertLocalSubtitle('', 'srt'), /tidak dikenali|valid/i);
});

test('local subtitle: WebVTT BOM and line endings are normalized; an invalid header is rejected', () => {
    const vtt = '\uFEFFWEBVTT - lokal\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHalo\r\n';
    assert.equal(convertLocalSubtitle(vtt, 'vtt'), 'WEBVTT - lokal\n\n00:00:01.000 --> 00:00:02.000\nHalo\n');
    assert.throws(() => convertLocalSubtitle('00:00:01.000 --> 00:00:02.000\nHalo', 'vtt'), /Header WebVTT/i);
    assert.throws(() => convertLocalSubtitle('text', 'ass'), /\.srt atau \.vtt/i);
});

test('local subtitle: File name, extension, and 10 MB size limit are checked before loading', async () => {
    const valid = await readLocalSubtitleFile({
        name: 'episode-04.srt', size: 42,
        text: async () => '1\n00:00:01,000 --> 00:00:02,000\nHalo',
    });
    assert.equal(valid.label, 'episode-04.srt');
    assert.match(valid.vtt, /^WEBVTT\n/);

    let read = false;
    await assert.rejects(readLocalSubtitleFile({
        name: 'episode.ass', size: 1, text: async () => { read = true; return ''; },
    }), /\.srt atau \.vtt/i);
    await assert.rejects(readLocalSubtitleFile({
        name: 'episode.srt', size: MAX_LOCAL_SUBTITLE_BYTES + 1,
        text: async () => { read = true; return ''; },
    }), /10 MB/i);
    assert.equal(read, false, 'berkas yang ditolak tidak dibaca');
});

test('local subtitle: selecting a file switches the video to it and dispose removes track/revokes URL once', () => {
    const original = { mode: 'showing', kind: 'subtitles' };
    const disabled = { mode: 'disabled', kind: 'subtitles' };
    const video = {
        textTracks: [original, disabled],
        append(element) {
            element.owner = this;
            this.textTracks.push(element.track);
        },
    };
    const revoked = [];
    const element = {
        track: { mode: 'disabled', kind: 'subtitles' },
        remove() {
            if (this.owner) this.owner.textTracks = this.owner.textTracks.filter((track) => track !== this.track);
            this.removed = true;
        },
    };
    let urlInput = '';
    const dispose = attachLocalSubtitleTrack(video, { vtt: 'WEBVTT\n', label: 'episode.srt' }, {
        createTrack: () => element,
        createUrl: (vtt) => { urlInput = vtt; return 'blob:local-subtitle'; },
        revokeUrl: (url) => revoked.push(url),
    });

    assert.equal(urlInput, 'WEBVTT\n');
    assert.deepEqual(
        [element.kind, element.label, element.srclang, element.src, element.track.mode],
        ['subtitles', 'Subtitle Lokal — episode.srt', 'id', 'blob:local-subtitle', 'showing'],
    );
    assert.equal(original.mode, 'hidden');
    assert.equal(disabled.mode, 'disabled');
    dispose();
    dispose();
    assert.equal(element.removed, true);
    assert.deepEqual(revoked, ['blob:local-subtitle']);
    assert.deepEqual(video.textTracks, [original, disabled]);
});

test('local subtitle: attachment failures clean up the object URL', () => {
    const revoked = [];
    const element = { remove() { this.removed = true; } };
    assert.throws(() => attachLocalSubtitleTrack({ textTracks: [], append() {} }, { vtt: 'WEBVTT\n', label: 'x.vtt' }, {
        createTrack: () => element,
        createUrl: () => 'blob:bad',
        revokeUrl: (url) => revoked.push(url),
    }), /track subtitle lokal/i);
    assert.equal(element.removed, true);
    assert.deepEqual(revoked, ['blob:bad']);
});
