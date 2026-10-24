import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP, STREAMING_SERVERS } from '../../js/config.js';

const root = process.cwd();

test('general site messaging promotes Multi Sub without promising Indonesian subtitles for every title', () => {
    assert.match(APP.tagline, /Multi Sub/i);
    assert.doesNotMatch(APP.tagline, /subtitle Indonesia terbaik/i);
    for (const page of ['index.html', 'search.html', 'watch.html']) {
        const html = fs.readFileSync(path.join(root, page), 'utf8');
        assert.match(html, /Multi Sub/i, `${page} should mention Multi Sub`);
        assert.doesNotMatch(html, /Streaming Anime Subtitle Indonesia|subtitle Indonesia terbaik|Subtitle Indonesia\s*[•|]/i);
    }
    const hero = fs.readFileSync(path.join(root, 'js/ui/hero.js'), 'utf8');
    assert.match(hero, /Multi Sub/);
    assert.doesNotMatch(hero, /Sub Indo/);
});

test('server cadangan statis hanya yang hidup (MegaPlay, Vidnest, TryEmbed)', () => {
    // Putaran 17 (24 Okt 2026): AniZone & ReAnime dihapus — backend selalu ditolak Cloudflare 403,
    // jadi dua tombol itu tidak pernah bisa memutar apa pun.
    assert.deepEqual(STREAMING_SERVERS.map((s) => s.id), ['megaplay-anilist', 'vidnest-anilist', 'tryembed-anilist']);
    assert.equal(STREAMING_SERVERS[0]?.lang, 'en');
    assert.ok(STREAMING_SERVERS.every((s) => !s.provider), 'tidak ada slot penyedia yang tersisa');
});
