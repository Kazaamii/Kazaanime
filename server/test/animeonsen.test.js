import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnimeOnsen, API_BASE, AUTH_URL, BASE_URL, POLICY, SEARCH_BASE } from '../sources/animeonsen.js';
import { SourceError } from '../lib/errors.js';
import { fakeClientFactory, fixture } from './helpers.js';

const API_HOSTS = ['www.animeonsen.xyz', 'api.animeonsen.xyz', 'auth.animeonsen.xyz', 'search.animeonsen.xyz'];
const CLIENT_ID = 'fixture-client-id';
const CLIENT_SECRET = 'fixture-client-secret-not-real';
const MEDIA_HOSTS = ['media.example.test'];
const ID = 'fixture-anime-01';
const DETAILS_URL = `${API_BASE}/content/${ID}/extensive`;
const EPISODES_URL = `${API_BASE}/content/${ID}/episodes`;
const VIDEO_URL = `${API_BASE}/content/${ID}/video/2`;
const SEARCH_URL = `${SEARCH_BASE}/indexes/content/search`;

function adapter(routes, sourceConfig = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, mediaHosts: MEDIA_HOSTS }) {
    const fake = fakeClientFactory(routes);
    const instances = [];
    const createClient = (network, opts) => {
        instances.push(opts);
        return fake.createClient(network, opts);
    };
    const source = createAnimeOnsen({ network: {}, createClient, sourceConfig });
    return { source, ...fake, instances };
}

const apiRoutes = (video = fixture('animeonsen-video.json')) => ({
    [AUTH_URL]: { access_token: 'fixture-access-token', expires_in: 3600 },
    [DETAILS_URL]: fixture('animeonsen-detail.json'),
    [EPISODES_URL]: fixture('animeonsen-episodes.json'),
    [VIDEO_URL]: video,
});

test('AnimeOnsen is fail-closed: missing credentials block all endpoint calls; robots approval is mandatory', async () => {
    const { source, calls, instances } = adapter({}, {});
    assert.equal(instances.length, 1);
    assert.deepEqual(instances[0].allowedHosts, API_HOSTS);
    assert.equal(instances[0].requireExplicitRobots, true);
    assert.equal(instances[0].retries, 0);
    assert.equal(source.policy, POLICY);
    assert.equal(source.policy.tos.verdict, 'unknown');
    await assert.rejects(source.search('Kumo no Monogatari'), (error) => error.kind === 'policy' && /ANIMEONSEN_CLIENT_ID/.test(error.message));
    assert.equal(calls.length, 0);
});

test('AnimeOnsen search uses homepage meta token + observed Meilisearch POST shape', async () => {
    const { source, calls, requests } = adapter({
        [BASE_URL]: fixture('animeonsen-home.html'),
        [SEARCH_URL]: fixture('animeonsen-search.json'),
    });
    const results = await source.search('Kumo no Monogatari');
    assert.equal(calls[0], BASE_URL, 'the search token is read from the AnimeOnsen homepage');
    assert.deepEqual(results.map((item) => item.title), ['Kumo no Monogatari', 'The Forest Train']);
    assert.equal(results[0].titleAlt, 'Cloud Story');
    assert.equal(results[0].slug, 'animeonsen~fixture-anime-01');
    assert.equal(results[0].source, 'animeonsen');
    assert.equal(results[0].url, `${BASE_URL}/details/fixture-anime-01`);
    assert.ok(results.every((item) => !item.slug.includes('not-a-safe-id')), 'malformed API IDs are rejected');

    const request = requests.find((entry) => entry.url === SEARCH_URL);
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { q: 'Kumo no Monogatari' });
    assert.equal(request.headers.Authorization, 'Bearer fixture-search-token');
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.ok(!JSON.stringify(results).includes('fixture-search-token'));
});

test('AnimeOnsen detail + episodes + video: server credentials stay private; explicit CDN allowlist and soft subs', async () => {
    const { source, calls, requests, instances } = adapter(apiRoutes());
    const ref = source.parseRef([ID]);
    assert.deepEqual(ref, { id: ID });
    assert.equal(source.parseRef(['../other']), null);
    assert.equal(source.titleHint(ref), `animeonsen ${ID}`);

    const anime = await source.getAnime(ref);
    assert.equal(anime.title, 'Kumo no Monogatari');
    assert.equal(anime.titleAlt, 'Cloud Story');
    assert.equal(anime.description, 'A test-only synopsis.');
    assert.equal(anime.status, 'COMPLETED');
    assert.equal(anime.score, 7.84);
    assert.deepEqual(anime.genres, ['Adventure', 'Drama']);
    assert.deepEqual(anime.studios, ['Studio Example']);
    assert.equal(anime.ids.mal, 123456);
    assert.deepEqual(anime.episodeList.map((item) => [item.number, item.title]), [
        [1, 'Episode 1: はじまり'],
        [2, 'Episode 2: 雲の向こう'],
    ]);

    const episode = await source.getEpisode(ref, 2, { anime });
    assert.equal(episode.episode, 2);
    assert.equal(episode.servers.length, 1);
    assert.equal(episode.servers[0].kind, 'hls');
    assert.equal(episode.servers[0].lang, 'multi');
    assert.equal(episode.servers[0].subtitleType, 'soft');
    assert.equal(episode.servers[0].url, 'https://media.example.test/fixture/episode/master.m3u8');
    assert.deepEqual(episode.servers[0].subtitles.map((track) => [track.label, track.lang, track.format, track.default]), [
        ['Indonesian', 'id-id', 'srt', true],
        ['English', 'en-us', 'vtt', false],
    ]);
    assert.ok(!JSON.stringify(episode).includes(CLIENT_SECRET));
    assert.ok(!JSON.stringify(episode).includes('fixture-access-token'));
    assert.equal(calls.filter((url) => url === AUTH_URL).length, 1, 'OAuth token is reused in memory');
    assert.equal(calls.filter((url) => url === VIDEO_URL).length, 1);

    const tokenRequest = requests.find((request) => request.url === AUTH_URL);
    assert.equal(tokenRequest.method, 'POST');
    const form = new URLSearchParams(tokenRequest.body);
    assert.equal(form.get('client_id'), CLIENT_ID);
    assert.equal(form.get('client_secret'), CLIENT_SECRET);
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.deepEqual(instances[0].allowedHosts, API_HOSTS);
    assert.equal(instances[0].requireExplicitRobots, true);
});

test('AnimeOnsen refreshes OAuth exactly once on 401, but does not refresh/retry blocks', async () => {
    let tokenCalls = 0;
    let detailCalls = 0;
    const refreshed = adapter({
        [AUTH_URL]: () => ({ access_token: `fixture-token-${++tokenCalls}` }),
        [DETAILS_URL]: () => {
            if (++detailCalls === 1) return new SourceError('expired token', { kind: 'http', source: 'animeonsen', httpStatus: 401 });
            return fixture('animeonsen-detail.json');
        },
        [EPISODES_URL]: fixture('animeonsen-episodes.json'),
    });
    const anime = await refreshed.source.getAnime({ id: ID });
    assert.equal(anime.title, 'Kumo no Monogatari');
    assert.equal(tokenCalls, 2);
    assert.equal(detailCalls, 2);
    assert.equal(refreshed.calls.filter((url) => url === EPISODES_URL).length, 1);
    assert.deepEqual(refreshed.requests.filter((request) => request.url === DETAILS_URL).map((request) => request.headers.Authorization), [
        'Bearer fixture-token-1', 'Bearer fixture-token-2',
    ]);

    let blockedTokenCalls = 0;
    const blocked = adapter({
        [AUTH_URL]: () => ({ access_token: `fixture-token-${++blockedTokenCalls}` }),
        [DETAILS_URL]: new SourceError('challenge stopped', { kind: 'blocked', source: 'animeonsen', httpStatus: 403 }),
        [EPISODES_URL]: fixture('animeonsen-episodes.json'),
    });
    await assert.rejects(blocked.source.getAnime({ id: ID }), (error) => error.kind === 'blocked');
    assert.equal(blockedTokenCalls, 1, 'challenge/403 tidak memicu refresh atau retry');
    assert.equal(blocked.calls.filter((url) => url === DETAILS_URL).length, 1);
});

test('AnimeOnsen refuses unconfigured media hosts, unknown video formats, and hosts outside the allowlist', async () => {
    const missingHosts = adapter(apiRoutes(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, mediaHosts: [] });
    const anime = await missingHosts.source.getAnime({ id: ID });
    await assert.rejects(missingHosts.source.getEpisode({ id: ID }, 2, { anime }), (error) => error.kind === 'policy');
    assert.equal(missingHosts.calls.includes(VIDEO_URL), false, 'do not fetch video metadata without an operator allowlist');

    const outsideHosts = adapter(apiRoutes({
        uri: { stream: 'https://unlisted.example.test/fixture/episode/master.m3u8', subtitles: {} },
        metadata: { subtitles: {} },
    }));
    const otherAnime = await outsideHosts.source.getAnime({ id: ID });
    await assert.rejects(outsideHosts.source.getEpisode({ id: ID }, 2, { anime: otherAnime }), (error) => error.kind === 'policy');

    const suffixHosts = adapter(apiRoutes(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, mediaHosts: ['example.test'] });
    const suffixAnime = await suffixHosts.source.getAnime({ id: ID });
    await assert.rejects(suffixHosts.source.getEpisode({ id: ID }, 2, { anime: suffixAnime }), (error) => error.kind === 'policy');

    const nonDefaultPort = adapter(apiRoutes({
        uri: { stream: 'https://media.example.test:8443/fixture/episode/master.m3u8', subtitles: {} },
        metadata: { subtitles: {} },
    }));
    const portAnime = await nonDefaultPort.source.getAnime({ id: ID });
    await assert.rejects(nonDefaultPort.source.getEpisode({ id: ID }, 2, { anime: portAnime }), (error) => error.kind === 'policy');

    const unknownFormat = adapter(apiRoutes({
        uri: { stream: 'https://media.example.test/fixture/episode/stream', subtitles: {} },
        metadata: { subtitles: {} },
    }));
    const formatAnime = await unknownFormat.source.getAnime({ id: ID });
    await assert.rejects(unknownFormat.source.getEpisode({ id: ID }, 2, { anime: formatAnime }), (error) => error.kind === 'parse');
});

test('AnimeOnsen does not claim a latest-update feed', async () => {
    const { source, calls } = adapter({});
    assert.equal(source.supportsLatest, false);
    assert.deepEqual(await source.latest(), []);
    assert.equal(calls.length, 0);
});
