// Who has a workspace open, by workspace and by portal session, so the control API can report it ("Admin connected")
// and close a session's connections. Two sources: open long-lived connections (event streams, sockets), which can be
// closed, and presence: a tab of the Web Shell polls every few seconds, so a session seen recently has it open.
import { loadSessionContext, type PortalDb, type SessionContext } from "@portal/core";

export type ConnectionRole = "owner" | "admin";

/** An admin viewing someone else's workspace counts as "admin", everyone else as "owner". */
export function connectionRole(context: Pick<SessionContext, "actingAs">): ConnectionRole {
  return context.actingAs ? "admin" : "owner";
}

/** Close code for agent sockets closed by POST /control/sessions/:id/disconnect. */
export const SESSION_DISCONNECTED = 4001;

export interface AgentConnection {
  /** Whose workspace the connection is attached to. */
  readonly userId: number;
  /** sessions.id (the token hash) of the browser session. */
  readonly sessionId: string;
  readonly role: ConnectionRole;
  close(code: number, reason: string): void;
}

/** A session's connection to the workspace of `userId`. */
export function connectionOf(userId: number, context: SessionContext, close: AgentConnection["close"]): AgentConnection {
  return { userId, sessionId: context.session.id, role: connectionRole(context), close };
}

/** A session counts as present this long after its last request. */
export const PRESENCE_MS = 20_000;

type Who = Pick<AgentConnection, "userId" | "sessionId">;

export class ConnectionRegistry {
  readonly #connections = new Set<AgentConnection>();
  readonly #presence = new Map<string, Omit<AgentConnection, "close"> & { seenAt: number }>();
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
    return () => void this.#connections.delete(connection);
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
    return this.#close((who) => who.sessionId === sessionId, code, reason);
  }

  closeWorkspace(userId: number, code: number, reason: string): number {
    return this.#close((who) => who.userId === userId, code, reason);
  }

  closeAll(code: number, reason: string): number {
    return this.#close(() => true, code, reason);
  }

  /** Closes and forgets every (session, workspace) pair that `stillUses` rejects, asking once per pair. */
  sweep(stillUses: (sessionId: string, userId: number) => boolean, code: number, reason: string): number {
    const verdicts = new Map<string, boolean>();
    const gone = ({ sessionId, userId }: Who): boolean => {
      const key = `${userId}\n${sessionId}`;
      let verdict = verdicts.get(key);
      if (verdict === undefined) verdicts.set(key, (verdict = stillUses(sessionId, userId)));
      return !verdict;
    };
    return this.#close(gone, code, reason);
  }

  /** Forgets the presence and closes the connections of those `gone` names; returns the number of connections closed. */
  #close(gone: (who: Who) => boolean, code: number, reason: string): number {
    for (const [key, entry] of this.#presence) if (gone(entry)) this.#presence.delete(key);
    const targets = [...this.#connections].filter(gone);
    for (const connection of targets) {
      this.#connections.delete(connection);
      connection.close(code, reason);
    }
    return targets.length;
  }
}

/**
 * Sessions end without the gateway being told (password change or reset, deactivation, expiry), and an admin may have
 * moved on to another workspace: closes the connections whose session no longer resolves, or no longer uses that workspace.
 */
export function closeEndedSessions(db: PortalDb, registry: ConnectionRegistry, now = Date.now()): number {
  const targets = new Map<string, number | null>();
  const targetOf = (sessionId: string): number | null => {
    if (!targets.has(sessionId)) targets.set(sessionId, loadSessionContext(db, sessionId, now)?.target.id ?? null);
    return targets.get(sessionId) ?? null;
  };
  return registry.sweep((sessionId, userId) => targetOf(sessionId) === userId, SESSION_DISCONNECTED, "session ended");
}
