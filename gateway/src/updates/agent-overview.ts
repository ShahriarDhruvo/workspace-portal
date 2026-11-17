// What the admin console shows per agent (GET /control/agents/versions): the current and default versions, the
// releases it offers (the Package images table), the images Docker has, and which versions running workspaces use.
// Pure: the updater gathers the inputs.
import {
  byNewestVersion,
  compareVersions,
  isNewerVersion,
  isStableVersion,
  isVersion,
  type AgentKind,
  type AgentRelease,
  type AgentVersionInfo,
  type WorkspaceInfo,
} from "@portal/core";
import { driverFor } from "../agents/index.ts";
import type { WorkspaceImageSummary } from "../docker/image-builder.ts";
import type { PackageReleases } from "./release-cache.ts";

/** How many of the newest stable releases the Updates page offers to build. */
export const RELEASES_OFFERED = 5;

export interface AgentVersionInputs {
  kind: AgentKind;
  current: string;
  defaultVersion: string;
  /** The package's releases; undefined when the registry was never reached. */
  releases: PackageReleases | undefined;
  /** Every workspace image Docker has (any agent). */
  images: readonly WorkspaceImageSummary[];
  workspaces: ReadonlyArray<Pick<WorkspaceInfo, "status" | "agent" | "agentVersion">>;
}

/**
 * The versions an agent's Package images table lists, newest first: the RELEASES_OFFERED newest stable releases,
 * plus every version in `keep` (the current one, those with an image on this server) whatever it is. Stable means a
 * release that is no prerelease and not deprecated, and no newer than dist-tags.latest: a release published but not
 * (yet) made latest is no stable one. Latest itself counts even when it is a prerelease, since that is what the
 * publisher calls its stable version (DeepSeek Harness's latest is 0.2.2-rc.1). Such a publisher (DeepSeek Harness
 * publishes release candidates only) has fewer stable releases than that, so its list is filled up with the newest
 * prerelease of latest's kind ("rc") of each earlier version line (0.2.1-rc.5, 0.2.0-rc.2, ...), and its card offers
 * earlier versions like the others. Without registry answers, only `keep`.
 */
export function offeredReleases(releases: PackageReleases | undefined, keep: readonly string[]): AgentRelease[] {
  const latest = isVersion(releases?.distTags.latest) ? releases.distTags.latest : null;
  const published = new Map((releases?.versions ?? []).map((entry) => [entry.version, entry]));
  const notNewer = (version: string) => latest === null || (compareVersions(version, latest) ?? 1) <= 0;
  const stable = [...published.values()]
    .filter(({ version, deprecated }) => version === latest || (!deprecated && isStableVersion(version) && notNewer(version)))
    .map((entry) => entry.version)
    .sort(byNewestVersion)
    .slice(0, RELEASES_OFFERED);
  // Only for a publisher whose latest is itself a prerelease, and only with prereleases of latest's kind ("rc"), so
  // a package with a few releases is never filled up with its nightlies or previews.
  const channel = latest === null ? null : prereleaseChannel(latest);
  if (channel !== null && stable.length < RELEASES_OFFERED) {
    const lines = new Set(stable.map(versionLine));
    const earlier = [...published.values()]
      .filter(({ version, deprecated }) => !deprecated && prereleaseChannel(version) === channel && notNewer(version) && !lines.has(versionLine(version)))
      .map((entry) => entry.version)
      .sort(byNewestVersion);
    for (const version of earlier) {
      if (stable.length >= RELEASES_OFFERED) break;
      if (lines.has(versionLine(version))) continue;
      lines.add(versionLine(version));
      stable.push(version);
    }
  }
  return [...new Set([...stable, ...keep])].sort(byNewestVersion).map((version) => ({
    version,
    publishedAt: published.get(version)?.publishedAt ?? null,
    latest: version === latest,
    notes: releases?.notes.get(version) ?? null,
  }));
}

/** A prerelease's first identifier ("0.2.1-rc.5" → "rc"); null for a release or anything else. */
function prereleaseChannel(version: string): string | null {
  return isVersion(version) ? (/^\d+\.\d+\.\d+-([0-9A-Za-z]+)/.exec(version)?.[1] ?? null) : null;
}

/** A version's line: "0.2.1-rc.5" → "0.2.1". */
function versionLine(version: string): string {
  return version.replace(/[-+].*$/, "");
}

export function describeAgentVersions(input: AgentVersionInputs): AgentVersionInfo {
  const { kind, current } = input;
  const driver = driverFor(kind);
  const latest = isVersion(input.releases?.distTags.latest) ? input.releases.distTags.latest : null;

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
    releases: offeredReleases(input.releases, [current, ...installed.map((image) => image.version)]),
    installed,
    running,
  };
}
