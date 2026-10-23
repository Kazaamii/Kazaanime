import test from 'node:test';
import assert from 'node:assert/strict';
import { getVerifiedSubIndoAnime, getVerifiedSubIndoSources, hasIndonesianSubtitle } from '../../js/api/subindo.js';

test('recognizes only explicit Indonesian server or subtitle-track metadata', () => {
    assert.equal(hasIndonesianSubtitle([{ lang: 'id', available: true }]), true);
    assert.equal(hasIndonesianSubtitle([{ lang: 'en', subtitles: [{ lang: 'id', label: 'Indonesian' }] }]), true);
    assert.equal(hasIndonesianSubtitle([{ lang: 'en', name: 'Server 2 (Sub Eng)' }]), false);
    assert.equal(hasIndonesianSubtitle([{ lang: 'en', available: false, name: 'Server (Sub Indo)' }]), false);
});

test('legacy flat verifier contains only episodes verified with Indonesian subtitles', async () => {
    const catalogue = [
        { title: 'Anime Inggris', slug: 'samehadaku~english', source: 'backend:samehadaku', latestEpisode: 5 },
        { title: 'Anime Indo', slug: 'otakudesu~indo', source: 'backend:otakudesu', latestEpisode: 8 },
        { title: 'Bukan sumber Sub Indo', slug: 'hianime~other', source: 'backend:hianime', latestEpisode: 10 },
    ];
    const called = [];
    const result = await getVerifiedSubIndoAnime({
        getLatest: async () => ({ items: catalogue, fallback: false }),
        getEpisode: async (slug, episode) => {
            called.push({ slug, episode });
            return slug === 'otakudesu~indo'
                ? { servers: [{ name: 'Server Indonesia', lang: 'id' }] }
                : { servers: [{ name: 'Server 1', lang: 'en' }] };
        },
    });

    assert.deepEqual(result.items.map((anime) => anime.title), ['Anime Indo']);
    assert.deepEqual(called.map((item) => item.slug), ['samehadaku~english', 'otakudesu~indo']);
    assert.equal(result.items[0].latestEpisode, 8);
});

test('legacy flat verifier rejects fallback metadata and deduplicates its flat results', async () => {
    const fallback = await getVerifiedSubIndoAnime({
        getLatest: async () => ({ items: [{ title: 'Fake', slug: 'samehadaku~fake' }], fallback: true }),
        getEpisode: async () => ({ servers: [{ lang: 'id' }] }),
    });
    assert.deepEqual(fallback.items, []);
    assert.equal(fallback.unavailable, true);

    const result = await getVerifiedSubIndoAnime({
        getLatest: async () => ({
            fallback: false,
            items: [
                { title: 'Blue Lock', slug: 'samehadaku~blue-lock', source: 'backend:samehadaku', latestEpisode: 4 },
                { title: 'Blue Lock', slug: 'otakudesu~blue-lock', source: 'backend:otakudesu', latestEpisode: 4 },
            ],
        }),
        getEpisode: async (slug) => ({ servers: slug.startsWith('samehadaku') ? [{ lang: 'en' }] : [{ lang: 'id' }] }),
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].slug, 'otakudesu~blue-lock');
});

test('caps episode availability checks and tolerates an individual source failure', async () => {
    const catalog = Array.from({ length: 8 }, (_, i) => ({
        title: `Anime ${i}`, slug: `samehadaku~anime-${i}`, source: 'backend:samehadaku', latestEpisode: i + 1,
    }));
    let checks = 0;
    const result = await getVerifiedSubIndoAnime({
        getLatest: async () => ({ items: catalog, fallback: false }),
        maxChecks: 3,
        concurrency: 2,
        getEpisode: async (_slug) => {
            checks++;
            if (checks === 1) throw new Error('source temporarily unavailable');
            return { servers: [{ lang: 'id' }] };
        },
    });
    assert.equal(result.checked, 3);
    assert.equal(checks, 3);
    assert.ok(result.items.length <= 2);
});

test('source verifier never promotes a fallback catalog to Sub Indo feeds', async () => {
    let episodeChecks = 0;
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: true,
            sections: [{
                id: 'samehadaku', name: 'Samehadaku',
                items: [{ title: 'Metadata only', slug: 'samehadaku~metadata', source: 'backend:samehadaku', latestEpisode: 1 }],
            }],
        }),
        getEpisode: async () => {
            episodeChecks++;
            return { servers: [{ lang: 'id' }] };
        },
    });

    assert.equal(result.unavailable, true);
    assert.deepEqual(result.sections, []);
    assert.equal(result.checked, 0);
    assert.equal(episodeChecks, 0);
});

test('verifies the latest episode but keeps same-titled anime separate by source', async () => {
    const checked = [];
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [
                {
                    id: 'samehadaku', name: 'Samehadaku',
                    items: [
                        { title: 'Blue Lock', slug: 'samehadaku~blue-lock-1', source: 'backend:samehadaku', latestEpisode: 4 },
                        { title: 'Blue Lock', slug: 'samehadaku~blue-lock-2', source: 'backend:samehadaku', latestEpisode: 5 },
                        { title: 'Anime tanpa bukti', slug: 'samehadaku~no-subtitle', source: 'backend:samehadaku', latestEpisode: 6 },
                        { title: 'Slug sumber tidak cocok', slug: 'otakudesu~wrong-source', source: 'backend:samehadaku', latestEpisode: 9 },
                    ],
                },
                {
                    id: 'otakudesu', name: 'Otakudesu',
                    items: [
                        { title: 'Blue Lock', slug: 'otakudesu~blue-lock', source: 'backend:otakudesu', latestEpisode: 4 },
                    ],
                },
                {
                    id: 'anoboy', name: 'Belum ada feed latest terverifikasi',
                    items: [{ title: 'Ignored', slug: 'anoboy~ignored', source: 'backend:anoboy', latestEpisode: 2 }],
                },
            ],
        }),
        getEpisode: async (slug, episode) => {
            checked.push({ slug, episode });
            return slug.endsWith('no-subtitle')
                ? { servers: [{ lang: 'en' }] }
                : { servers: [{ lang: 'id', available: true }] };
        },
    });

    assert.equal(result.checked, 4);
    assert.deepEqual(result.sections.map((source) => source.id), ['samehadaku', 'otakudesu']);
    assert.deepEqual(result.sections.map((source) => source.items.map((anime) => anime.title)), [
        ['Blue Lock'],
        ['Blue Lock'],
    ]);
    assert.equal(result.sections[0].items[0].latestEpisode, 4);
    assert.deepEqual(checked.map(({ slug }) => slug), [
        'samehadaku~blue-lock-1',
        'otakudesu~blue-lock',
        'samehadaku~blue-lock-2',
        'samehadaku~no-subtitle',
    ]);
    assert.deepEqual(checked.map(({ episode }) => episode), [4, 4, 5, 6]);
});

test('source verifier bounds episode checks and distributes the checks across providers', async () => {
    const checked = [];
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [
                {
                    id: 'samehadaku', name: 'Samehadaku',
                    items: Array.from({ length: 4 }, (_, index) => ({
                        title: `Same ${index}`, slug: `samehadaku~${index}`, source: 'backend:samehadaku', latestEpisode: index + 1,
                    })),
                },
                {
                    id: 'otakudesu', name: 'Otakudesu',
                    items: Array.from({ length: 4 }, (_, index) => ({
                        title: `Otaku ${index}`, slug: `otakudesu~${index}`, source: 'backend:otakudesu', latestEpisode: index + 1,
                    })),
                },
            ],
        }),
        maxChecks: 2,
        concurrency: 1,
        getEpisode: async (slug) => {
            checked.push(slug);
            return { servers: [{ lang: 'id' }] };
        },
    });

    assert.equal(result.checked, 2);
    assert.deepEqual(checked, ['samehadaku~0', 'otakudesu~0']);
    assert.deepEqual(result.sections.map((source) => source.checked), [1, 1]);
});

test('source verifier records failed episode checks without claiming a title is Sub Indo', async () => {
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [{
                id: 'kuramanime', name: 'Kuramanime',
                items: [{ title: 'Belum dapat dicek', slug: 'kuramanime~blocked', source: 'backend:kuramanime', latestEpisode: 3 }],
            }],
        }),
        getEpisode: async () => { throw new Error('network failure'); },
    });

    assert.deepEqual(result.sections[0].items, []);
    assert.equal(result.sections[0].checked, 1);
    assert.equal(result.sections[0].failedChecks, 1);
});
