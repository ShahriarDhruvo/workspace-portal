// Each run of a user's workspace, from Start to its stop (workspace_sessions), and what its LLM requests added up
// to, for Admin > Usage's sessions table. The workspace manager reports every state it saves (sync): a session
// opens when the workspace starts and closes once it has stopped; a start that fails before the workspace ran
// leaves none. A request that reaches the LLM server belongs to its user's session open at that moment, which counts its
// tokens and the engine's timings when it ends; llm-energy.ts adds each request's share of the LLM server's
// energy as it is measured. `version` changes with every write, so the live view tells the page to read the table
// again.
import { and, eq, isNull, sql } from "drizzle-orm";
import { workspaceSessions, type AgentKind, type PortalDb, type WorkspaceKind, type WorkspaceStatus } from "@portal/core";
import type { FinishedLlmRequest } from "./llm-requests.ts";
import type { Logger } from "../lib/log.ts";

/** A workspace's state as the manager keeps it (an Entry, or a WorkspaceInfo). */
export interface WorkspaceRunState {
  userId: number;
  status: WorkspaceStatus;
  kind: WorkspaceKind;
  agent: AgentKind | null;
  startedAt: number | null;
  /** When it stopped; without it a session closes now. */
  stoppedAt?: number | null;
}

/**
 * Energy a session's requests used in one stretch of time, and how long it had a request running in it (parallel
 * ones count once) (llm-energy.ts).
 */
export interface EnergyShare {
  sessionId: number;
  joules: number;
  ms: number;
}

export interface SessionLogOptions {
  db: PortalDb;
  log: Logger;
  now?: () => number;
}

export class SessionLog {
  readonly #db: PortalDb;
  readonly #log: Logger;
  readonly #now: () => number;
  /**
   * Each running workspace's open session: its id, the workspace's startedAt it began with, and whether the
   * workspace got to running (one open before the gateway started did).
   */
  readonly #open = new Map<number, { id: number; startedAt: number; ran: boolean }>();
  /** The session of each request between reaching the LLM server and ending, by request id. */
  readonly #requests = new Map<number, number>();
  #version = 0;

  constructor(options: SessionLogOptions) {
    this.#db = options.db;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    const open = this.#db
      .select({ id: workspaceSessions.id, userId: workspaceSessions.userId, startedAt: workspaceSessions.startedAt })
      .from(workspaceSessions)
      .where(isNull(workspaceSessions.endedAt))
      .all();
    for (const row of open) this.#open.set(row.userId, { id: row.id, startedAt: row.startedAt, ran: true });
  }

  /** Changes with every write to the sessions. */
  get version(): number {
    return this.#version;
  }

  /** A workspace's state as the manager saved it. */
  sync(state: WorkspaceRunState): void {
    try {
      if (this.#sync(state)) this.#version++;
    } catch (error) {
      this.#log.error("could not update the workspace's session", { userId: state.userId, error });
    }
  }

  /**
   * After the gateway starts: running workspaces get their session (one from before sessions were kept starts
   * now), and a session left open by a workspace that is gone closes.
   */
  reconcile(states: readonly WorkspaceRunState[]): void {
    const known = new Set(states.map((state) => state.userId));
    for (const [userId, open] of [...this.#open]) {
      if (!known.has(userId)) this.sync({ userId, status: "stopped", kind: "private", agent: null, startedAt: open.startedAt, stoppedAt: null });
    }
    for (const state of states) this.sync(state);
  }

  /** Whether anything changed. */
  #sync(state: WorkspaceRunState): boolean {
    const open = this.#open.get(state.userId);
    if (state.status !== "stopped" && state.status !== "error") {
      const startedAt = state.startedAt ?? this.#now();
      if (open?.startedAt === startedAt) {
        if (state.status === "running") open.ran = true;
        return false;
      }
      const id = this.#db.transaction((tx) => {
        // A new start while the last one is still open (its stop was never saved): that one ended as this began.
        if (open) tx.update(workspaceSessions).set({ endedAt: Math.max(open.startedAt, startedAt) }).where(eq(workspaceSessions.id, open.id)).run();
        return tx
          .insert(workspaceSessions)
          .values({ userId: state.userId, kind: state.kind, agent: state.agent, startedAt })
          .returning({ id: workspaceSessions.id })
          .get().id;
      });
      this.#open.set(state.userId, { id, startedAt, ran: state.status === "running" });
      return true;
    }
    if (!open) return false;
    const where = eq(workspaceSessions.id, open.id);
    const failedStart =
      state.status === "error" && !open.ran && this.#db.delete(workspaceSessions).where(and(where, eq(workspaceSessions.requests, 0))).run().changes > 0;
    if (!failedStart) {
      this.#db
        .update(workspaceSessions)
        .set({ endedAt: Math.max(open.startedAt, state.stoppedAt ?? this.#now()) })
        .where(where)
        .run();
    }
    this.#open.delete(state.userId);
    return true;
  }

  /** A request reached the LLM server: the session it belongs to, null when its user has none open. */
  forwarded(requestId: number, userId: number): number | null {
    const open = this.#open.get(userId);
    if (!open) return null;
    this.#requests.set(requestId, open.id);
    return open.id;
  }

  /** A request that reached the LLM server ended: its session counts it, even if it has closed meanwhile. */
  finished(request: FinishedLlmRequest): void {
    const sessionId = this.#requests.get(request.id);
    if (sessionId === undefined) return;
    this.#requests.delete(request.id);
    const { timings, usage } = request;
    // Tokens as the answer's usage counts them (as llm_usage does), else as the engine's timings do.
    const tokensIn = usage?.promptTokens ?? (timings ? timings.promptTokens + timings.cachedTokens : 0);
    const tokensOut = usage?.completionTokens ?? timings?.generatedTokens ?? 0;
    const s = workspaceSessions;
    try {
      this.#db
        .update(s)
        .set({
          requests: sql`${s.requests} + 1`,
          failed: sql`${s.failed} + ${request.ok ? 0 : 1}`,
          promptTokens: sql`${s.promptTokens} + ${tokensIn}`,
          outputTokens: sql`${s.outputTokens} + ${tokensOut}`,
          cachedTokens: sql`${s.cachedTokens} + ${timings?.cachedTokens ?? 0}`,
          readTokens: sql`${s.readTokens} + ${timings?.promptTokens ?? 0}`,
          readMs: sql`${s.readMs} + ${timings?.promptMs ?? 0}`,
          writeTokens: sql`${s.writeTokens} + ${timings?.generatedTokens ?? 0}`,
          writeMs: sql`${s.writeMs} + ${timings?.generationMs ?? 0}`,
          llmMs: sql`${s.llmMs} + ${Math.max(0, Math.round(request.durationMs))}`,
        })
        .where(eq(s.id, sessionId))
        .run();
      this.#version++;
    } catch (error) {
      this.#log.error("could not count an LLM request in its session", { userId: request.userId, error });
    }
  }

  /** Shares of the LLM server's measured energy (llm-energy.ts). */
  addEnergy(shares: readonly EnergyShare[]): void {
    if (shares.length === 0) return;
    const s = workspaceSessions;
    try {
      this.#db.transaction((tx) => {
        for (const share of shares) {
          tx.update(s)
            .set({ energyJ: sql`coalesce(${s.energyJ}, 0) + ${share.joules}`, energyMs: sql`${s.energyMs} + ${Math.round(share.ms)}` })
            .where(eq(s.id, share.sessionId))
            .run();
        }
      });
      this.#version++;
    } catch (error) {
      this.#log.error("could not add energy to the workspace sessions", { error });
    }
  }
}
