// What the admin console shows per agent (GET /control/agents/versions): the current and default
// versions, what the registry offers, the images Docker has, and which versions running workspaces
// use. Pure: the updater gathers the inputs.
import type { AgentKind } from "@portal/db";
import { driverFor } from "./agents/index.ts";
import type { WorkspaceImageSummary } from "./image-builder.ts";
import { releaseChannels, type ReleaseChannel } from "./release-channels.ts";
import type { AgentUpdateJob } from "./update-job.ts";
import { byNewestVersion, isNewerVersion, isVersion } from "./versions.ts";
import type { WorkspaceInfo } from "./workspaces.ts";

export interface InstalledImage {
  version: string;
  image: string;
  sizeBytes: number;
  /** Epoch ms. */
  createdAt: number;
  current: boolean;
  /** Workspace containers (starting or running) using it. */
  inUse: number;
}

export interface AgentVersionInfo {
  id: AgentKind;
  name: string;
  packageName: string;
  /** New workspaces start with this version. */
  current: string;
  /** From .env. */
  defaultVersion: string;
  /** dist-tags.latest; null when unknown. */
  latest: string | null;
  /** latest is newer than current (semver precedence, prereleases included). */
  updateAvailable: boolean;
  /** "latest" first, then next, preview, beta, rc, alpha, nightly when present; [] when unknown. */
  channels: ReleaseChannel[];
  /** This agent's workspace images in Docker, newest version first. */
  installed: InstalledImage[];
  /** Starting and running workspaces by image version (null: unknown), newest first. */
  running: Array<{ version: string | null; count: number }>;
}

export interface AgentVersionsOverview {
  /** The enabled agents, in WORKSPACE_AGENTS order. */
  agents: AgentVersionInfo[];
  /** The running job, else the last finished one since the gateway started. */
  job: AgentUpdateJob | null;
  /** The last registry check failed: channels and latest are unknown or stale. */
  registryError: string | null;
  /** Epoch ms of the last successful registry check. */
  checkedAt: number | null;
}

export interface AgentVersionInputs {
  kind: AgentKind;
  current: string;
  defaultVersion: string;
  /** The package's dist-tags; undefined when the registry was never reached. */
  distTags: Readonly<Record<string, string>> | undefined;
  /** Every workspace image Docker has (any agent). */
  images: readonly WorkspaceImageSummary[];
  workspaces: ReadonlyArray<Pick<WorkspaceInfo, "status" | "agent" | "agentVersion">>;
}

export function describeAgentVersions(input: AgentVersionInputs): AgentVersionInfo {
  const { kind, current } = input;
  const driver = driverFor(kind);
  const latest = isVersion(input.distTags?.latest) ? input.distTags.latest : null;

  const versionsInUse = input.workspaces
    .filter((workspace) => workspace.agent === kind && (workspace.status === "starting" || workspace.status === "running"))
    .map((workspace) => workspace.agentVersion);
  const counts = new Map<string | null, number>();
  for (const version of versionsInUse) counts.set(version, (counts.get(version) ?? 0) + 1);

  const seen = new Set<string>();
  const installed = input.images
    .filter((image) => image.kind === kind && !seen.has(image.version) && seen.add(image.version))
    .sort((a, b) => byNewestVersion(a.version, b.version))
    .map((image) => ({
      version: image.version,
      image: image.image,
      sizeBytes: image.sizeBytes,
      createdAt: image.createdAt,
      current: image.version === current,
      inUse: counts.get(image.version) ?? 0,
    }));

  const running = [...counts]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : byNewestVersion(a, b)))
    .map(([version, count]) => ({ version, count }));

  return {
    id: kind,
    name: driver.name,
    packageName: driver.release.packageName,
    current,
    defaultVersion: input.defaultVersion,
    latest,
    updateAvailable: latest !== null && isNewerVersion(latest, current),
    channels: input.distTags ? releaseChannels(input.distTags) : [],
    installed,
    running,
  };
}
