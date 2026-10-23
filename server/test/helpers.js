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
    const requests = [];
    const resolve = async (url, options, source) => {
        calls.push(url);
        requests.push({ url, method: String(options?.method || 'GET').toUpperCase(), ...options });
        let value = routes[url];
        if (typeof value === 'function') value = await value(url, options);
        if (value instanceof Error) throw value;
        if (value === undefined) throw new SourceError(`404 palsu untuk ${url}`, { kind: 'not_found', source });
        return value;
    };
    const toText = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
    const createClient = (_net, opts) => ({
        source: opts.source,
        opts,
        async html(url, options = {}) {
            const value = await resolve(url, options, opts.source);
            return { $: load(toText(value)), url, status: 200 };
        },
        async request(url, options = {}) {
            const value = await resolve(url, options, opts.source);
            return { status: 200, url, text: toText(value), headers: new Headers() };
        },
        async json(url, options = {}) {
            const value = await resolve(url, options, opts.source);
            if (typeof value !== 'string') return value;
            try {
                return JSON.parse(value);
            } catch {
                throw new SourceError(`${opts.source} menerima JSON palsu yang tidak valid.`, { kind: 'parse', source: opts.source });
            }
        },
    });
    return { createClient, calls, requests };
}

/** Promise yang selesai setelah ms. */
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
