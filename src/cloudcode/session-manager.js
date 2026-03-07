/**
 * Session Management for Cloud Code
 *
 * Handles session ID derivation for prompt caching continuity.
 * Session IDs are derived from the first user message to ensure
 * the same conversation uses the same session across turns.
 */

import crypto from 'crypto';
import { config } from '../config.js';


// Runtime storage for session IDs (per account)
// Key: accountEmail, Value: { sessionId: string, createdAt: number }
const runtimeSessionStore = new Map();

// Default session rotation interval: 4 hours
// Real Antigravity IDE users restart their editor periodically,
// so rotating sessions mimics natural IDE restart patterns
const DEFAULT_SESSION_ROTATION_MS = 4 * 60 * 60 * 1000;

/**
 * Get or create a session ID for the given account.
 *
 * The binary generates a session ID once at startup: `p.sessionID = rs() + Date.now()`.
 * Since our proxy is long-running, we simulate this "per-launch" behavior by storing
 * a generated ID in memory for each account.
 *
 * Session IDs are automatically rotated after a configurable interval
 * (default: 4 hours) to mimic natural IDE restarts and reduce fingerprinting.
 *
 * @param {Object} anthropicRequest - The Anthropic-format request (unused for ID generation now)
 * @param {string} accountEmail - The account email to scope the session ID
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(anthropicRequest, accountEmail) {
    if (!accountEmail) {
        // Fallback for requests without an account (should differ every time)
        return generateBinaryStyleId();
    }

    const rotationMs = config?.stealth?.sessionRotationMs || DEFAULT_SESSION_ROTATION_MS;
    const now = Date.now();

    // Check if we already have a session ID for this account
    if (runtimeSessionStore.has(accountEmail)) {
        const entry = runtimeSessionStore.get(accountEmail);
        // Rotate if session is older than rotation interval
        if (now - entry.createdAt < rotationMs) {
            return entry.sessionId;
        }
        // Session expired - fall through to generate new one
    }

    // Generate a new ID using the binary's exact logic
    const newSessionId = generateBinaryStyleId();

    // Store it with creation timestamp
    runtimeSessionStore.set(accountEmail, {
        sessionId: newSessionId,
        createdAt: now
    });

    return newSessionId;
}

/**
 * Generate a Session ID using the binary's exact logic.
 * logic: `rs() + Date.now()` where `rs()` is randomUUID
 */
function generateBinaryStyleId() {
    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all session IDs (e.g. useful for testing or explicit reset)
 */
export function clearSessionStore() {
    runtimeSessionStore.clear();
}
