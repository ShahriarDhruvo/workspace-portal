// One agent update as the admin console sees it, and the only ways it can move:
//
//   building ──▶ verifying ──▶ succeeded
//      │             │
//      └─────────────┴──▶ failed | cancelled      (the current version stays as it was)
//
// Pure state: the updater (agent-updater.ts) drives it and serves snapshots of it.
import type { AgentKind, AgentUpdateJob, UpdatePhase } from "@portal/core";

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
