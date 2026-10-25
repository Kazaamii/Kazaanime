/**
 * Kazanime — analytics.js
 *
 * Vercel Web Analytics integration.
 * Initializes analytics tracking for the application.
 */
import { inject } from '@vercel/analytics';

/**
 * Initialize Vercel Web Analytics.
 * Automatically detects production/development mode.
 */
export function initAnalytics() {
    try {
        inject({
            mode: import.meta.env?.MODE === 'development' ? 'development' : 'production',
            debug: import.meta.env?.MODE === 'development',
        });
    } catch (error) {
        // Silently fail if analytics initialization fails
        // (e.g., in local development or if package is missing)
        console.debug('Analytics initialization skipped:', error.message);
    }
}
