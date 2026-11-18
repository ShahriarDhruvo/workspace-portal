// What the Updates page decides about the agents (docs/ARCHITECTURE.md, "Agent versions and updates").
import type { AgentUpdateJob, AgentVersionInfo, ApiError, InstalledImage, ReleaseNotes, UpdatePhase } from "@portal/core/wire";
import { isJobActive, jobStep, OFFLINE, type CardStatus, type JobStep } from "./update-jobs.ts";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The badge beside the agent's title on the Updates page; "Update to X.Y.Z" beside the version names the release. */
export function agentStatus(
  agent: Pick<AgentVersionInfo, "id" | "current" | "latest" | "updateAvailable">,
  job: Pick<AgentUpdateJob, "agent" | "finishedAt"> | null,
): CardStatus {
  if (job && isJobActive(job) && job.agent === agent.id) return { label: "Updating…", variant: "info", pending: true };
  if (agent.latest === null) return { label: "Latest unknown", variant: "secondary", pending: false };
  if (agent.updateAvailable) return { label: "Update available", variant: "warning", pending: false };
  if (agent.latest === agent.current) return { label: "Up to date", variant: "success", pending: false };
  // Ahead of latest (a prerelease the admin built), or not comparable: say what latest is.
  return { label: `Latest: ${agent.latest}`, variant: "secondary", pending: false };
}

/** The current version has no image on the server: new workspaces of this agent can't start until it is built. */
export function currentImageMissing(agent: Pick<AgentVersionInfo, "installed">): boolean {
  return !agent.installed.some((image) => image.current);
}

/**
 * What making `version` current takes on the gateway: "none" (it is current and its image is here), "switch" (its
 * image is here: checked and made current in seconds) or "build" (no image here: minutes, and the server's CPU).
 */
export type UpdateWork = "none" | "switch" | "build";

export function updateWork(agent: Pick<AgentVersionInfo, "current" | "installed">, version: string): UpdateWork {
  if (!agent.installed.some((image) => image.version === version)) return "build";
  return version === agent.current ? "none" : "switch";
}

/** One row of an agent's Package images table. */
export interface AgentPackageRow {
  version: string;
  /** Epoch ms npm published it; null when unknown. */
  publishedAt: number | null;
  /** New workspaces start with it. */
  current: boolean;
  latest: boolean;
  notes: ReleaseNotes | null;
  /** Its image on this server; null: it is built first. */
  image: InstalledImage | null;
  /**
   * The row's action: "use" its image (a switch, in seconds), "build" it (then it is current; for the current
   * version, its missing image), or "rebuild" the current one from scratch.
   */
  action: "use" | "build" | "rebuild";
}

/** The gateway's releases (newest first: the newest stable ones, the current one, those with an image here) as rows. */
export function agentPackageRows(agent: Pick<AgentVersionInfo, "current" | "releases" | "installed">): AgentPackageRow[] {
  const images = new Map(agent.installed.map((image) => [image.version, image]));
  return agent.releases.map(({ version, publishedAt, latest, notes }) => {
    const image = images.get(version) ?? null;
    const current = version === agent.current;
    return { version, publishedAt, current, latest, notes, image, action: current ? (image ? "rebuild" : "build") : image ? "use" : "build" };
  });
}

/** "6 versions · 2 on this server": the section's summary while it is folded. */
export function packageSummary(rows: ReadonlyArray<{ image: unknown }>, where: string): string {
  const local = rows.filter((row) => row.image !== null).length;
  return `${plural(rows.length, "version")} · ${local} on ${where}`;
}

/** What every action depends on: the job (one at a time, for all agents) and whether the gateway answers. */
export interface ActionContext {
  job: AgentUpdateJob | null;
  /** The last poll failed: what is shown may be out of date and actions would fail. */
  offline: boolean;
}

/** Why no update can start right now (any agent, any version), or null when one can. */
export function updateBlocker(context: ActionContext): string | null {
  if (context.offline) return OFFLINE;
  if (isJobActive(context.job)) return "An update is running. Wait for it to finish, or cancel it.";
  return null;
}

/** Why this image can't be removed right now, or null when it can. The gateway enforces the same rules. */
export function removeBlocker(
  context: ActionContext,
  agent: Pick<AgentVersionInfo, "id" | "name">,
  image: Pick<InstalledImage, "current" | "inUse">,
): string | null {
  if (context.offline) return OFFLINE;
  if (image.current) return "New workspaces start from this image. Use another version first.";
  if (image.inUse > 0) {
    return `${plural(image.inUse, "running workspace uses", "running workspaces use")} it. It can be removed once ${image.inUse === 1 ? "that workspace has" : "they have"} stopped.`;
  }
  if (context.job?.agent === agent.id && isJobActive(context.job)) return `Wait until the update of ${agent.name} has finished.`;
  return null;
}

/** What a running job is doing. */
export function phaseLabel(phase: UpdatePhase): string {
  return phase === "building" ? "Building the image" : "Checking the version";
}

/** A build, then the version check; a switch to an image on the server only checks. */
export function agentJobStep(job: Pick<AgentUpdateJob, "phase" | "reuse" | "finishedAt">): JobStep {
  return jobStep(job.reuse ? ["verifying"] : ["building", "verifying"], job);
}

/**
 * What a job does: "update" makes another version current; "rebuild" builds the current one from scratch; "build"
 * builds it with the cache (the gateway does that only when its image is missing); "check" only checks its image
 * (the dialogs don't offer it, the control API takes it).
 */
export type JobKind = "update" | "rebuild" | "build" | "check";

export function jobKind(job: Pick<AgentUpdateJob, "fromVersion" | "toVersion" | "rebuild" | "reuse">): JobKind {
  if (job.fromVersion !== job.toVersion) return "update";
  if (job.rebuild) return "rebuild";
  return job.reuse ? "check" : "build";
}

type JobTitleFields = Pick<AgentUpdateJob, "phase" | "fromVersion" | "toVersion" | "rebuild" | "reuse">;

/** How a job on the current version is named: while it runs, once it succeeded, and as a noun. */
const SAME_VERSION_WORDS: Record<Exclude<JobKind, "update">, { running: string; done: string; noun: string }> = {
  rebuild: { running: "Rebuilding", done: "rebuilt", noun: "Rebuild" },
  build: { running: "Building", done: "built", noun: "Build" },
  check: { running: "Checking", done: "checked", noun: "Check" },
};

/**
 * The job in a few words, by phase: "Updating DeepSeek Harness 0.2.2-rc.1 → 0.2.2-rc.3", "Qwen Code updated to
 * 0.27.4", "Update of Qwen Code to 0.27.4 failed"; "Rebuilding…", "Building…" or "Checking…" for the current version.
 */
export function jobTitle(job: JobTitleFields, name: string): string {
  const kind = jobKind(job);
  if (kind === "update") {
    switch (job.phase) {
      case "building":
      case "verifying":
        return `Updating ${name} ${job.fromVersion} → ${job.toVersion}`;
      case "succeeded":
        return `${name} updated to ${job.toVersion}`;
      case "failed":
        return `Update of ${name} to ${job.toVersion} failed`;
      case "cancelled":
        return `Update of ${name} to ${job.toVersion} cancelled`;
    }
  }
  const words = SAME_VERSION_WORDS[kind];
  const subject = `${name} ${job.toVersion}`;
  switch (job.phase) {
    case "building":
    case "verifying":
      return `${words.running} ${subject}`;
    case "succeeded":
      return `${subject} ${words.done}`;
    case "failed":
      return `${words.noun} of ${subject} failed`;
    case "cancelled":
      return `${words.noun} of ${subject} cancelled`;
  }
}

/**
 * What a finished job means for workspaces. Succeeded: new workspaces start with the new version (or the rebuilt
 * image), running ones keep theirs until they restart (`agent` is the overview after the job). Failed or cancelled:
 * nothing changed.
 */
export function jobOutcome(job: JobTitleFields, agent: Pick<AgentVersionInfo, "name" | "running"> | null): string {
  const name = agent?.name ?? "the agent";
  const kind = jobKind(job);
  if (job.phase !== "succeeded") {
    return kind === "build"
      ? `Nothing changed: the ${job.toVersion} image is still missing, so new workspaces can't start.`
      : `Nothing changed: new workspaces still start with ${job.fromVersion}.`;
  }
  if (kind === "check") return `Nothing changed: the image on this server reports ${job.toVersion}, and new workspaces still start with it.`;
  const rebuilt = kind === "rebuild";
  // Running containers started before the job ended keep their image; after a rebuild that is the same version.
  const older = (agent?.running ?? [])
    .filter((group) => rebuilt || group.version !== job.toVersion)
    .reduce((sum, group) => sum + group.count, 0);
  const now = rebuilt
    ? `New ${name} workspaces start from the rebuilt image.`
    : kind === "build"
      ? `New ${name} workspaces can start again, with ${job.toVersion}.`
      : `New ${name} workspaces start with ${job.toVersion}.`;
  if (older === 0) return now;
  const what = rebuilt ? "the previous build" : older === 1 ? "its version" : "their version";
  const until = older === 1 ? "until it restarts" : "until they restart";
  return `${now} ${plural(older, "running workspace")} ${older === 1 ? "keeps" : "keep"} ${what} ${until}.`;
}

/** Wall-clock time the job ran (so far). */
export function jobElapsedMs(job: Pick<AgentUpdateJob, "startedAt" | "finishedAt">, now: number): number {
  return Math.max(0, (job.finishedAt ?? now) - job.startedAt);
}

/** A stopwatch: "0:07", "12:30", "1:02:03". */
export function formatStopwatch(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export type AgentAction = "update" | "cancel" | "remove";

/** A failed action in words: the gateway's own message where it is clear (it names versions), else ours. */
export function agentActionError(action: AgentAction, error: ApiError): string {
  switch (error.error) {
    case "registry_unreachable":
      return `${error.message} Nothing was started; try again in a minute.`;
    case "image_in_use":
      return "A workspace still uses this image. It can be removed once that workspace has stopped.";
    case "not_found":
      return action === "remove" ? "This image is no longer on the server." : error.message;
    case "timeout":
      return action === "update"
        ? "The workspace service did not answer in time. The update may have started anyway: this page shows it if so."
        : error.message;
    default:
      return error.message;
  }
}
