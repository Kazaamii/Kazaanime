import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const homeHtml = read('index.html');
const homeJs = read('js/home.js');
const subindoJs = read('js/api/subindo.js');
const subindoStateJs = read('js/ui/subindo-state.js');
const componentsCss = read('css/components.css');
const configJs = read('js/config.js');
const cardJs = read('js/ui/card.js');

test('Sub Indo homepage exposes a live summary and a dynamic feed list', () => {
    assert.match(homeHtml, /id="subIndoStatus"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(homeHtml, /id="subIndoFeedList"/);
    assert.match(homeHtml, /Feed mengikuti sumber Sub Indo yang aktif di backend/);
    assert.doesNotMatch(
        homeHtml,
        /Feed: Samehadaku, Sakunime, Otakudesu, dan Kuramanime/,
        'the intro must not promise providers that may be disabled in the backend',
    );
    // 24 Okt 2026: tidak ada lagi janji verifikasi per episode di pengantar.
    assert.doesNotMatch(homeHtml, /server atau track subtitle Indonesia ditemukan/);
    assert.doesNotMatch(homeHtml, /Diverifikasi dari episode terbaru/);
    assert.match(homeHtml, /Tampilkan lebih banyak/);
    assert.match(homeHtml, /Lihat Semua/);
});

test('homepage merender panel per situs tanpa pemeriksaan episode', () => {
    assert.match(homeJs, /renderSubIndoSummary\(/);
    assert.match(homeJs, /\$\('#subIndoStatus'\)/);
    assert.match(homeJs, /\$\('#subIndoFeedList'\)/);
    assert.match(homeJs, /getSubIndoHomeSources\(\{ refresh \}\)/);
    assert.match(homeJs, /getSubIndoHomeSources\(\{ sourceIds: \[id\], refresh: true \}\)/);
    assert.match(homeJs, /const SUB_INDO_HOME_LIMIT = SUB_INDO\.previewLimit/);
    assert.match(homeJs, /source\.items\) \? source\.items : \[\]/);
    assert.doesNotMatch(homeJs, /getBackendEpisode|hasIndonesianSubtitle|subtitleEvidence/,
        'beranda tidak boleh memeriksa episode lagi');
    for (const removed of ['timedOut', 'failedChecks', 'unproven', 'episode diperiksa', 'terverifikasi', 'Batas waktu']) {
        assert.doesNotMatch(homeJs, new RegExp(removed), `home.js masih memuat "${removed}"`);
    }
});

test('panel bisa dibuka lebih banyak dan menautkan Lihat Semua', () => {
    assert.match(homeJs, /const subIndoExpanded = new Set\(\)/);
    assert.match(homeJs, /data-action="expand-subindo-source" data-source="\$\{source\.id\}"/);
    assert.match(homeJs, /Tampilkan lebih banyak \(\$\{all\.length\}\)/);
    assert.match(homeJs, /Tampilkan lebih sedikit/);
    assert.match(homeJs, /class="see-all subindo-source-more"/);
    assert.match(homeJs, /Lihat Semua/);
    assert.match(componentsCss, /\.subindo-source-foot\{/);
    assert.match(componentsCss, /\.subindo-expand\{/);
});

test('Sub Indo hanya AnimeKu & Oploverz, tanpa batas verifikasi di config', () => {
    assert.match(subindoJs, /export const PANEL_SOURCE_IDS = Object\.freeze\(\['animeku', 'oploverz'\]\)/);
    assert.match(subindoJs, /export function panelSections\(/);
    assert.match(subindoJs, /export function groupSubIndoSources\(/);
    assert.match(subindoJs, /export async function loadSubIndoSources\(/);
    assert.match(homeJs, /import \{ panelSections \} from '\.\/api\/subindo\.js'/);
    assert.match(homeJs, /sections: panelSections\(result\.sections\)/);

    assert.match(configJs, /export const SUB_INDO = Object\.freeze\(\{/);
    for (const entry of ['resultLimit: 24', 'previewLimit: 6']) {
        assert.ok(configJs.includes(entry), `config.js must define ${entry}`);
    }
    for (const removed of ['maxChecks', 'perSourceChecks', 'timeBudgetMs', 'previousEpisodeChecks']) {
        assert.equal(configJs.includes(removed), false, `${removed} sudah tidak dipakai`);
    }
});

test('panel kosong tetap memakai satu baris ringkas + tautan buka situs', () => {
    assert.match(homeJs, /function renderSubIndoEmpty\(grid, source\)/);
    assert.match(homeJs, /renderSubIndoEmpty\(grid, source\)/);
    assert.match(homeJs, /class="subindo-empty/);
    assert.match(homeJs, /const homeUrl = safeHomeUrl\(source\.homeUrl\)/);
    assert.match(homeJs, /rel="noopener noreferrer"/);
    assert.match(homeJs, /const status = sourceStatusLabel\(source, all\.length\)/);
    assert.match(subindoStateJs, /export function sourceStatusLabel\(/);
    assert.match(componentsCss, /\.subindo-empty\{/);
    assert.match(componentsCss, /\.subindo-empty\.is-policy\{/);
    assert.match(componentsCss, /\.subindo-empty-link\{/);
    assert.match(componentsCss, /\.subindo-source\.is-empty\{/);
});

test('badge kartu AnimeKu & Oploverz tetap dikenali', () => {
    for (const id of ['animeku', 'oploverz']) {
        assert.ok(subindoJs.includes(`'${id}'`), `panel harus memuat ${id}`);
        assert.match(cardJs, new RegExp(`backend:${id}'?: \\{ cls: 'src-backend', label: `), `badge ${id}`);
    }
});

test('styles for the summary, expand button, and retry button exist', () => {
    assert.match(componentsCss, /\.subindo-status\{/);
    assert.match(componentsCss, /\.subindo-status:empty\{display:none\}/);
    assert.match(componentsCss, /\.subindo-retry\{/);
    assert.match(componentsCss, /\.subindo-retry \.ic\{/);
    assert.match(componentsCss, /\.subindo-source-more\{/);
});
