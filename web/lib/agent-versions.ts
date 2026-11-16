// What the Agents page (admin console) decides, kept out of its components: the version summaries, which actions
// are allowed right now and why not, the job's labels and timings, how often to poll, and the gateway's errors in
// plain words. Pure; unit tested. The gateway's view of versions: docs/ARCHITECTURE.md, "Agent versions and updates".
import type {
  AdminAgents,
  AgentUpdateJob,
  AgentVersionInfo,
  ApiError,
  InstalledImage,
  UpdatePhase,
} from "./gateway-types.ts";

/** Poll intervals: a running job's log and step move every few seconds; otherwise little changes. */
export const ACTIVE_POLL_MS = 1_000;
export const IDLE_POLL_MS = 15_000;

/** Still building or verifying: it holds the one job slot, and it can be cancelled. */
export function isJobActive(job: Pick<AgentUpdateJob, "phase"> | null): boolean {
  return job?.phase === "building" || job?.phase === "verifying";
}

export function pollDelay(job: AgentUpdateJob | null): number {
  return isJobActive(job) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
}

/** A poll's answer; when the gateway can't be reached, the last versions stay on screen with the error. */
export function mergeAgents(current: AdminAgents, next: AdminAgents): AdminAgents {
  return { versions: next.versions ?? current.versions, error: next.error };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ---- Versions ------------------------------------------------------------------------------------------------

export interface VersionStatus {
  tone: "success" | "warning" | "neutral";
  label: string;
}

/** The badge beside the current version. */
export function versionStatus(agent: Pick<AgentVersionInfo, "current" | "latest" | "updateAvailable">): VersionStatus {
  if (agent.latest === null) return { tone: "neutral", label: "Latest unknown" };
  if (agent.updateAvailable) return { tone: "warning", label: `Update available: ${agent.latest}` };
  if (agent.latest === agent.current) return { tone: "success", label: "Up to date" };
  // Ahead of latest (a version from the next channel, say), or not comparable: say what latest is.
  return { tone: "neutral", label: `Latest: ${agent.latest}` };
}

export interface AgentStatus {
  label: string;
  variant: "success" | "warning" | "info" | "secondary";
  /** A job runs for this agent: the badge shows a spinner. */
  pending: boolean;
}

/** The badge beside the agent's title on the Updates page; "Update to X.Y.Z" beside the version names the release. */
export function agentStatus(
  agent: Pick<AgentVersionInfo, "id" | "current" | "latest" | "updateAvailable">,
  job: Pick<AgentUpdateJob, "agent" | "phase"> | null,
): AgentStatus {
  if (job && isJobActive(job) && job.agent === agent.id) return { label: "Updating…", variant: "info", pending: true };
  const status = versionStatus(agent);
  if (status.tone === "warning") return { label: "Update available", variant: "warning", pending: false };
  return { label: status.label, variant: status.tone === "neutral" ? "secondary" : status.tone, pending: false };
}

/** Said when the admin console (or update-image.sh) moved the agent off the version .env names. */
export function defaultVersionNote(agent: Pick<AgentVersionInfo, "current" | "defaultVersion">): string | null {
  return agent.current === agent.defaultVersion ? null : `The .env default is ${agent.defaultVersion}.`;
}

/** The release channels a version is on ("latest", "next"…). */
export function channelTags(agent: Pick<AgentVersionInfo, "channels">, version: string): string[] {
  return agent.channels.filter((channel) => channel.version === version).map((channel) => channel.tag);
}

/**
 * Which versions the agent's running workspaces use, in a sentence: "2 workspaces running.", "1 workspace still
 * runs 0.27.0 until it restarts.", "3 workspaces running: 2 on this version, 1 still on 0.27.0 until it restarts."
 * null when none runs.
 */
export function runningSummary(agent: Pick<AgentVersionInfo, "current" | "running">): string | null {
  const groups = agent.running.filter((group) => group.count > 0);
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  if (total === 0) return null;
  const restarts = (count: number) => (count === 1 ? "until it restarts" : "until they restart");

  if (groups.length === 1) {
    const [{ version, count }] = groups as [(typeof groups)[number]];
    if (version === agent.current) return `${plural(count, "workspace")} running.`;
    if (version === null) return `${plural(count, "workspace")} running, on an unknown version.`;
    return `${plural(count, "workspace")} still ${count === 1 ? "runs" : "run"} ${version} ${restarts(count)}.`;
  }
  const parts = groups.map(({ version, count }) => {
    if (version === agent.current) return `${count} on this version`;
    if (version === null) return `${count} on an unknown version`;
    return `${count} still on ${version} ${restarts(count)}`;
  });
  return `${plural(total, "workspace")} running: ${parts.join(", ")}.`;
}

/** The current version has no image on the server: new workspaces of this agent can't start until it is built. */
export function currentImageMissing(agent: Pick<AgentVersionInfo, "installed">): boolean {
  return !agent.installed.some((image) => image.current);
}

/**
 * What making `version` current takes on the gateway, which uses an image already on this server unless it is
 * to be built from scratch (gateway/src/agent-updater.ts):
 *   - "none": the current version, whose image is here: nothing would change.
 *   - "switch": another version whose image is on this server. Nothing is built and the npm registry isn't
 *     asked: the image is checked and becomes current, in seconds.
 *   - "rebuild": an image on this server built again from scratch, without the build cache.
 *   - "build": a version with no image here (the current one included, when its image is missing), from scratch
 *     too when `fromScratch` is set.
 * Every build takes minutes and loads the server's CPU; from scratch takes longer.
 */
export type UpdateWork = "none" | "switch" | "rebuild" | "build";

export function updateWork(
  agent: Pick<AgentVersionInfo, "current" | "installed">,
  version: string,
  fromScratch: boolean,
): UpdateWork {
  if (!agent.installed.some((image) => image.version === version)) return "build";
  if (fromScratch) return "rebuild";
  return version === agent.current ? "none" : "switch";
}

// ---- What may run now ----------------------------------------------------------------------------------------

/** What every action depends on: the job (one at a time, for all agents) and whether the gateway answers. */
export interface ActionContext {
  job: AgentUpdateJob | null;
  /** The last poll failed: what is shown may be out of date and actions would fail. */
  offline: boolean;
}

const OFFLINE = "The workspace service is unavailable right now.";

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
  if (image.current) return "New workspaces start from this image. Switch to another version first.";
  if (image.inUse > 0) {
    return `${plural(image.inUse, "running workspace uses", "running workspaces use")} it. It can be removed once ${image.inUse === 1 ? "that workspace has" : "they have"} stopped.`;
  }
  if (context.job?.agent === agent.id && isJobActive(context.job)) return `Wait until the update of ${agent.name} has finished.`;
  return null;
}

// ---- The job ---------------------------------------------------------------------------------------------------

const PHASE_LABELS: Record<UpdatePhase, string> = {
  building: "Building the image",
  verifying: "Checking the version",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function phaseLabel(phase: UpdatePhase): string {
  return PHASE_LABELS[phase];
}

/**
 * Where a running job is, for its Progress bar (halfway through the current step): a build, then the version check;
 * a switch to an image on the server only checks.
 */
export function agentJobStep(job: Pick<AgentUpdateJob, "phase" | "reuse">): { index: number; count: number; progress: number } {
  const phases: UpdatePhase[] = job.reuse ? ["verifying"] : ["building", "verifying"];
  const found = phases.indexOf(job.phase);
  const index = found === -1 ? phases.length : found + 1;
  return { index, count: phases.length, progress: isJobActive(job) ? Math.round(((index - 0.5) / phases.length) * 100) : 100 };
}

/**
 * What a job does, from what the gateway reports of it:
 *   - "update": another version becomes current (built, from scratch or not, or its image on the server checked);
 *   - "rebuild": the current version built again from scratch (`rebuild`), replacing its image;
 *   - "build": the current version built with the cache, which the gateway does only when its image is missing;
 *   - "check": the current version's image on the server checked and kept, nothing built (the dialogs don't offer
 *     it, the control API takes it).
 */
export type JobKind = "update" | "rebuild" | "build" | "check";

export function jobKind(job: Pick<AgentUpdateJob, "fromVersion" | "version" | "rebuild" | "reuse">): JobKind {
  if (job.fromVersion !== job.version) return "update";
  if (job.rebuild) return "rebuild";
  return job.reuse ? "check" : "build";
}

type JobTitleFields = Pick<AgentUpdateJob, "phase" | "fromVersion" | "version" | "rebuild" | "reuse">;

/** How a job on the current version is named: while it runs, once it succeeded, and as a noun. */
const SAME_VERSION_WORDS: Record<Exclude<JobKind, "update">, { running: string; done: string; noun: string }> = {
  rebuild: { running: "Rebuilding", done: "rebuilt", noun: "Rebuild" },
  build: { running: "Building", done: "built", noun: "Build" },
  check: { running: "Checking", done: "checked", noun: "Check" },
};

/**
 * The job in a few words, by phase: "Updating DeepSeek Harness 0.2.2-rc.1 → 0.2.2-rc.3", "Qwen Code updated to
 * 0.27.4", "Update of Qwen Code to 0.27.4 failed"; for the current version, "Rebuilding Qwen Code 0.27.0" (from
 * scratch), "Building …" (its image was missing) or "Checking …" (jobKind). Whether a version change is from
 * scratch is said beside the title.
 */
export function jobTitle(job: JobTitleFields, name: string): string {
  const kind = jobKind(job);
  if (kind === "update") {
    switch (job.phase) {
      case "building":
      case "verifying":
        return `Updating ${name} ${job.fromVersion} → ${job.version}`;
      case "succeeded":
        return `${name} updated to ${job.version}`;
      case "failed":
        return `Update of ${name} to ${job.version} failed`;
      case "cancelled":
        return `Update of ${name} to ${job.version} cancelled`;
    }
  }
  const words = SAME_VERSION_WORDS[kind];
  const subject = `${name} ${job.version}`;
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
      ? `Nothing changed: the ${job.version} image is still missing, so new workspaces can't start.`
      : `Nothing changed: new workspaces still start with ${job.fromVersion}.`;
  }
  if (kind === "check") return `Nothing changed: the image on this server reports ${job.version}, and new workspaces still start with it.`;
  const rebuilt = kind === "rebuild";
  // Running containers started before the job ended keep their image; after a rebuild that is the same version.
  const older = (agent?.running ?? [])
    .filter((group) => rebuilt || group.version !== job.version)
    .reduce((sum, group) => sum + group.count, 0);
  const now = rebuilt
    ? `New ${name} workspaces start from the rebuilt image.`
    : kind === "build"
      ? `New ${name} workspaces can start again, with ${job.version}.`
      : `New ${name} workspaces start with ${job.version}.`;
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
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

// ---- Errors ----------------------------------------------------------------------------------------------------

export type AgentAction = "update" | "cancel" | "remove";

export interface AgentActionError {
  message: string;
  /** The problem is the version asked for: shown at the version field when there is one. */
  field?: "version";
}

/** A failed action in words: the gateway's own message where it is clear (it names versions), else ours. */
export function agentActionError(action: AgentAction, error: ApiError): AgentActionError {
  switch (error.error) {
    case "invalid_version":
    case "version_not_found":
      return action === "update" ? { message: error.message, field: "version" } : { message: error.message };
    case "registry_unreachable":
      return { message: `${error.message} Nothing was started; try again in a minute.` };
    case "image_in_use":
      return { message: "A workspace still uses this image. It can be removed once that workspace has stopped." };
    case "not_found":
      return { message: action === "remove" ? "This image is no longer on the server." : error.message };
    case "timeout":
      return action === "update"
        ? { message: "The workspace service did not answer in time. The update may have started anyway: this page shows it if so." }
        : { message: error.message };
    default:
      return { message: error.message };
  }
}
