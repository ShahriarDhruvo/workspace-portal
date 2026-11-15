// One agent update as the admin console sees it, and the only ways it can move:
//
//   building ──▶ verifying ──▶ succeeded
//      │             │
//      └─────────────┴──▶ failed | cancelled      (the current version stays as it was)
//
// Pure state: the updater (agent-updater.ts) drives it and serves snapshots of it.
import type { AgentKind } from "@portal/db";

export type UpdatePhase = "building" | "verifying" | "succeeded" | "failed" | "cancelled";

/** GET /control/agents/versions → job (docs/ARCHITECTURE.md, "Agent versions and updates"). */
export interface AgentUpdateJob {
  id: string;
  agent: AgentKind;
  /** The current version when the job started. */
  fromVersion: string;
  /** The version being installed (a channel is resolved before the job starts). */
  version: string;
  rebuild: boolean;
  /**
   * The job uses the image already on the server: no build, only the version check (it starts in
   * `verifying`; its log says so too).
   */
  reuse: boolean;
  actorUserId: number | null;
  phase: UpdatePhase;
  /** The build step it is at, e.g. "[dsh 3/6] RUN npm install -g …". */
  step: string | null;
  /** The last JOB_LOG_LINES lines of build output. */
  log: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export const JOB_LOG_LINES = 200;
export const CANCELLED = "Cancelled";

export type JobStart = Pick<AgentUpdateJob, "id" | "agent" | "fromVersion" | "version" | "rebuild" | "reuse" | "actorUserId" | "startedAt">;

export class UpdateJob {
  readonly #state: AgentUpdateJob;

  constructor(start: JobStart) {
    this.#state = { ...start, phase: "building", step: null, log: [], finishedAt: null, error: null };
  }

  get agent(): AgentKind {
    return this.#state.agent;
  }

  get version(): string {
    return this.#state.version;
  }

  get phase(): UpdatePhase {
    return this.#state.phase;
  }

  /** Still building or verifying. */
  get active(): boolean {
    return this.#state.phase === "building" || this.#state.phase === "verifying";
  }

  setStep(step: string): void {
    if (this.active) this.#state.step = step;
  }

  appendLog(lines: readonly string[]): void {
    if (!this.active || lines.length === 0) return;
    const log = this.#state.log;
    log.push(...lines.slice(-JOB_LOG_LINES));
    if (log.length > JOB_LOG_LINES) log.splice(0, log.length - JOB_LOG_LINES);
  }

  /** The image is there (just built, or the one already on the server); its version is checked next. */
  verifying(step: string): void {
    this.#expect("building");
    this.#state.phase = "verifying";
    this.#state.step = step;
  }

  succeed(at: number): void {
    this.#expect("verifying");
    this.#finish("succeeded", null, at);
  }

  fail(error: string, at: number): void {
    this.#expect("building", "verifying");
    this.#finish("failed", error, at);
  }

  cancel(at: number): void {
    this.#expect("building", "verifying");
    this.#finish("cancelled", CANCELLED, at);
  }

  /** A copy for the API: later changes to the job don't show in it. */
  snapshot(): AgentUpdateJob {
    return { ...this.#state, log: [...this.#state.log] };
  }

  #finish(phase: UpdatePhase, error: string | null, at: number): void {
    Object.assign(this.#state, { phase, error, finishedAt: at, step: null });
  }

  #expect(...phases: UpdatePhase[]): void {
    if (!phases.includes(this.#state.phase)) throw new Error(`update job ${this.#state.id} is ${this.#state.phase}, not ${phases.join(" or ")}`);
  }
}
