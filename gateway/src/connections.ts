// Who has a workspace open, by workspace and by portal session, so the control API can report it
// ("Admin connected") and close a session's connections. Two sources: open long-lived connections
// (event streams, terminal sockets), which can be closed, and presence: a tab of the Web Shell polls
// every few seconds even on its home page, so a session seen recently has the workspace open.

export type ConnectionRole = "owner" | "admin";

/** Close code for agent sockets closed by POST /control/sessions/:id/disconnect. */
export const SESSION_DISCONNECTED = 4001;

export interface AgentConnection {
  /** Whose workspace the connection is attached to. */
  readonly userId: number;
  /** sessions.id (the token hash) of the browser session. */
  readonly sessionId: string;
  /** "admin" when an admin is viewing someone else's workspace. */
  readonly role: ConnectionRole;
  close(code: number, reason: string): void;
}

/** A session counts as present this long after its last request. */
export const PRESENCE_MS = 20_000;

interface Presence {
  userId: number;
  sessionId: string;
  role: ConnectionRole;
  seenAt: number;
}

export class ConnectionRegistry {
  readonly #connections = new Set<AgentConnection>();
  readonly #presence = new Map<string, Presence>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** A request of this session reached this workspace. */
  seen(userId: number, sessionId: string, role: ConnectionRole): void {
    const now = this.#now();
    this.#presence.set(`${userId}\n${sessionId}`, { userId, sessionId, role, seenAt: now });
    if (this.#presence.size > 1_000) {
      for (const [key, entry] of this.#presence) if (now - entry.seenAt > PRESENCE_MS) this.#presence.delete(key);
    }
  }

  /** Registers a connection; call the returned function once it has closed. */
  add(connection: AgentConnection): () => void {
    this.#connections.add(connection);
    return () => {
      this.#connections.delete(connection);
    };
  }

  /** Sessions that have this workspace open (each counted once), by role. */
  count(userId: number): { owner: number; admin: number } {
    const sessions = new Map<string, ConnectionRole>();
    for (const connection of this.#connections) {
      if (connection.userId === userId) sessions.set(connection.sessionId, connection.role);
    }
    const now = this.#now();
    for (const entry of this.#presence.values()) {
      if (entry.userId === userId && now - entry.seenAt <= PRESENCE_MS) sessions.set(entry.sessionId, entry.role);
    }
    const counts = { owner: 0, admin: 0 };
    for (const role of sessions.values()) counts[role]++;
    return counts;
  }

  closeSession(sessionId: string, code: number, reason: string): number {
    for (const [key, entry] of this.#presence) if (entry.sessionId === sessionId) this.#presence.delete(key);
    return this.#close((connection) => connection.sessionId === sessionId, code, reason);
  }

  closeWorkspace(userId: number, code: number, reason: string): number {
    for (const [key, entry] of this.#presence) if (entry.userId === userId) this.#presence.delete(key);
    return this.#close((connection) => connection.userId === userId, code, reason);
  }

  closeAll(code: number, reason: string): number {
    this.#presence.clear();
    return this.#close(() => true, code, reason);
  }

  #close(match: (connection: AgentConnection) => boolean, code: number, reason: string): number {
    const targets = [...this.#connections].filter(match);
    for (const connection of targets) {
      this.#connections.delete(connection);
      connection.close(code, reason);
    }
    return targets.length;
  }
}
