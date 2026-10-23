import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const homeHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const homeJs = fs.readFileSync(path.join(root, 'js/home.js'), 'utf8');
const componentsCss = fs.readFileSync(path.join(root, 'css/components.css'), 'utf8');
const configJs = fs.readFileSync(path.join(root, 'js/config.js'), 'utf8');

test('Sub Indo homepage exposes a live summary and a dynamic feed list', () => {
    assert.match(homeHtml, /id="subIndoStatus"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(homeHtml, /id="subIndoFeedList"/);
    assert.match(homeHtml, /Feed mengikuti sumber Sub Indo yang aktif di backend/);
    assert.doesNotMatch(
        homeHtml,
        /Feed: Samehadaku, Sakunime, Otakudesu, dan Kuramanime/,
        'the intro must not promise providers that may be disabled in the backend',
    );
});

test('homepage renders per-source counts, timeout state, and a per-source retry', () => {
    assert.match(homeJs, /renderSubIndoSummary\(/);
    assert.match(homeJs, /\$\('#subIndoStatus'\)/);
    assert.match(homeJs, /\$\('#subIndoFeedList'\)/);
    assert.match(homeJs, /subIndoSourceMeta/);
    assert.match(homeJs, /source\.timedOut/);
    assert.match(homeJs, /data-action="retry-subindo-source" data-source="\$\{source\.id\}"/);
    assert.match(homeJs, /getSubIndoHomeSources\(\{ sourceIds: \[id\], refresh: true \}\)/);
    assert.match(homeJs, /const SUB_INDO_HOME_LIMIT = SUB_INDO\.resultLimit/);
});

test('Sub Indo verification limits are centralised in config.js', () => {
    assert.match(configJs, /export const SUB_INDO = Object\.freeze\(\{/);
    for (const entry of [
        'resultLimit: 12',
        'maxChecks: 18',
        'perSourceChecks: 6',
        'concurrency: 4',
        'timeBudgetMs: 12000',
        'retryPreviousEpisode: true',
        'previousEpisodeChecks: 6',
    ]) {
        assert.ok(configJs.includes(entry), `config.js must define ${entry}`);
    }
});

test('panel tanpa judul terverifikasi memakai satu baris ringkas, bukan kotak kosong besar', () => {
    assert.match(homeJs, /function renderSubIndoEmpty\(grid, source\)/);
    assert.match(homeJs, /renderSubIndoEmpty\(grid, source\)/);
    assert.match(homeJs, /const status = sourceStatusLabel\(source, items\.length\)/);
    assert.match(homeJs, /const summary = issuesSummary\(sections\)/);
    assert.match(homeJs, /class="subindo-empty/);
    assert.match(homeJs, /const homeUrl = safeHomeUrl\(source\.homeUrl\)/);
    assert.match(homeJs, /source\.unproven/);
    assert.match(homeJs, /if \(source\.stale\) bits\.push\('data cache'\)/);
    assert.match(homeJs, /const proof = evidenceSummary\(source\.items\)/);
    assert.match(homeJs, /bukti: \$\{proof\}/);
    assert.match(homeJs, /rel="noopener noreferrer"/);
    assert.match(homeJs, /class="subindo-source\$\{items\.length \? '' : ' is-empty'\}"/);
    assert.match(homeHtml, /Bila situs membatasi akses otomatis, panel menampilkan tautan untuk membuka situsnya sendiri\./);
});

test('styles for the summary, per-source meta, and retry button exist', () => {
    assert.match(componentsCss, /\.subindo-status\{/);
    assert.match(componentsCss, /\.subindo-status:empty\{display:none\}/);
    assert.match(componentsCss, /\.subindo-source-meta\{/);
    assert.match(componentsCss, /\.subindo-retry\{/);
    assert.match(componentsCss, /\.subindo-retry \.ic\{/);
    assert.match(componentsCss, /\.subindo-empty\{/);
    assert.match(componentsCss, /\.subindo-empty\.is-policy\{/);
    assert.match(componentsCss, /\.subindo-empty-link\{/);
    assert.match(componentsCss, /\.subindo-source\.is-empty\{/);
});
