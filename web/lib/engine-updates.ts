// What the Updates page decides about the LLM engine, kept out of its components: its status in a word, the version
// to offer, which actions may run now and why not, the job's stages and words, how often to poll, and the gateway's
// errors in plain words. Pure; unit tested. The gateway's side: docs/ARCHITECTURE.md, "LLM engine updates".
import { z } from "zod";
import type { AdminEngine, EngineImage, EngineOverview, EngineRelease, EngineUpdateJob } from "./engine-types.ts";
import type { ApiError } from "./gateway-types.ts";

/** Poll intervals: a running job moves every second; otherwise little changes (the page also polls on focus). */
export const ENGINE_ACTIVE_POLL_MS = 1_000;
export const ENGINE_IDLE_POLL_MS = 15_000;

/** Still downloading, draining or restarting: it holds the one engine job slot. */
export function isEngineJobActive(job: Pick<EngineUpdateJob, "finishedAt"> | null): boolean {
  return job !== null && job.finishedAt === null;
}

export function enginePollDelay(job: EngineUpdateJob | null): number {
  return isEngineJobActive(job) ? ENGINE_ACTIVE_POLL_MS : ENGINE_IDLE_POLL_MS;
}

/** A poll's answer; when the gateway can't be reached, the last overview stays on screen with the error. */
export function mergeEngine(current: AdminEngine, next: AdminEngine): AdminEngine {
  return { engine: next.engine ?? current.engine, error: next.error };
}

// ---- Input -----------------------------------------------------------------------------------------------------

/** An engine release: the registry's stable X.Y.Z tags, the only versions the gateway installs. */
export const engineVersionSchema = z
  .string()
  .trim()
  .regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/, "Choose a release version, like 0.34.0.");

/** An engine image on the LLM server, by digest; its version is only for the audit entry. */
export const engineImageSchema = z.object({
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, "Unknown image."),
  version: z.string().trim().max(64).nullable(),
});

// ---- Versions --------------------------------------------------------------------------------------------------

/** Compares X.Y.Z versions numerically (anything else sorts as 0.0.0). */
export function compareEngineVersions(a: string, b: string): number {
  const parts = (version: string) => (/^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : [0, 0, 0]);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** The release `latest` points at, else the newest one listed. */
export function latestEngineRelease(overview: Pick<EngineOverview, "releases">): EngineRelease | null {
  const releases = overview.releases?.releases ?? [];
  return releases.find((release) => release.latest) ?? [...releases].sort((a, b) => compareEngineVersions(b.version, a.version))[0] ?? null;
}

/** The version "Update to …" installs: the latest release, when it is newer than what runs. */
export function engineUpdateTarget(overview: Pick<EngineOverview, "releases" | "engine">): string | null {
  const latest = latestEngineRelease(overview);
  const current = overview.engine?.version ?? null;
  if (!latest || !current) return null;
  return compareEngineVersions(latest.version, current) > 0 ? latest.version : null;
}

/** Releases newer than what runs, newest first: their notes are what an update brings. */
export function newerEngineReleases(overview: Pick<EngineOverview, "releases" | "engine">): EngineRelease[] {
  const current = overview.engine?.version ?? null;
  return (overview.releases?.releases ?? [])
    .filter((release) => current === null || compareEngineVersions(release.version, current) > 0)
    .sort((a, b) => compareEngineVersions(b.version, a.version));
}

export type StatusVariant = "success" | "warning" | "info" | "secondary" | "destructive";

export interface EngineStatusBadge {
  label: string;
  variant: StatusVariant;
  /** Something is under way: the badge shows a spinner. */
  pending: boolean;
}

/** The badge beside the engine's title. `unreachable`: the portal can't reach the gateway itself. */
export function engineStatusBadge(overview: EngineOverview | null, unreachable: boolean): EngineStatusBadge {
  if (!overview) return { label: "Can't reach", variant: "destructive", pending: false };
  switch (overview.state) {
    case "off":
      return { label: "Not set up", variant: "secondary", pending: false };
    case "offline":
      return { label: "Can't reach", variant: "destructive", pending: false };
    case "no_engine":
      return { label: "No engine", variant: "secondary", pending: false };
    case "ok":
      break;
  }
  if (isEngineJobActive(overview.job)) {
    const back = overview.job?.kind === "rollback" || overview.job?.rolledBack;
    return { label: back ? "Rolling back…" : "Updating…", variant: "info", pending: true };
  }
  if (unreachable) return { label: "Can't reach", variant: "destructive", pending: false };
  if (overview.engine && !overview.engine.ready) return { label: "Starting", variant: "warning", pending: true };
  if (engineUpdateTarget(overview)) return { label: "Update available", variant: "warning", pending: false };
  if (!latestEngineRelease(overview) || !overview.engine?.version) return { label: "Latest unknown", variant: "secondary", pending: false };
  return { label: "Up to date", variant: "success", pending: false };
}

// ---- What may run now ------------------------------------------------------------------------------------------

const UNREACHABLE = "The workspace service is unavailable right now.";
const JOB_RUNNING = "An engine update is running. Wait for it to finish, or cancel it.";

/** Why no update or rollback can start right now, or null when one can. */
export function engineUpdateBlocker(overview: EngineOverview | null, unreachable: boolean): string | null {
  if (unreachable || !overview) return UNREACHABLE;
  if (overview.state !== "ok") return "The LLM server's portal-hostd isn't available.";
  if (isEngineJobActive(overview.job)) return JOB_RUNNING;
  return null;
}

/** Why this image can't be removed right now, or null when it can. portal-hostd enforces the same. */
export function engineRemoveBlocker(overview: EngineOverview | null, unreachable: boolean, image: EngineImage): string | null {
  const blocked = engineUpdateBlocker(overview, unreachable);
  if (blocked) return blocked;
  if (image.current) return "The engine runs this image. Switch to another version first.";
  if (!image.digest) return "This image has no digest, so it can't be removed from here.";
  return null;
}

// ---- The job ---------------------------------------------------------------------------------------------------

const STAGE_LABELS: Record<EngineUpdateJob["stage"], string> = {
  pulling: "Downloading the image",
  draining: "Waiting for running requests",
  restarting: "Restarting the engine",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** The stage in words; once a restart failed (`rolledBack`), the LLM server is putting the previous version back. */
export function engineStageLabel(job: Pick<EngineUpdateJob, "stage" | "rolledBack" | "fromVersion">): string {
  if (job.rolledBack && job.stage === "restarting") return `Putting ${version(job.fromVersion)} back`;
  return STAGE_LABELS[job.stage];
}

export interface EngineJobStep {
  /** 1-based. */
  index: number;
  count: number;
  /** The Progress bar's value, 0-100: halfway through the current step. */
  progress: number;
}

/** Where a running job is: an update downloads, drains and restarts; a rollback only drains and restarts. */
export function engineJobStep(job: Pick<EngineUpdateJob, "kind" | "stage">): EngineJobStep {
  const stages = job.kind === "update" ? ["pulling", "draining", "restarting"] : ["draining", "restarting"];
  const found = stages.indexOf(job.stage);
  const index = found === -1 ? stages.length : found + 1;
  const done = job.stage === "succeeded" || job.stage === "failed" || job.stage === "cancelled";
  return { index, count: stages.length, progress: done ? 100 : Math.round(((index - 0.5) / stages.length) * 100) };
}

type JobWords = Pick<EngineUpdateJob, "kind" | "stage" | "fromVersion" | "toVersion">;

const version = (value: string | null) => value ?? "an unknown version";

/** The job in a few words: "Updating the LLM engine 0.31.0 → 0.34.0", "LLM engine rolled back to 0.30.0"… */
export function engineJobTitle(job: JobWords): string {
  const rollback = job.kind === "rollback";
  switch (job.stage) {
    case "pulling":
    case "draining":
    case "restarting":
      return `${rollback ? "Rolling the LLM engine back" : "Updating the LLM engine"} ${version(job.fromVersion)} → ${version(job.toVersion)}`;
    case "succeeded":
      return `LLM engine ${rollback ? "rolled back" : "updated"} to ${version(job.toVersion)}`;
    case "failed":
      return rollback ? "Rollback of the LLM engine failed" : `Update of the LLM engine to ${version(job.toVersion)} failed`;
    case "cancelled":
      return rollback ? "Rollback of the LLM engine cancelled" : `Update of the LLM engine to ${version(job.toVersion)} cancelled`;
  }
}

/** What a finished job means for the engine and its requests. */
export function engineJobOutcome(job: JobWords & Pick<EngineUpdateJob, "rolledBack">): string {
  switch (job.stage) {
    case "succeeded":
      return `The engine runs ${version(job.toVersion)}. Requests that waited during the restart went to it.`;
    case "cancelled":
      return `Nothing changed: the engine still runs ${version(job.fromVersion)}.`;
    case "failed":
      return job.rolledBack
        ? `${version(job.toVersion)} didn't start properly, so ${version(job.fromVersion)} runs again.`
        : "Check the engine on the LLM server: the status above shows what runs now.";
    default:
      return "";
  }
}

// ---- Errors ----------------------------------------------------------------------------------------------------

export type EngineAction = "update" | "rollback" | "cancel" | "restart" | "remove";

/** A failed action in words: the gateway's own message where it is clear (it names versions), else ours. */
export function engineActionError(action: EngineAction, error: ApiError): string {
  switch (error.error) {
    case "engine_job_running":
      return JOB_RUNNING;
    case "no_previous":
      return "There is no previous version to go back to.";
    case "image_current":
      return "The engine runs this image. Switch to another version first.";
    case "not_found":
      return action === "remove" ? "This image is no longer on the LLM server." : error.message;
    case "timeout":
      return action === "update" || action === "rollback"
        ? "The workspace service did not answer in time. The job may have started anyway: this page shows it if so."
        : error.message;
    default:
      return error.message;
  }
}
