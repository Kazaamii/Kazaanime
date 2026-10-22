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
