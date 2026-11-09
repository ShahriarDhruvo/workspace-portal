// Short-lived cache of portal sessions, so proxied asset bursts don't each hit SQLite.
// Entries live ~5 s; the control API invalidates them when sessions end or workspaces stop.
import { hashSessionToken, readCookie, SESSION_COOKIE_NAME, type SessionContext } from "@portal/db";

const DEFAULT_TTL_MS = 5_000;
const MAX_ENTRIES = 2_000;

interface Entry {
  context: SessionContext | null;
  expiresAt: number;
}

export interface SessionCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

export class SessionCache {
  readonly #load: (tokenHash: string) => SessionContext | null;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();

  constructor(load: (tokenHash: string) => SessionContext | null, options: SessionCacheOptions = {}) {
    this.#load = load;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Resolves the portal_session cookie of a request; null when absent, unknown or expired. */
  fromCookieHeader(header: string | undefined): SessionContext | null {
    const token = readCookie(header, SESSION_COOKIE_NAME);
    return token ? this.get(hashSessionToken(token)) : null;
  }

  get(tokenHash: string): SessionContext | null {
    const now = this.#now();
    const cached = this.#entries.get(tokenHash);
    if (cached && cached.expiresAt > now) return cached.context;
    const context = this.#load(tokenHash);
    this.#entries.delete(tokenHash);
    // Never serve a session from the cache past its own expiry.
    const expiresAt = Math.min(now + this.#ttlMs, context?.session.expiresAt ?? Number.POSITIVE_INFINITY);
    this.#entries.set(tokenHash, { context, expiresAt });
    if (this.#entries.size > MAX_ENTRIES) this.#prune(now);
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

  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now || this.#entries.size > MAX_ENTRIES) this.#entries.delete(key);
    }
  }
}
