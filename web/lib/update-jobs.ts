// What the agents' and Gufo's update jobs share on the Updates page.
import type { ApiError, UpdateDrain, UpdateJob } from "@portal/core/wire";

/** What a JSON route of the gateway's data answers; `data` is null when the gateway could not provide it. */
export interface Loaded<T> {
  data: T | null;
  error: ApiError | null;
}

/** A poll's answer; when the gateway can't be reached, the last data stays on screen with the error. */
export function mergeLoaded<T>(current: Loaded<T>, next: Loaded<T>): Loaded<T> {
  return { data: next.data ?? current.data, error: next.error };
}

export const ACTIVE_POLL_MS = 1_000;
export const IDLE_POLL_MS = 15_000;

type Job = Pick<UpdateJob<string>, "finishedAt">;

/** Still running: it holds its updater's one job slot. */
export function isJobActive(job: Job | null): boolean {
  return job !== null && job.finishedAt === null;
}

export function pollDelay(job: Job | null): number {
  return isJobActive(job) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
}

/** What a drain still waits for, as the Updates page says it: "2 requests and a video job". */
export function drainRunning({ inFlight, video }: Pick<UpdateDrain, "inFlight" | "video">): string {
  const requests = `${inFlight} ${inFlight === 1 ? "request" : "requests"}`;
  return video ? (inFlight === 0 ? "A video job" : `${requests} and a video job`) : requests;
}

/** What the wait for running requests ends with (the gateway's drainQueue), for the dialogs that start an update. */
export function drainLimitText(minutes: number): string {
  return `Requests still running after ${minutes} ${minutes === 1 ? "minute" : "minutes"} are cut off: their agents get an error and may retry. A video still being made then is lost.`;
}

/** What the versions on a card are while its releases can't be read; `checkedAt` is null until a check has succeeded. */
export function staleReleasesText(checkedAt: number | null): string {
  const shown = checkedAt === null ? "No check has succeeded yet, so only the installed versions are shown" : "The versions shown are from the last check";
  return `${shown}; updates may fail until it answers.`;
}

/** The "Restart now" dialog's warning. */
export function cutOffText(drain: Pick<UpdateDrain, "inFlight" | "video"> | null): string {
  if (drain === null || (drain.inFlight === 0 && !drain.video)) return "Requests still running are cut off: their agents get an error and may retry.";
  const video = drain.video ? " The video being made is lost." : "";
  const requests = drain.inFlight === 0 ? "" : `${drain.inFlight} running ${drain.inFlight === 1 ? "request is" : "requests are"} cut off: their agents get an error and may retry.`;
  return `${requests}${video}`.trim();
}

export const OFFLINE = "The workspace service is unavailable right now.";

/** The badge beside a card's title. */
export interface CardStatus {
  label: string;
  variant: "success" | "warning" | "info" | "secondary" | "destructive";
  /** Something is under way: the badge shows a spinner. */
  pending: boolean;
}

export interface JobStep {
  /** 1-based. */
  index: number;
  count: number;
  /** The Progress bar's value, 0-100: halfway through the current step. */
  progress: number;
}

/** Where a job is among the phases it runs through. */
export function jobStep(phases: readonly string[], job: Job & Pick<UpdateJob<string>, "phase">): JobStep {
  const found = phases.indexOf(job.phase);
  const index = found === -1 ? phases.length : found + 1;
  return { index, count: phases.length, progress: isJobActive(job) ? Math.round(((index - 0.5) / phases.length) * 100) : 100 };
}
