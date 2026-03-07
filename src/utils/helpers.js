import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from '../config.js';

/**
 * Shared Utility Functions
 *
 * General-purpose helper functions used across multiple modules.
 */

/**
 * Get the package version from package.json
 * @param {string} [defaultVersion='1.0.0'] - Default version if package.json cannot be read
 * @returns {string} The package version
 */
export function getPackageVersion(defaultVersion = '1.0.0') {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const packageJsonPath = path.join(__dirname, '../../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        return packageJson.version || defaultVersion;
    } catch {
        return defaultVersion;
    }
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g., "1h23m45s")
 */
export function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m${secs}s`;
    }
    return `${secs}s`;
}


/**
 * Sleep for specified milliseconds
 * @param {number} ms - Duration to sleep in milliseconds
 * @returns {Promise<void>} Resolves after the specified duration
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is a network error (transient)
 * @param {Error} error - The error to check
 * @returns {boolean} True if it is a network error
 */
export function isNetworkError(error) {
    const msg = error.message.toLowerCase();
    return (
        msg.includes('fetch failed') ||
        msg.includes('network error') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('socket hang up') ||
        msg.includes('timeout')
    );
}

/**
 * Throttled fetch that applies a configurable delay before each request
 * Only applies delay when requestThrottlingEnabled is true
 * @param {string|URL} url - The URL to fetch
 * @param {RequestInit} [options] - Fetch options
 * @returns {Promise<Response>} Fetch response
 */
export async function throttledFetch(url, options) {
    if (config.requestThrottlingEnabled) {
        const delayMs = config.requestDelayMs || 200;
        if (delayMs > 0) {
            await sleep(delayMs);
        }
    }
    return fetch(url, options);
}

/**
 * Generate random jitter for backoff timing (Thundering Herd Prevention)
 * Prevents all clients from retrying at the exact same moment after errors.
 * @param {number} maxJitterMs - Maximum jitter range (result will be ±maxJitterMs/2)
 * @returns {number} Random jitter value between -maxJitterMs/2 and +maxJitterMs/2
 */
export function generateJitter(maxJitterMs) {
    return Math.random() * maxJitterMs - (maxJitterMs / 2);
}

// ============================================================================
// Stealth Mode: Human-like request timing & per-account daily limits
// Helps avoid Google ToS detection by mimicking natural IDE usage patterns
// ============================================================================

// Per-account daily request counters
// Structure: Map<email, { count: number, resetAt: number }>
const dailyRequestCounters = new Map();

/**
 * Generate a human-like random delay between API requests.
 * Uses a distribution that simulates natural coding patterns:
 * - Fast successive requests (typing/completing): 0.8-2s
 * - Normal coding pace: 2-5s
 * - Occasional pauses (reading/thinking): 5-12s
 *
 * @returns {number} Delay in milliseconds
 */
export function getHumanLikeDelay() {
    const stealthConfig = config.stealth || {};
    const minDelay = stealthConfig.minRequestDelayMs || 800;
    const maxDelay = stealthConfig.maxRequestDelayMs || 5000;

    // Weighted random: 60% short delays, 30% medium, 10% long pauses
    const roll = Math.random();
    let delay;
    if (roll < 0.60) {
        // Short delay (typing/completing): min to min+30% of range
        delay = minDelay + Math.random() * (maxDelay - minDelay) * 0.3;
    } else if (roll < 0.90) {
        // Medium delay (normal coding): 30% to 70% of range
        delay = minDelay + (maxDelay - minDelay) * 0.3 + Math.random() * (maxDelay - minDelay) * 0.4;
    } else {
        // Long pause (reading/thinking): 70% to 100% of range
        delay = minDelay + (maxDelay - minDelay) * 0.7 + Math.random() * (maxDelay - minDelay) * 0.3;
    }

    return Math.floor(delay);
}

/**
 * Apply stealth delay before an API request.
 * Only applies when stealth mode is enabled in config.
 *
 * @returns {Promise<number>} The delay that was applied (0 if stealth disabled)
 */
export async function applyStealthDelay() {
    const stealthConfig = config.stealth || {};
    if (!stealthConfig.enabled) return 0;

    const delay = getHumanLikeDelay();
    if (delay > 0) {
        await sleep(delay);
    }
    return delay;
}

/**
 * Track a request for an account and check if daily limit is exceeded.
 * Resets counter at midnight UTC.
 *
 * @param {string} email - Account email
 * @returns {{ allowed: boolean, count: number, limit: number }} Whether the request is allowed
 */
export function checkDailyLimit(email) {
    const stealthConfig = config.stealth || {};
    const dailyLimit = stealthConfig.maxRequestsPerAccountPerDay || 0; // 0 = unlimited

    if (dailyLimit <= 0) {
        return { allowed: true, count: 0, limit: 0 };
    }

    const now = Date.now();
    let counter = dailyRequestCounters.get(email);

    // Reset at midnight UTC
    if (!counter || now >= counter.resetAt) {
        const tomorrow = new Date();
        tomorrow.setUTCHours(24, 0, 0, 0);
        counter = { count: 0, resetAt: tomorrow.getTime() };
        dailyRequestCounters.set(email, counter);
    }

    const allowed = counter.count < dailyLimit;
    return { allowed, count: counter.count, limit: dailyLimit };
}

/**
 * Increment the daily request counter for an account.
 * Call this AFTER a successful request.
 *
 * @param {string} email - Account email
 */
export function incrementDailyCounter(email) {
    const counter = dailyRequestCounters.get(email);
    if (counter) {
        counter.count++;
    }
}

// ============================================================================
// Per-Account Request Spacing: Ensures minimum time between requests per account
// Prevents burst patterns that look automated to Google
// ============================================================================

// Track last request time per account
const lastRequestTime = new Map();

/**
 * Get the time since last request for an account and enforce minimum spacing.
 * Returns the delay needed (0 if enough time has passed).
 *
 * @param {string} email - Account email
 * @returns {number} Additional delay needed in ms (0 if none)
 */
export function getAccountSpacingDelay(email) {
    const stealthConfig = config.stealth || {};
    if (!stealthConfig.enabled) return 0;

    const minSpacing = stealthConfig.minAccountSpacingMs || 3000; // 3s minimum between same-account requests
    const now = Date.now();
    const lastTime = lastRequestTime.get(email) || 0;
    const elapsed = now - lastTime;

    if (elapsed < minSpacing) {
        return minSpacing - elapsed;
    }
    return 0;
}

/**
 * Record that a request was made for an account.
 * @param {string} email - Account email
 */
export function recordAccountRequest(email) {
    lastRequestTime.set(email, Date.now());
}

// ============================================================================
// Auto-Sleep Mode: Simulates IDE restart after idle periods (VPS-friendly)
// When no requests come in for a while, the next request gets a "cold start"
// delay mimicking an IDE being launched fresh, plus optional session rotation.
// ============================================================================

let lastGlobalRequestTime = 0;

/**
 * Check if the proxy has been idle long enough to trigger cold start behavior.
 * Returns the cold start delay needed (0 if not idle).
 *
 * @returns {{ isIdle: boolean, idleDurationMs: number, coldStartDelay: number }}
 */
export function checkIdleState() {
    const stealthConfig = config.stealth || {};
    if (!stealthConfig.enabled) return { isIdle: false, idleDurationMs: 0, coldStartDelay: 0 };

    const idleThreshold = stealthConfig.idleThresholdMs || 1800000; // 30 min default
    const now = Date.now();

    // First request ever - not idle
    if (lastGlobalRequestTime === 0) {
        return { isIdle: false, idleDurationMs: 0, coldStartDelay: 0 };
    }

    const idleDuration = now - lastGlobalRequestTime;
    if (idleDuration < idleThreshold) {
        return { isIdle: false, idleDurationMs: idleDuration, coldStartDelay: 0 };
    }

    // Calculate cold start delay
    const delayRange = stealthConfig.coldStartDelayMs || [3000, 8000];
    const [minDelay, maxDelay] = Array.isArray(delayRange) ? delayRange : [3000, 8000];
    const coldStartDelay = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));

    return { isIdle: true, idleDurationMs: idleDuration, coldStartDelay };
}

/**
 * Record that a global request was made (for idle detection).
 */
export function recordGlobalRequest() {
    lastGlobalRequestTime = Date.now();
}

/**
 * Check if current time is within configured working hours.
 * Returns action to take if outside hours.
 *
 * @returns {{ allowed: boolean, action: string|null, delayMs: number, reason: string|null }}
 */
export function checkWorkingHours() {
    const stealthConfig = config.stealth || {};
    const whConfig = stealthConfig.workingHours;

    if (!stealthConfig.enabled || !whConfig || !whConfig.enabled) {
        return { allowed: true, action: null, delayMs: 0, reason: null };
    }

    const now = new Date();

    // Apply timezone offset
    let localNow = now;
    if (whConfig.timezone && whConfig.timezone !== 'UTC') {
        try {
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: whConfig.timezone,
                hour: 'numeric', minute: 'numeric', hour12: false,
                weekday: 'short'
            });
            const parts = formatter.formatToParts(now);
            const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
            const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
            const weekday = parts.find(p => p.type === 'weekday')?.value || '';

            // Check weekends
            if (whConfig.weekendsOff && (weekday === 'Sat' || weekday === 'Sun')) {
                return buildOutsideHoursResponse(whConfig, 'Weekend - outside working hours');
            }

            // Check hours
            const startHour = whConfig.startHour ?? 8;
            const endHour = whConfig.endHour ?? 23;
            const currentMinutes = hour * 60 + minute;
            const startMinutes = startHour * 60;
            const endMinutes = endHour * 60;

            if (currentMinutes < startMinutes || currentMinutes >= endMinutes) {
                return buildOutsideHoursResponse(whConfig, `Outside working hours (${startHour}:00-${endHour}:00 ${whConfig.timezone})`);
            }
        } catch {
            // Invalid timezone - allow request
            return { allowed: true, action: null, delayMs: 0, reason: null };
        }
    } else {
        // UTC mode
        const hour = now.getUTCHours();
        const day = now.getUTCDay();

        if (whConfig.weekendsOff && (day === 0 || day === 6)) {
            return buildOutsideHoursResponse(whConfig, 'Weekend - outside working hours');
        }

        const startHour = whConfig.startHour ?? 8;
        const endHour = whConfig.endHour ?? 23;
        if (hour < startHour || hour >= endHour) {
            return buildOutsideHoursResponse(whConfig, `Outside working hours (${startHour}:00-${endHour}:00 UTC)`);
        }
    }

    return { allowed: true, action: null, delayMs: 0, reason: null };
}

/**
 * Build the response for outside working hours.
 * @param {Object} whConfig - Working hours config
 * @param {string} reason - Reason string
 * @returns {{ allowed: boolean, action: string, delayMs: number, reason: string }}
 */
function buildOutsideHoursResponse(whConfig, reason) {
    const action = whConfig.outsideHoursAction || 'delay';

    if (action === 'block') {
        return { allowed: false, action: 'block', delayMs: 0, reason };
    }

    // 'delay' mode - add extra delay
    const delayRange = whConfig.outsideHoursDelayMs || [10000, 30000];
    const [minDelay, maxDelay] = Array.isArray(delayRange) ? delayRange : [10000, 30000];
    const delayMs = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));

    return { allowed: true, action: 'delay', delayMs, reason };
}

/**
 * Get daily request stats for all accounts.
 * @returns {Object} Map of email -> { count, limit, resetAt }
 */
export function getDailyStats() {
    const stealthConfig = config.stealth || {};
    const dailyLimit = stealthConfig.maxRequestsPerAccountPerDay || 0;
    const stats = {};
    for (const [email, counter] of dailyRequestCounters) {
        stats[email] = { count: counter.count, limit: dailyLimit, resetAt: new Date(counter.resetAt).toISOString() };
    }
    return stats;
}
