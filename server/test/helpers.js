/**
 * Helper bersama unit test backend (node:test, tanpa dependensi tambahan).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { SourceError } from '../lib/errors.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Isi file fixture (teks). */
export function fixture(name) {
    return fs.readFileSync(path.join(DIR, 'fixtures', name), 'utf8');
}

/** Fixture HTML → cheerio. */
export function fixture$(name) {
    return load(fixture(name));
}

/**
 * Server HTTP lokal untuk menguji fetcher/routes.
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 */
export async function startServer(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
}

/**
 * createClient palsu untuk adapter: URL → HTML (string) | Error | function(url) → string.
 * Mencatat URL yang diminta di `calls`.
 */
export function fakeClientFactory(routes) {
    const calls = [];
    const createClient = (_net, opts) => ({
        source: opts.source,
        opts,
        async html(url) {
            calls.push(url);
            let v = routes[url];
            if (typeof v === 'function') v = v(url);
            if (v instanceof Error) throw v;
            if (v === undefined) throw new SourceError(`404 palsu untuk ${url}`, { kind: 'not_found', source: opts.source });
            return { $: load(v), url, status: 200 };
        },
        async json(url) {
            calls.push(url);
            const v = routes[url];
            if (v instanceof Error) throw v;
            if (v === undefined) throw new SourceError(`404 palsu untuk ${url}`, { kind: 'not_found', source: opts.source });
            return typeof v === 'string' ? JSON.parse(v) : v;
        },
    });
    return { createClient, calls };
}

/** Promise yang selesai setelah ms. */
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
