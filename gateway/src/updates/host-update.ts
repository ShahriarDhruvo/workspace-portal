// What Gufo's and the other software's updates (engine-updater.ts, app-updater.ts) do alike through the AI server's
// portal-hostd: hold the LLM queue while the requests in flight and a video job finish, and follow one of hostd's jobs
// to its end.
// Each updater keeps its own job record, phases and order through them.
import { setTimeout as delay } from "node:timers/promises";
import type { UpdateDrain } from "@portal/core";
import type { LlmQueue } from "../service/llm-queue.ts";
import { errorMessage } from "../lib/log.ts";

/** Thrown to end a job that was cancelled, or recorded as ended (the gateway stopping) while it waited. */
export class Cancelled extends Error {}

const DRAIN_POLL_MS = 250;

/** hostd's own job, as its status routes report it (its engine's or an app's). */
export interface HostJob {
  id: string;
  kind: string;
  phase: "running" | "succeeded" | "failed" | "cancelled";
  step: string;
  log: string[];
}

/** What a drain changes on the gateway's job: its drain figures, and whether it may still be cancelled. */
export interface DrainingJob {
  drain: UpdateDrain | null;
  cancellable: boolean;
  finishedAt: number | null;
}

/** An admin's requests to a running job, which the loops below check. */
export interface JobControl {
  cancelRequested: boolean;
  restartNow: boolean;
}

export interface DrainOptions {
  job: DrainingJob;
  queue: LlmQueue;
  drainMs: number;
  control: JobControl;
  now: () => number;
  pollMs: number;
  /** Called once the queue holds new requests: the job enters its draining phase. */
  started: () => void;
  note: (line: string) => void;
}

/**
 * Holds new requests in the queue and waits for the running ones, or the deadline, or "Restart now". The queue stays
 * paused: the caller resumes it once the AI server serves again. Throws Cancelled when cancelled meanwhile.
 */
export async function drainQueue({ job, queue, drainMs, control, now, pollMs, started, note }: DrainOptions): Promise<void> {
  const since = now();
  const deadline = since + drainMs;
  queue.pause();
  job.drain = { since, deadline, ...drainRunning(queue) };
  started();
  note(`New LLM requests wait in the portal's queue; ${runningText(queue)} still running.`);
  while (queue.inFlight > 0 || queue.held) {
    if (control.cancelRequested || job.finishedAt !== null) throw new Cancelled();
    if (control.restartNow) {
      note(`Restarting now on request; ${runningText(queue)} will be cut off.`);
      break;
    }
    if (now() >= deadline) {
      note(`Still ${runningText(queue)} running after ${Math.round(drainMs / 60_000)} minutes; restarting anyway.`);
      break;
    }
    await delay(Math.min(DRAIN_POLL_MS, pollMs));
  }
  if (control.cancelRequested || job.finishedAt !== null) throw new Cancelled();
  job.drain = null;
  job.cancellable = false;
}

/** What a drain still waits for: the requests in flight, and a video job holding the AI server. */
export function drainRunning(queue: Pick<LlmQueue, "inFlight" | "held">): { inFlight: number; video: boolean } {
  return { inFlight: queue.inFlight, video: queue.held };
}

function runningText(queue: LlmQueue): string {
  const requests = `${queue.inFlight} request${queue.inFlight === 1 ? "" : "s"}`;
  return queue.held ? `${requests} and a video job` : requests;
}

export interface FollowOptions<J extends HostJob> {
  /** The gateway's job: `step` takes hostd's, `log` takes hostd's lines once its job has ended. */
  job: { step: string; log: string[]; finishedAt: number | null };
  started: J;
  /** hostd's current job, from its status route. Rejects while hostd can't be reached. */
  current: () => Promise<J | null>;
  now: () => number;
  pollMs: number;
  timeoutMs: number;
  /** hostd's job as last seen while it runs (its live log), and null once it has ended. */
  live: (job: J | null) => void;
  note: (line: string) => void;
}

/** Follows a hostd job until it ends and returns it as it ended. Throws Cancelled when the gateway's job ended meanwhile. */
export async function followHostJob<J extends HostJob>({ job, started, current, now, pollMs, timeoutMs, live, note }: FollowOptions<J>): Promise<J> {
  live(started);
  const until = now() + timeoutMs;
  let unreachable = false;
  while (now() < until) {
    await delay(pollMs);
    // The AI server may be busy restarting; keep trying until the time limit.
    const seen = await current().then(
      (value) => ({ value }),
      (error: unknown) => {
        if (!unreachable) note(`portal-hostd did not answer (${errorMessage(error)}); still trying.`);
        return null;
      },
    );
    if (job.finishedAt !== null) throw new Cancelled();
    unreachable = seen === null;
    const hostJob = seen?.value;
    if (!hostJob || hostJob.id !== started.id) continue;
    live(hostJob);
    if (hostJob.step) job.step = hostJob.step;
    if (hostJob.phase !== "running") {
      job.log.push(...hostJob.log);
      live(null);
      return hostJob;
    }
  }
  throw new Error(`portal-hostd's ${started.kind} did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`);
}
