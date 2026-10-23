import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const baseCss = fs.readFileSync(path.join(root, 'css/base.css'), 'utf8');
const watchCss = fs.readFileSync(path.join(root, 'css/watch.css'), 'utf8');

test('ambient background uses CSS gradients only and the player stacks above falling effects', () => {
    const bodyRule = /body\{[^}]*background:([^;]+);/.exec(baseCss)?.[1] || '';
    const effectsRule = /\.visual-effects\{([^}]+)\}/.exec(baseCss)?.[1] || '';
    const playerRule = /\.streaming-player-wrapper\{([^}]+)\}/.exec(watchCss)?.[1] || '';
    assert.match(bodyRule, /radial-gradient/);
    assert.doesNotMatch(bodyRule, /url\(/i, 'background must not load image assets');
    assert.match(effectsRule, /z-index:1/);
    assert.match(playerRule, /z-index:2/);
    assert.match(playerRule, /isolation:isolate/);
});
