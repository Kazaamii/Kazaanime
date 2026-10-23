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
        // Fokus tes ini = pemisahan panel & duplikat judul. Pemeriksaan episode
        // sebelumnya punya tes tersendiri di bawah.
        retryPreviousEpisode: false,
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

test('falls back to the previous episode when the newest episode has no Indonesian proof', async () => {
    const checked = [];
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [{
                id: 'samehadaku', name: 'Samehadaku',
                items: [
                    { title: 'Anime Baru', slug: 'samehadaku~anime-baru', source: 'backend:samehadaku', latestEpisode: 9 },
                    { title: 'Episode Satu', slug: 'samehadaku~episode-satu', source: 'backend:samehadaku', latestEpisode: 1 },
                ],
            }],
        }),
        concurrency: 1,
        getEpisode: async (slug, episode) => {
            checked.push(`${slug}#${episode}`);
            if (slug === 'samehadaku~episode-satu' || episode >= 9) return { servers: [{ lang: 'en' }] };
            return { servers: [{ lang: 'id', available: true }] };
        },
    });

    assert.deepEqual(checked, ['samehadaku~anime-baru#9', 'samehadaku~anime-baru#8', 'samehadaku~episode-satu#1']);
    assert.equal(result.checked, 3);
    assert.deepEqual(result.sections[0].items.map((anime) => anime.slug), ['samehadaku~anime-baru']);
    assert.equal(result.sections[0].items[0].latestEpisode, 8, 'card points at the episode that was actually verified');
    assert.equal(result.sections[0].failedChecks, 0, 'absence of proof is not a failed check');
});

test('does not request the previous episode when the latest one is already verified', async () => {
    const checked = [];
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [{
                id: 'sakunime', name: 'Sakunime',
                items: [{ title: 'Sudah Ada', slug: 'sakunime~sudah-ada', source: 'backend:sakunime', latestEpisode: 4 }],
            }],
        }),
        getEpisode: async (slug, episode) => {
            checked.push(`${slug}#${episode}`);
            return { servers: [{ lang: 'id' }] };
        },
    });

    assert.deepEqual(checked, ['sakunime~sudah-ada#4']);
    assert.equal(result.checked, 1);
    assert.equal(result.sections[0].items[0].latestEpisode, 4);
});

test('bounds previous-episode checks with its own budget', async () => {
    const checked = [];
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [{
                id: 'otakudesu', name: 'Otakudesu',
                items: [
                    { title: 'Satu', slug: 'otakudesu~satu', source: 'backend:otakudesu', latestEpisode: 5 },
                    { title: 'Dua', slug: 'otakudesu~dua', source: 'backend:otakudesu', latestEpisode: 6 },
                    { title: 'Tiga', slug: 'otakudesu~tiga', source: 'backend:otakudesu', latestEpisode: 7 },
                ],
            }],
        }),
        concurrency: 1,
        retryPreviousEpisode: true,
        previousEpisodeChecks: 1,
        getEpisode: async (slug, episode) => {
            checked.push(`${slug}#${episode}`);
            return { servers: [{ lang: 'en' }] };
        },
    });

    assert.deepEqual(checked, ['otakudesu~satu#5', 'otakudesu~satu#4', 'otakudesu~dua#6', 'otakudesu~tiga#7']);
    assert.equal(result.checked, 4);
    assert.deepEqual(result.sections[0].items, []);
});

test('returns verified titles with a timeout marker when the time budget expires', async () => {
    const started = Date.now();
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [{
                id: 'samehadaku', name: 'Samehadaku',
                items: [
                    { title: 'Cepat', slug: 'samehadaku~cepat', source: 'backend:samehadaku', latestEpisode: 2 },
                    { title: 'Lambat', slug: 'samehadaku~lambat', source: 'backend:samehadaku', latestEpisode: 3 },
                ],
            }],
        }),
        concurrency: 2,
        retryPreviousEpisode: false,
        timeBudgetMs: 40,
        getEpisode: async (slug) => {
            if (slug === 'samehadaku~cepat') return { servers: [{ lang: 'id' }] };
            return new Promise(() => {}); // sumber lambat yang tidak pernah selesai
        },
    });

    assert.ok(Date.now() - started < 2000, 'feed stops waiting when the budget expires');
    assert.equal(result.timedOut, true);
    assert.equal(result.sections[0].timedOut, true);
    assert.deepEqual(result.sections[0].items.map((anime) => anime.slug), ['samehadaku~cepat']);
    assert.equal(result.checked, 2);
});

test('caps checks per source so one provider cannot consume the whole budget', async () => {
    const checked = [];
    const items = (prefix) => Array.from({ length: 6 }, (_, index) => ({
        title: `${prefix} ${index}`,
        slug: `${prefix}~${index}`,
        source: `backend:${prefix}`,
        latestEpisode: index + 1,
    }));
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [
                { id: 'samehadaku', name: 'Samehadaku', items: items('samehadaku') },
                { id: 'otakudesu', name: 'Otakudesu', items: items('otakudesu') },
            ],
        }),
        maxChecks: 6,
        perSourceChecks: 2,
        concurrency: 1,
        retryPreviousEpisode: false,
        getEpisode: async (slug) => {
            checked.push(slug);
            return { servers: [{ lang: 'id' }] };
        },
    });

    assert.deepEqual(checked, ['samehadaku~0', 'otakudesu~0', 'samehadaku~1', 'otakudesu~1']);
    assert.deepEqual(result.sections.map((source) => source.checked), [2, 2]);
    assert.equal(result.checked, 4);
});

test('a caller abort cancels verification instead of returning partial results', async () => {
    const controller = new AbortController();
    const pending = getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [{
                id: 'samehadaku', name: 'Samehadaku',
                items: [{ title: 'Lama', slug: 'samehadaku~lama', source: 'backend:samehadaku', latestEpisode: 2 }],
            }],
        }),
        getEpisode: () => new Promise(() => {}),
        signal: controller.signal,
        timeBudgetMs: 5000,
    });

    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, (error) => error?.name === 'AbortError' || error?.kind === 'abort');
});

test('per-section homeUrl is preserved so a blocked panel can be opened manually', async () => {
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [
                {
                    id: 'samehadaku', name: 'Samehadaku', homeUrl: 'https://samehadaku.test',
                    items: [], error: { kind: 'blocked', source: 'samehadaku' },
                },
                {
                    id: 'otakudesu', name: 'Otakudesu', homeUrl: 'https://otakudesu.test',
                    items: [{ title: 'Dua', slug: 'otakudesu~dua', source: 'backend:otakudesu', latestEpisode: 1 }],
                },
            ],
        }),
        retryPreviousEpisode: false,
        getEpisode: async () => ({ servers: [{ lang: 'id' }] }),
    });

    assert.deepEqual(result.sections.map((source) => source.homeUrl), ['https://samehadaku.test', 'https://otakudesu.test']);
});

test('sourceIds limits verification to one panel for per-source retry', async () => {
    const checked = [];
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [
                {
                    id: 'samehadaku', name: 'Samehadaku',
                    items: [{ title: 'Satu', slug: 'samehadaku~satu', source: 'backend:samehadaku', latestEpisode: 2 }],
                },
                {
                    id: 'otakudesu', name: 'Otakudesu',
                    items: [{ title: 'Dua', slug: 'otakudesu~dua', source: 'backend:otakudesu', latestEpisode: 3 }],
                },
            ],
        }),
        sourceIds: ['otakudesu'],
        retryPreviousEpisode: false,
        getEpisode: async (slug) => {
            checked.push(slug);
            return { servers: [{ lang: 'id' }] };
        },
    });

    assert.deepEqual(checked, ['otakudesu~dua']);
    assert.deepEqual(result.sections.map((source) => source.id), ['otakudesu']);
    assert.equal(result.checked, 1);
});

test('counts the catalogue fetch against the verification time budget', async () => {
    const result = await getVerifiedSubIndoSources({
        getSources: async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return {
                fallback: false,
                sections: [{
                    id: 'samehadaku', name: 'Samehadaku',
                    items: [{ title: 'Terlambat', slug: 'samehadaku~terlambat', source: 'backend:samehadaku', latestEpisode: 2 }],
                }],
            };
        },
        getEpisode: async () => {
            throw new Error('episode checks must not start after the budget is exhausted');
        },
        timeBudgetMs: 10,
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.checked, 0);
    assert.equal(result.sections[0].timedOut, true);
    assert.deepEqual(result.sections[0].items, []);
});

test('checks each episode slug only once per source', async () => {
    const checked = [];
    const result = await getVerifiedSubIndoSources({
        getSources: async () => ({
            fallback: false,
            sections: [{
                id: 'samehadaku', name: 'Samehadaku',
                items: [
                    { title: 'Judul A', slug: 'samehadaku~judul-a', source: 'backend:samehadaku', latestEpisode: 2 },
                    { title: 'Judul A (duplikat katalog)', slug: 'samehadaku~judul-a', source: 'backend:samehadaku', latestEpisode: 2 },
                    { title: 'Judul B', slug: 'samehadaku~judul-b', source: 'backend:samehadaku', latestEpisode: 3 },
                ],
            }],
        }),
        retryPreviousEpisode: false,
        concurrency: 1,
        getEpisode: async (slug, episode) => {
            checked.push(`${slug}#${episode}`);
            return { servers: [{ lang: 'id' }] };
        },
    });

    assert.deepEqual(checked, ['samehadaku~judul-a#2', 'samehadaku~judul-b#3']);
    assert.equal(result.sections[0].items.length, 2);
    assert.equal(result.checked, 2);
});
