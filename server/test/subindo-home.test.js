import test from 'node:test';
import assert from 'node:assert/strict';
import { getVerifiedSubIndoAnime, hasIndonesianSubtitle } from '../../js/api/subindo.js';

test('recognizes only explicit Indonesian server or subtitle-track metadata', () => {
    assert.equal(hasIndonesianSubtitle([{ lang: 'id', available: true }]), true);
    assert.equal(hasIndonesianSubtitle([{ lang: 'en', subtitles: [{ lang: 'id', label: 'Indonesian' }] }]), true);
    assert.equal(hasIndonesianSubtitle([{ lang: 'en', name: 'Server 2 (Sub Eng)' }]), false);
    assert.equal(hasIndonesianSubtitle([{ lang: 'en', available: false, name: 'Server (Sub Indo)' }]), false);
});

test('homepage section contains only episodes verified with Indonesian subtitles', async () => {
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

test('does not promote fallback metadata or duplicate titles when sources overlap', async () => {
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
