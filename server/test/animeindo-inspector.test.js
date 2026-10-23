import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanVisibleText, sanitizeUrl, summarizeJson } from '../scripts/inspect-animeindo-page.js';

test('AnimeIndo inspector: strips query values but keeps endpoint shape', () => {
    const value = sanitizeUrl('https://animeindo.cloud/ajax/player?episode=3&token=secret123&quality=720p#frag');
    assert.equal(value, 'https://animeindo.cloud/ajax/player?episode=%5Bomitted%5D&token=%5Bredacted%5D&quality=%5Bomitted%5D');
    assert.ok(!value.includes('secret123'));
    assert.ok(!value.includes('frag'));
});

test('AnimeIndo inspector: keeps safe metadata but redacts URLs and player secrets', () => {
    const shape = summarizeJson({
        title: 'Contoh Anime',
        episode: 3,
        genres: ['Action', 'Fantasy'],
        playerUrl: 'https://media.example/playlist.m3u8?token=secret',
        token: 'secret',
        nested: { quality: '720p', sourceUrl: 'https://media.example/video.mp4' },
    });
    assert.equal(shape.fields.title.sample, 'Contoh Anime');
    assert.equal(shape.fields.episode.sample, '3');
    assert.equal(shape.fields.genres.count, 2);
    assert.deepEqual(shape.fields.playerUrl, { type: 'string', redacted: true });
    assert.deepEqual(shape.fields.token, { type: 'string', redacted: true });
    assert.deepEqual(shape.fields.nested.fields.sourceUrl, { type: 'string', redacted: true });
    assert.equal(shape.fields.nested.fields.quality.sample, '720p');
});

test('AnimeIndo inspector: cleans URLs and token-like values from visible text', () => {
    const result = cleanVisibleText('API https://example.test/watch?token=abc nonce:xyz title');
    assert.ok(!result.includes('https://example.test'));
    assert.ok(!result.includes('abc'));
    assert.ok(!result.includes('xyz'));
    assert.ok(result.includes('[URL]'));
});
