// What the Updates page decides about Gufo (docs/ARCHITECTURE.md, "Gufo updates").
import { z } from "zod";
import { compareVersions, isStableVersion } from "@portal/core/wire";
import type { ApiError, EngineImage, EngineOverview, EngineRelease, EngineStatus, EngineUpdateJob, ReleaseNotes } from "@portal/core/wire";
import { isJobActive, jobStep, OFFLINE, type CardStatus, type JobStep } from "./update-jobs.ts";

/** An engine release: the registry's stable X.Y.Z tags, the only versions the gateway installs. */
export const engineVersionSchema = z
  .string()
  .trim()
  .regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/, "Choose a release version, like 0.34.0.");

/** An engine image on the AI server, by digest; its version is only for the audit entry. */
export const engineImageSchema = z.object({
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, "Unknown image."),
  version: z.string().trim().max(64).nullable(),
});

/** Compares X.Y.Z versions numerically (anything else sorts as 0.0.0). */
export function compareEngineVersions(a: string, b: string): number {
  const release = (version: string) => (isStableVersion(version) ? version : "0.0.0");
  return compareVersions(release(a), release(b))!;
}

/** The release `latest` points at, else the first X.Y.Z one listed (the gateway sorts newest first), else the first. */
export function latestEngineRelease(overview: Pick<EngineOverview, "releases">): EngineRelease | null {
  const releases = overview.releases?.releases ?? [];
  return releases.find((release) => release.latest) ?? releases.find((release) => isStableVersion(release.version)) ?? releases[0] ?? null;
}

/** The version "Update to …" installs: the latest release, when it is newer than what runs. */
export function engineUpdateTarget(overview: Pick<EngineOverview, "releases" | "engine">): string | null {
  const latest = latestEngineRelease(overview);
  const current = overview.engine?.version ?? null;
  if (!latest || !current) return null;
  return compareEngineVersions(latest.version, current) > 0 ? latest.version : null;
}

/** One row of the engine's Package images table. */
export interface EnginePackageRow {
  version: string;
  latest: boolean;
  /** From its GitHub release (the image registry has no dates); null when unknown. */
  publishedAt: number | null;
  notes: ReleaseNotes | null;
  /** The engine runs it. */
  running: boolean;
  /** Its image on the AI server; null: it downloads first. */
  image: EngineImage | null;
}

/**
 * The gateway's releases (newest first: the newest ones, what runs, the images on the AI server) as rows, each with
 * its image on the AI server: the one labelled with that version, else the one with its digest. The gateway uses an
 * image of that version as it is (engine-updater.ts), so a row with one switches without a download.
 */
export function enginePackageRows(releases: readonly EngineRelease[], engine: Pick<EngineStatus, "version" | "images">): EnginePackageRow[] {
  return releases.map(({ version, digest, latest, notes }) => ({
    version,
    latest,
    publishedAt: notes?.publishedAt ?? null,
    notes,
    running: version === engine.version,
    image:
      engine.images.find((image) => image.version === version) ??
      engine.images.find((image) => image.digest !== null && image.digest === digest) ??
      null,
  }));
}

/** The badge beside the engine's title. `unreachable`: the portal can't reach the gateway itself. */
export function engineStatusBadge(overview: EngineOverview | null, unreachable: boolean): CardStatus {
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
  if (isJobActive(overview.job)) {
    return { label: overview.job?.rolledBack ? "Rolling back…" : "Updating…", variant: "info", pending: true };
  }
  if (unreachable) return { label: "Can't reach", variant: "destructive", pending: false };
  // Behind llama-swap the engine is stopped on purpose while an image or media model runs, and starts with the next request.
  if (overview.engine?.unloaded) return { label: "Not loaded", variant: "secondary", pending: false };
  if (overview.engine && !overview.engine.ready) return { label: "Starting", variant: "warning", pending: true };
  if (engineUpdateTarget(overview)) return { label: "Update available", variant: "warning", pending: false };
  if (!latestEngineRelease(overview) || !overview.engine?.version) return { label: "Latest unknown", variant: "secondary", pending: false };
  return { label: "Up to date", variant: "success", pending: false };
}

const JOB_RUNNING = "An engine update is running. Wait for it to finish, or cancel it.";
const APP_JOB_RUNNING = "An update of the AI server's software is running. Wait for it to finish, or cancel it.";

/**
 * Why no update can start right now, or null when one can. One job at a time runs on the AI server: `appJob` is the
 * other software's.
 */
export function engineUpdateBlocker(overview: EngineOverview | null, unreachable: boolean, appJob: { finishedAt: number | null } | null = null): string | null {
  if (unreachable || !overview) return OFFLINE;
  if (overview.state !== "ok") return "The AI server's portal-hostd isn't available.";
  if (isJobActive(overview.job)) return JOB_RUNNING;
  if (isJobActive(appJob)) return APP_JOB_RUNNING;
  return null;
}

/** Why this image can't be removed right now, or null when it can. portal-hostd enforces the same. */
export function engineRemoveBlocker(overview: EngineOverview | null, unreachable: boolean, image: EngineImage, appJob: { finishedAt: number | null } | null = null): string | null {
  const blocked = engineUpdateBlocker(overview, unreachable, appJob);
  if (blocked) return blocked;
  if (image.current) return "The engine runs this image. Use another version first.";
  if (!image.digest) return "This image has no digest, so it can't be removed from here.";
  return null;
}

/** What a running job is doing; once a restart failed (`rolledBack`), the AI server is putting the previous version back. */
export function enginePhaseLabel(job: Pick<EngineUpdateJob, "phase" | "rolledBack" | "fromVersion">): string {
  if (job.phase === "pulling") return "Downloading the image";
  if (job.phase === "draining") return "Waiting for running requests";
  return job.rolledBack ? `Putting ${version(job.fromVersion)} back` : "Restarting the engine";
}

/** It downloads, drains and restarts; with the image on the AI server already, only the last two. */
export function engineJobStep(job: Pick<EngineUpdateJob, "reuse" | "phase" | "finishedAt">): JobStep {
  return jobStep(job.reuse ? ["draining", "restarting"] : ["pulling", "draining", "restarting"], job);
}

type JobWords = Pick<EngineUpdateJob, "phase" | "fromVersion" | "toVersion">;

const version = (value: string | null) => value ?? "an unknown version";

/**
 * The job in a few words, an update to a newer version or a switch to an older one: "Updating Gufo 0.31.0
 * → 0.34.0", "Gufo switched to 0.30.0", "Update of Gufo to 0.34.0 failed"…
 */
export function engineJobTitle(job: JobWords): string {
  const older = job.fromVersion !== null && compareEngineVersions(job.toVersion, job.fromVersion) < 0;
  const [verb, done, noun] = older ? ["Switching", "switched", "Switch"] : ["Updating", "updated", "Update"];
  switch (job.phase) {
    case "pulling":
    case "draining":
    case "restarting":
      return `${verb} Gufo ${version(job.fromVersion)} → ${job.toVersion}`;
    case "succeeded":
      return `Gufo ${done} to ${job.toVersion}`;
    case "failed":
      return `${noun} of Gufo to ${job.toVersion} failed`;
    case "cancelled":
      return `${noun} of Gufo to ${job.toVersion} cancelled`;
  }
}

/** What a finished job means for the engine and its requests. */
export function engineJobOutcome(job: JobWords & Pick<EngineUpdateJob, "rolledBack">): string {
  switch (job.phase) {
    case "succeeded":
      return `The engine runs ${job.toVersion}. Requests that waited during the restart went to it.`;
    case "cancelled":
      return `Nothing changed: the engine still runs ${version(job.fromVersion)}.`;
    case "failed":
      return job.rolledBack
        ? `${job.toVersion} didn't start properly, so ${version(job.fromVersion)} runs again.`
        : "Check the engine on the AI server: the status above shows what runs now.";
    default:
      return "";
  }
}

export type EngineAction = "update" | "cancel" | "restart" | "remove";

/** A failed action in words: the gateway's own message where it is clear (it names versions), else ours. */
export function engineActionError(action: EngineAction, error: ApiError): string {
  switch (error.error) {
    case "engine_job_running":
      return JOB_RUNNING;
    case "app_job_running":
      return APP_JOB_RUNNING;
    case "image_current":
      return "The engine runs this image. Use another version first.";
    case "not_found":
      return action === "remove" ? "This image is no longer on the AI server." : error.message;
    case "timeout":
      return action === "update"
        ? "The workspace service did not answer in time. The job may have started anyway: this page shows it if so."
        : error.message;
    default:
      return error.message;
  }
}
