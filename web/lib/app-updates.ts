// What the Updates page decides about the other software on the AI server: llama-swap, vLLM, Ming-Image and the media
// programs of llm-server/apps.json (docs/ARCHITECTURE.md, "Updates of the other software").
import { z } from "zod";
import { compareAppVersions } from "@portal/core/wire";
import type { ApiError, AppRelease, AppStatus, AppsOverview, AppUpdateJob, AppVersion, ReleaseNotes } from "@portal/core/wire";
import { isJobActive, jobStep, OFFLINE, versionName, type CardStatus, type JobStep } from "./update-jobs.ts";

/** portal-hostd's pattern for a version (it names a directory): what the dialogs send. */
export const appVersionSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/, "Choose a version from the list.");

/** An app's id in llm-server/apps.json. */
export const appIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Unknown program.");

export const appVersionRefSchema = z.object({ app: appIdSchema, version: appVersionSchema });

/** One program on the Updates page: as portal-hostd reports it, with its releases. */
export type AppEntry = AppsOverview["apps"][number];

/**
 * The release marked latest. null until the program's releases have been read: before that the list holds only the
 * installed versions, none of them marked.
 */
export function latestAppRelease(entry: AppEntry): AppRelease | null {
  return entry.releases.releases.find((release) => release.latest) ?? null;
}

/**
 * Whether `version` of the program is newer than `than`. Commit ids have no order of their own: for a program whose
 * versions are commits (`releases.commits`), newer means earlier among the commits GitHub listed, which are the ones
 * with notes. A commit it did not list is older than all of those, and neither newer nor older than another such.
 */
function isNewerAppVersion(entry: AppEntry, version: string, than: string): boolean {
  if (entry.status.releases.commits === undefined) return compareAppVersions(version, than) > 0;
  const place = (id: string): number => {
    const index = entry.releases.releases.findIndex((release) => release.version === id && release.notes !== null);
    return index === -1 ? Infinity : index;
  };
  return place(version) < place(than);
}

/** The version "Update to …" installs: the latest release, when it is newer than the one in use. */
export function appUpdateTarget(entry: AppEntry): string | null {
  const latest = latestAppRelease(entry);
  const current = entry.status.version;
  if (!latest || !current) return null;
  return isNewerAppVersion(entry, latest.version, current) ? latest.version : null;
}

/** One row of a program's Versions table. */
export interface AppPackageRow {
  version: string;
  latest: boolean;
  /** From its GitHub release, or the commit's date; null when unknown. */
  publishedAt: number | null;
  notes: ReleaseNotes | null;
  /** The version in use. */
  running: boolean;
  /** It is installed on the AI server; null: it is installed (or downloaded) first. */
  image: AppVersion | null;
}

/** The releases (newest first, with every installed version) as rows, each with what is installed of it. */
export function appPackageRows(entry: AppEntry): AppPackageRow[] {
  const { status } = entry;
  return entry.releases.releases.map(({ version, latest, notes }) => ({
    version,
    latest,
    publishedAt: notes?.publishedAt ?? null,
    notes,
    running: version === status.version,
    image: status.versions.find((installed) => installed.version === version) ?? null,
  }));
}

/** Does the program start on its own (llama-swap), or does llama-swap start it with its model? */
const onDemand = (status: Pick<AppStatus, "model">): boolean => status.model !== null;

/** The badge beside a program's title. */
export function appStatusBadge(overview: Pick<AppsOverview, "job">, entry: AppEntry): CardStatus {
  const { status } = entry;
  const job = overview.job;
  if (isJobActive(job) && job?.app === status.id) {
    return { label: job.rolledBack ? "Rolling back…" : "Updating…", variant: "info", pending: true };
  }
  if (status.error) return { label: "Can't read", variant: "destructive", pending: false };
  if (status.state === "failed") return { label: "Failed", variant: "destructive", pending: false };
  // A program behind llama-swap runs only while its model is loaded.
  if (!onDemand(status) && status.state !== "active") return { label: "Not running", variant: "destructive", pending: false };
  if (appUpdateTarget(entry)) return { label: "Update available", variant: "warning", pending: false };
  if (!latestAppRelease(entry) || !status.version) return { label: "Latest unknown", variant: "secondary", pending: false };
  return { label: "Up to date", variant: "success", pending: false };
}

const JOB_RUNNING = "An update of the AI server's software is running. Wait for it to finish, or cancel it.";
const ENGINE_RUNNING = "A Gufo update is running. Wait for it to finish, or cancel it.";

/**
 * Why no update can start right now, or null when one can. One job at a time runs on the AI server, for every program
 * and Gufo: `engineJob` is Gufo's.
 */
export function appUpdateBlocker(overview: AppsOverview | null, unreachable: boolean, engineJob: { finishedAt: number | null } | null): string | null {
  if (unreachable || !overview) return OFFLINE;
  if (overview.state !== "ok") return "The AI server's portal-hostd isn't available.";
  if (isJobActive(overview.job)) return JOB_RUNNING;
  if (isJobActive(engineJob)) return ENGINE_RUNNING;
  return null;
}

/** Why this installed version can't be removed right now, or null when it can. portal-hostd enforces the same. */
export function appRemoveBlocker(overview: AppsOverview | null, unreachable: boolean, engineJob: { finishedAt: number | null } | null, version: AppVersion): string | null {
  return appUpdateBlocker(overview, unreachable, engineJob) ?? (version.current ? "This version is in use. Switch to another one first." : null);
}

const versionOrUnknown = (value: string | null) => (value === null ? "an unknown version" : versionName(value));

/** What a running job is doing; once a restart failed (`rolledBack`), the AI server is putting the previous version back. */
export function appPhaseLabel(job: Pick<AppUpdateJob, "phase" | "rolledBack" | "fromVersion" | "appName">): string {
  if (job.phase === "installing") return "Installing the new version";
  if (job.phase === "draining") return "Waiting for running requests";
  return job.rolledBack ? `Putting ${versionOrUnknown(job.fromVersion)} back` : `Restarting ${job.appName}`;
}

/** It installs, drains and restarts; with the version installed already, only the last two. */
export function appJobStep(job: Pick<AppUpdateJob, "reuse" | "phase" | "finishedAt">): JobStep {
  return jobStep(job.reuse ? ["draining", "restarting"] : ["installing", "draining", "restarting"], job);
}

type JobWords = Pick<AppUpdateJob, "phase" | "fromVersion" | "toVersion" | "appName">;

/**
 * "Updating llama-swap 276 → 277", "vLLM switched to 0.31.0", "Update of Fish Speech to 2.0.0 failed"… `entry` is
 * the job's program, whose releases say which of two commits is the older one.
 */
export function appJobTitle(job: JobWords, entry: AppEntry): string {
  const older = job.fromVersion !== null && isNewerAppVersion(entry, job.fromVersion, job.toVersion);
  const [verb, done, noun] = older ? ["Switching", "switched", "Switch"] : ["Updating", "updated", "Update"];
  const to = versionName(job.toVersion);
  switch (job.phase) {
    case "installing":
    case "draining":
    case "restarting":
      return `${verb} ${job.appName} ${versionOrUnknown(job.fromVersion)} → ${to}`;
    case "succeeded":
      return `${job.appName} ${done} to ${to}`;
    case "failed":
      return `${noun} of ${job.appName} to ${to} failed`;
    case "cancelled":
      return `${noun} of ${job.appName} to ${to} cancelled`;
  }
}

/** What a finished job means for the program and the requests. */
export function appJobOutcome(job: JobWords & Pick<AppUpdateJob, "rolledBack">): string {
  switch (job.phase) {
    case "succeeded":
      return `${job.appName} ${versionName(job.toVersion)} is in use. Requests that waited during the restart went on afterwards.`;
    case "cancelled":
      return `Nothing changed: ${job.appName} ${versionOrUnknown(job.fromVersion)} is still in use.`;
    case "failed":
      return job.rolledBack
        ? `${versionName(job.toVersion)} didn't start properly, so ${versionOrUnknown(job.fromVersion)} is in use again.`
        : `Check ${job.appName} on the AI server: its card shows what is in use now.`;
    default:
      return "";
  }
}

export type AppAction = "update" | "cancel" | "restart" | "remove";

/** A failed action in words: the gateway's own message where it is clear (it names versions), else ours. */
export function appActionError(action: AppAction, error: ApiError): string {
  switch (error.error) {
    case "app_job_running":
      return JOB_RUNNING;
    case "engine_job_running":
      return ENGINE_RUNNING;
    case "version_current":
      return "This version is in use. Switch to another one first.";
    case "not_found":
      return action === "remove" ? "This version is no longer on the AI server." : error.message;
    case "timeout":
      return action === "update"
        ? "The workspace service did not answer in time. The job may have started anyway: this page shows it if so."
        : error.message;
    default:
      return error.message;
  }
}
