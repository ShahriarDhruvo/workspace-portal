// Short-lived cache of portal sessions, so proxied asset bursts don't each hit SQLite. The control API invalidates
// entries when sessions end or workspaces stop.
import { hashSessionToken, readCookie, SESSION_COOKIE_NAME, type SessionContext } from "@portal/core";

const TTL_MS = 5_000;
const MAX_ENTRIES = 2_000;

export class SessionCache {
  readonly #load: (tokenHash: string) => SessionContext | null;
  readonly #entries = new Map<string, { context: SessionContext | null; expiresAt: number }>();

  constructor(load: (tokenHash: string) => SessionContext | null) {
    this.#load = load;
  }

  /** Resolves the portal_session cookie of a request; null when absent, unknown or expired. */
  fromCookieHeader(header: string | undefined): SessionContext | null {
    const token = readCookie(header, SESSION_COOKIE_NAME);
    return token ? this.get(hashSessionToken(token)) : null;
  }

  get(tokenHash: string): SessionContext | null {
    const now = Date.now();
    const cached = this.#entries.get(tokenHash);
    if (cached && cached.expiresAt > now) return cached.context;
    const context = this.#load(tokenHash);
    this.#entries.delete(tokenHash);
    // Never serve a session from the cache past its own expiry.
    this.#entries.set(tokenHash, { context, expiresAt: Math.min(now + TTL_MS, context?.session.expiresAt ?? Infinity) });
    if (this.#entries.size > MAX_ENTRIES) {
      for (const [key, entry] of this.#entries) {
        if (entry.expiresAt <= now || this.#entries.size > MAX_ENTRIES) this.#entries.delete(key);
      }
    }
    return context;
  }

  invalidateSession(sessionId: string): void {
    this.#entries.delete(sessionId);
  }

  /** Drops every cached session signed in as, or routed to, this user. */
  invalidateUser(userId: number): void {
    for (const [key, { context }] of this.#entries) {
      if (context && (context.user.id === userId || context.target.id === userId)) this.#entries.delete(key);
    }
  }
}
