import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { createKusonimeDownloader, parseKusonimeDownloads, parseKusonimeSearch } from '../sources/kusonime.js';
import { readRomajiTitles } from '../routes/anime.js';
import { fakeClientFactory, fixture, fixture$ } from './helpers.js';

const BASE = 'https://kusonime.com';

test('Kusonime search parser reads documented cards and rejects off-site detail URLs', () => {
    const $ = fixture$('kusonime-search.html');
    $('div.detpost').first().find('h2 a').attr('href', 'https://elsewhere.example.test/not-kusonime');
    const cards = parseKusonimeSearch($, BASE);
    assert.deepEqual(cards, [{ title: 'Sousou no Frieren', url: `${BASE}/download-anime-sousou-no-frieren/` }]);
});

test('Kusonime download parser requires an exact Romaji/title-variant match and preserves mirror hrefs', () => {
    const parsed = parseKusonimeDownloads(load(fixture('kusonime-detail.html')), BASE, ['Sousou no Frieren']);
    assert.equal(parsed.matchedTitle, 'Sousou no Frieren');
    assert.deepEqual(parsed.downloads, [
        {
            quality: '720p', size: '', format: 'MKV', subtitle: 'Tidak diketahui',
            links: [
                { provider: 'Google Drive', url: 'https://drive.example.test/frieren-720' },
                { provider: 'Mirror wrapper', url: 'https://kusonime.com/out?url=YWJj' },
            ],
        },
        {
            quality: '1080p', size: '', format: 'Tidak diketahui', subtitle: 'Tidak diketahui',
            links: [{ provider: 'PixelDrain', url: 'https://pixeldrain.example.test/frieren-1080' }],
        },
    ]);
    assert.equal(parseKusonimeDownloads(load(fixture('kusonime-detail.html')), BASE, ['Sousei no Onmyouji']), null);
});

test('Kusonime adapter uses only Romaji search queries and requires explicit robots approval', async () => {
    const searchUrl = `${BASE}/?s=Sousou+no+Frieren`;
    const detailUrl = `${BASE}/download-anime-sousou-no-frieren/`;
    const { createClient, calls } = fakeClientFactory({
        [searchUrl]: fixture('kusonime-search.html'),
        [detailUrl]: fixture('kusonime-detail.html'),
    });
    let options;
    const downloader = createKusonimeDownloader({
        network: {},
        baseUrl: BASE,
        createClient: (network, opts) => { options = opts; return createClient(network, opts); },
    });
    assert.deepEqual(options.allowedHosts, ['kusonime.com']);
    assert.equal(options.requireExplicitRobots, true);
    assert.equal(options.renderJavaScript, false);
    const result = await downloader.findDownloads(['Sousou no Frieren']);
    assert.equal(result.matchedTitle, 'Sousou no Frieren');
    assert.equal(result.downloads.length, 2);
    assert.deepEqual(calls, [searchUrl, detailUrl], 'download mirror URLs are returned, never fetched');
});

test('Kusonime rejects invalid base URLs and does not resolve an unmatched title', async () => {
    assert.throws(() => createKusonimeDownloader({ baseUrl: 'http://kusonime.com', network: {}, createClient: () => ({}) }), /HTTPS/);
    const searchUrl = `${BASE}/?s=No+Such+Anime`;
    const { createClient, calls } = fakeClientFactory({ [searchUrl]: fixture('kusonime-search.html') });
    const downloader = createKusonimeDownloader({ network: {}, baseUrl: BASE, createClient });
    const result = await downloader.findDownloads(['No Such Anime']);
    assert.deepEqual(result.downloads, []);
    assert.equal(result.matchedTitle, '');
    const romanjiRequired = await downloader.findDownloads(['葬送のフリーレン']);
    assert.equal(romanjiRequired.query, '');
    assert.deepEqual(calls, [searchUrl], 'non-Latin titles must not trigger a search request');
});

test('Kusonime route parser accepts only Latin-script Romaji candidates', () => {
    assert.deepEqual(readRomajiTitles(['フリーレン', 'Sousou no Frieren', 'Sousou no Frieren']), ['Sousou no Frieren']);
    assert.throws(() => readRomajiTitles(['葬送のフリーレン']), /Latin/);
});
