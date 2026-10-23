import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP } from '../../js/config.js';

const root = process.cwd();

test('all static pages use the existing Yumeko logo image as their favicon', () => {
    for (const page of ['index.html', 'search.html', 'watch.html']) {
        const html = fs.readFileSync(path.join(root, page), 'utf8');
        const tag = html.match(/<link\s+rel="icon"[^>]*>/i)?.[0] || '';
        assert.ok(tag, `${page} should declare a favicon`);
        assert.match(tag, /type="image\/jpeg"/i);
        assert.equal(tag.match(/href="([^"]+)"/i)?.[1], APP.logoImage, `${page} should reuse APP.logoImage`);
    }
});
