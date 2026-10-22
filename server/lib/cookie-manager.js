/**
 * Kazanime backend — lib/cookie-manager.js
 * Cookie jars are isolated by scraper source, domain/path rules are enforced by
 * tough-cookie, and optional on-disk persistence is AES-256-GCM encrypted.
 * Cookies from 403/429/CAPTCHA/challenge responses are never stored by the caller.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { mkdir, readFile, rename, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Cookie, CookieJar } from 'tough-cookie';

const scrypt = promisify(scryptCallback);
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function sourceKey(source) {
    const key = String(source || '').trim();
    if (!SOURCE_RE.test(key)) throw new TypeError('Cookie source identifier tidak valid.');
    return key;
}

function responseCookies(headers) {
    if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
    const combined = headers?.get?.('set-cookie');
    if (!combined) return [];
    // `Expires` sendiri mengandung koma; hanya pisah koma yang diikuti awal cookie `name=`.
    return String(combined).split(/,\s*(?=[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/g).filter(Boolean);
}

function sameSiteForBrowser(value) {
    const text = String(value || '').toLowerCase();
    if (text === 'strict') return 'Strict';
    if (text === 'none') return 'None';
    return 'Lax';
}

function cookieForPlaywright(cookie) {
    const item = cookie.toJSON();
    return {
        name: item.key,
        value: item.value,
        domain: item.domain,
        path: item.path || '/',
        expires: item.expires && item.expires !== 'Infinity' ? new Date(item.expires).getTime() / 1000 : -1,
        httpOnly: Boolean(item.httpOnly),
        secure: Boolean(item.secure),
        sameSite: sameSiteForBrowser(item.sameSite),
    };
}

function playwrightCookieToJar(item, url) {
    const parsed = new URL(url);
    const rawDomain = String(item?.domain || parsed.hostname).toLowerCase();
    const domain = rawDomain.replace(/^\./, '');
    const expires = Number(item?.expires);
    const sameSite = String(item?.sameSite || '').toLowerCase();
    return new Cookie({
        key: String(item?.name || ''),
        value: String(item?.value || ''),
        domain,
        // Playwright returns a leading dot for Domain cookies on Chromium; absent that,
        // keep the cookie host-only to avoid expanding the session to sibling hosts.
        hostOnly: !rawDomain.startsWith('.'),
        path: String(item?.path || '/'),
        expires: Number.isFinite(expires) && expires > 0 ? new Date(expires * 1000) : 'Infinity',
        httpOnly: Boolean(item?.httpOnly),
        secure: Boolean(item?.secure),
        sameSite: ['strict', 'lax', 'none'].includes(sameSite) ? sameSite : undefined,
    });
}

export class CookieManager {
    /**
     * @param {{enabled?: boolean, encryptionKey?: string, storePath?: string, logger?: Pick<Console,'warn'>}} [opts]
     */
    constructor({ enabled = true, encryptionKey = '', storePath = '', logger = null } = {}) {
        this.enabled = Boolean(enabled);
        this.encryptionKey = String(encryptionKey || '');
        this.storePath = String(storePath || '');
        this.logger = logger;
        this.jars = new Map();
        this.loaded = false;
        this.loading = null;
        this.persistChain = Promise.resolve();
        this.persistenceFault = false;
        this.warned = false;
        this.persistent = this.enabled && Boolean(this.storePath) && Buffer.byteLength(this.encryptionKey) >= 32;
    }

    #warnOnce() {
        if (this.warned) return;
        this.warned = true;
        this.logger?.warn?.('[cookies] secure persistent cookie store unavailable; using memory-only jars.');
    }

    #jar(source) {
        const key = sourceKey(source);
        let jar = this.jars.get(key);
        if (!jar) {
            jar = new CookieJar(undefined, { rejectPublicSuffixes: true });
            this.jars.set(key, jar);
        }
        return jar;
    }

    async #ensureLoaded() {
        if (this.loaded) return;
        if (this.loading) return this.loading;
        this.loading = (async () => {
            if (this.persistent) {
                let buffer;
                try {
                    buffer = await readFile(this.storePath);
                    if (buffer.byteLength > MAX_STORE_BYTES) throw new Error('oversize');
                    const envelope = JSON.parse(buffer.toString('utf8'));
                    if (envelope?.version !== 1) throw new Error('version');
                    const salt = Buffer.from(envelope.salt || '', 'base64');
                    const iv = Buffer.from(envelope.iv || '', 'base64');
                    const tag = Buffer.from(envelope.tag || '', 'base64');
                    const encrypted = Buffer.from(envelope.data || '', 'base64');
                    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || encrypted.length > MAX_STORE_BYTES) throw new Error('format');
                    const key = await scrypt(this.encryptionKey, salt, 32);
                    const decipher = createDecipheriv('aes-256-gcm', key, iv);
                    decipher.setAuthTag(tag);
                    const clear = Buffer.concat([decipher.update(encrypted), decipher.final()]);
                    const parsed = JSON.parse(clear.toString('utf8'));
                    if (parsed?.version !== 1 || !parsed.sources || typeof parsed.sources !== 'object') throw new Error('payload');
                    for (const [source, serialized] of Object.entries(parsed.sources)) {
                        if (!SOURCE_RE.test(source) || !serialized || typeof serialized !== 'object') continue;
                        const jar = CookieJar.deserializeSync(serialized);
                        if (jar) this.jars.set(source, jar);
                    }
                } catch (error) {
                    if (error?.code !== 'ENOENT') {
                        // Do not reveal the file path, ciphertext, cookie data, or encryption key.
                        this.persistenceFault = true;
                        this.#warnOnce();
                    }
                }
            } else if (this.enabled && this.storePath && this.encryptionKey) {
                this.#warnOnce();
            }
            this.loaded = true;
        })();
        try {
            await this.loading;
        } finally {
            this.loading = null;
        }
    }

    async getCookieHeader(source, url) {
        if (!this.enabled) return '';
        await this.#ensureLoaded();
        try {
            return await this.#jar(source).getCookieString(url);
        } catch {
            return '';
        }
    }

    async getCookiesForBrowser(source, url) {
        if (!this.enabled) return [];
        await this.#ensureLoaded();
        try {
            const items = await this.#jar(source).getCookies(url);
            return items.map(cookieForPlaywright);
        } catch {
            return [];
        }
    }

    async storeResponse(source, url, headers) {
        if (!this.enabled) return false;
        await this.#ensureLoaded();
        const cookies = responseCookies(headers);
        if (!cookies.length) return false;
        const jar = this.#jar(source);
        let changed = false;
        for (const cookie of cookies) {
            try {
                const stored = await jar.setCookie(cookie, url, { ignoreError: true });
                changed ||= Boolean(stored);
            } catch {
                // Invalid cookies are ignored; never log cookie contents.
            }
        }
        if (changed) await this.#persist();
        return changed;
    }

    async storeBrowserCookies(source, url, cookies) {
        if (!this.enabled || !Array.isArray(cookies) || cookies.length === 0) return false;
        await this.#ensureLoaded();
        const jar = this.#jar(source);
        let changed = false;
        for (const item of cookies) {
            try {
                const cookie = playwrightCookieToJar(item, url);
                if (!cookie.key) continue;
                const stored = await jar.setCookie(cookie, url, { ignoreError: true });
                changed ||= Boolean(stored);
            } catch {
                // Browser cookies outside the source origin are ignored by tough-cookie.
            }
        }
        if (changed) await this.#persist();
        return changed;
    }

    async #persist() {
        if (!this.persistent || this.persistenceFault) return;
        this.persistChain = this.persistChain.catch(() => {}).then(async () => {
            const sources = {};
            for (const [source, jar] of this.jars) sources[source] = jar.serializeSync();
            const clear = Buffer.from(JSON.stringify({ version: 1, sources }));
            if (clear.byteLength > MAX_STORE_BYTES) throw new Error('oversize');
            const salt = randomBytes(16);
            const iv = randomBytes(12);
            const key = await scrypt(this.encryptionKey, salt, 32);
            const cipher = createCipheriv('aes-256-gcm', key, iv);
            const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
            const envelope = JSON.stringify({
                version: 1,
                salt: salt.toString('base64'),
                iv: iv.toString('base64'),
                tag: cipher.getAuthTag().toString('base64'),
                data: encrypted.toString('base64'),
            });
            const folder = path.dirname(this.storePath);
            const temporary = `${this.storePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
            await mkdir(folder, { recursive: true, mode: 0o700 });
            await chmod(folder, 0o700).catch(() => {});
            await writeFile(temporary, envelope, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await chmod(temporary, 0o600).catch(() => {});
            await rename(temporary, this.storePath);
            await chmod(this.storePath, 0o600).catch(() => {});
        }).catch(() => {
            this.persistenceFault = true;
            this.#warnOnce();
        });
        await this.persistChain;
    }

    snapshot() {
        let cookieCount = 0;
        for (const jar of this.jars.values()) {
            try { cookieCount += jar.serializeSync().cookies.length; } catch { /* diagnostic only */ }
        }
        return {
            enabled: this.enabled,
            persistent: this.persistent && !this.persistenceFault,
            loaded: this.loaded,
            isolatedSessions: this.jars.size,
            storedCookies: cookieCount,
        };
    }
}
