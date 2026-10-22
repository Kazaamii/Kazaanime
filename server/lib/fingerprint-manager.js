/**
 * Kazanime backend — lib/fingerprint-manager.js
 * Deterministic, transparent Playwright context configuration. This is a browser
 * configuration/session manager, not a stealth or fingerprint-randomization layer:
 * the bot User-Agent is retained and browser signals are never patched.
 */
import { BOT } from '../config.js';

function safeViewport(viewport = {}) {
    const width = Number(viewport.width);
    const height = Number(viewport.height);
    return {
        width: Number.isInteger(width) && width >= 320 && width <= 3840 ? width : 1280,
        height: Number.isInteger(height) && height >= 240 && height <= 2160 ? height : 800,
    };
}

export class FingerprintManager {
    /**
     * @param {{userAgent?: string, locale?: string, timezoneId?: string, viewport?: {width?:number,height?:number}}} [opts]
     */
    constructor({ userAgent = BOT.userAgent, locale = 'id-ID', timezoneId = 'Asia/Jakarta', viewport = { width: 1280, height: 800 } } = {}) {
        this.profile = Object.freeze({
            userAgent: String(userAgent || BOT.userAgent),
            locale: String(locale || 'id-ID'),
            timezoneId: String(timezoneId || 'Asia/Jakarta'),
            viewport: Object.freeze(safeViewport(viewport)),
        });
    }

    /** Separate BrowserContext configuration by scraper id; never reuses another source's context. */
    contextOptions(_source) {
        return {
            userAgent: this.profile.userAgent,
            locale: this.profile.locale,
            timezoneId: this.profile.timezoneId,
            viewport: { ...this.profile.viewport },
            isMobile: false,
            hasTouch: false,
            colorScheme: 'light',
            reducedMotion: 'reduce',
            javaScriptEnabled: true,
        };
    }

    snapshot() {
        return {
            policy: 'stable-transparent',
            userAgent: this.profile.userAgent.split(/[\s(]/, 1)[0],
            locale: this.profile.locale,
            timezoneId: this.profile.timezoneId,
            viewport: { ...this.profile.viewport },
        };
    }
}
