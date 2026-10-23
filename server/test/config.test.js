import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const script = "import { SOURCES } from './server/config.js'; console.log(JSON.stringify(SOURCES.enabled));";

function enabledSources(overrides = {}) {
    const env = {
        ...process.env,
        SCRAPER_SOURCES: '',
        ANIMEONSEN_CLIENT_ID: '',
        ANIMEONSEN_CLIENT_SECRET: '',
        ANIMEONSEN_MEDIA_HOSTS: '',
        ...overrides,
    };
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
    }));
}

test('AnimeOnsen auto-enables only with both authorized credentials and an explicit media-host allowlist', () => {
    assert.ok(!enabledSources().includes('animeonsen'));
    assert.ok(!enabledSources({
        ANIMEONSEN_CLIENT_ID: 'test-client-id',
        ANIMEONSEN_CLIENT_SECRET: 'test-client-secret',
    }).includes('animeonsen'));
    assert.ok(enabledSources({
        ANIMEONSEN_CLIENT_ID: 'test-client-id',
        ANIMEONSEN_CLIENT_SECRET: 'test-client-secret',
        ANIMEONSEN_MEDIA_HOSTS: 'media.example.test',
    }).includes('animeonsen'));
});

test('explicit SCRAPER_SOURCES may opt in without credentials, but adapter methods still fail closed', () => {
    assert.deepEqual(enabledSources({ SCRAPER_SOURCES: 'animexin,animeonsen' }), ['animexin', 'animeonsen']);
});

test('Kusonime downloads default on, can be disabled, and keeps a normalized configurable base URL', () => {
    const configScript = "import { SOURCES } from './server/config.js'; console.log(JSON.stringify(SOURCES.kusonimeDownloads));";
    const readConfig = (overrides = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', configScript], {
        cwd: process.cwd(),
        env: { ...process.env, KUSONIME_DOWNLOADS_ENABLED: '', KUSONIME_BASE_URL: '', ...overrides },
        encoding: 'utf8',
    }));
    assert.deepEqual(readConfig(), { enabled: true, baseUrl: 'https://kusonime.com' });
    assert.deepEqual(readConfig({ KUSONIME_DOWNLOADS_ENABLED: '0', KUSONIME_BASE_URL: 'https://www.kusonime.com/' }), {
        enabled: false,
        baseUrl: 'https://www.kusonime.com',
    });
});
