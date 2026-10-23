import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const baseCss = fs.readFileSync(path.join(root, 'css/base.css'), 'utf8');
const watchCss = fs.readFileSync(path.join(root, 'css/watch.css'), 'utf8');
const componentsCss = fs.readFileSync(path.join(root, 'css/components.css'), 'utf8');
const homeHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const homeJs = fs.readFileSync(path.join(root, 'js/home.js'), 'utf8');

test('homepage keeps Japanese Sub Indo in a separate per-provider section', () => {
    const subindoIndex = homeHtml.indexOf('id="subindo"');
    const donghuaIndex = homeHtml.indexOf('id="donghua"');
    assert.ok(subindoIndex >= 0 && donghuaIndex > subindoIndex, 'Sub Indo gets its own section before the Donghua section');
    assert.equal((homeHtml.match(/id="subindo"/g) || []).length, 1, 'only one verified Sub Indo homepage section is rendered');
    assert.doesNotMatch(homeHtml, /id="subIndoGrid"/, 'the old combined list is not rendered alongside the provider panels');
    assert.match(homeHtml, /tanpa pemeriksaan episode/);
    assert.match(homeHtml, /Tampilkan lebih banyak/);
    assert.doesNotMatch(homeHtml, /Diverifikasi dari episode terbaru/);
    assert.match(homeHtml, /id="subindoSources"/);
    assert.match(homeJs, /getSubIndoHomeSources\(\{ refresh \}\)/);
    assert.match(homeJs, /data-subindo-source-grid/);
    assert.match(homeJs, /variant: 'source'.*episodeOf: latestEpisodeOf/s);
});

test('ambient background uses CSS gradients only and the player stacks above falling effects', () => {
    const bodyRule = /body\{[^}]*background:([^;]+);/.exec(baseCss)?.[1] || '';
    const effectsRule = /\.visual-effects\{([^}]+)\}/.exec(baseCss)?.[1] || '';
    const playerRule = /\.streaming-player-wrapper\{([^}]+)\}/.exec(watchCss)?.[1] || '';
    const mainRule = /\.main-content\{([^}]+)\}/.exec(componentsCss)?.[1] || '';
    const footerRule = /\.footer\{([^}]+)\}/.exec(componentsCss)?.[1] || '';
    assert.match(bodyRule, /radial-gradient/);
    assert.doesNotMatch(bodyRule, /url\(/i, 'background must not load image assets');
    // 24 Okt 2026: partikel tidak boleh menimpa konten — lapisan efek ada di z-index 0,
    // konten (main/footer) di z-index 1, dan player di z-index 2 dengan isolation.
    assert.match(effectsRule, /z-index:0/, 'partikel harus di lapisan paling bawah');
    assert.match(mainRule, /position:relative/);
    assert.match(mainRule, /z-index:1/);
    assert.match(footerRule, /z-index:1/, 'footer juga di atas partikel');
    assert.match(playerRule, /z-index:2/);
    assert.match(playerRule, /isolation:isolate/);
});
