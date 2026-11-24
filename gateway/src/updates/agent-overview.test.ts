import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAgentVersions, offeredReleases, type AgentVersionInputs, type PackageReleases } from "./agent-overview.ts";
import type { ReleaseNotes } from "@portal/core";
import type { WorkspaceImageSummary } from "../docker/image-builder.ts";
import { workspaceImage } from "../docker/image-names.ts";

const image = (kind: "qwen" | "dsh", version: string, createdAt = 1_000): WorkspaceImageSummary => ({
  image: workspaceImage(kind, version),
  kind,
  version,
  id: `sha256:${kind}${version}`,
  sizeBytes: 2_000_000_000,
  createdAt,
});

const DAY = 86_400_000;

/** A package's releases: each version published a day after the one before, in the order given. */
function releases(distTags: Record<string, string>, versions: Array<string | { version: string; deprecated: true }>, notes: Record<string, ReleaseNotes> = {}): PackageReleases {
  return {
    distTags,
    versions: versions.map((entry, index) =>
      typeof entry === "string" ? { version: entry, publishedAt: index * DAY, deprecated: false } : { ...entry, publishedAt: index * DAY },
    ),
    notes: new Map(Object.entries(notes)),
  };
}

const DSH_TAGS = { alpha: "0.2.2-alpha.3", latest: "0.2.2-rc.1", next: "0.2.2-rc.3", experiment: "0.0.1-x" };

const base: AgentVersionInputs = {
  kind: "dsh",
  current: "0.2.2-rc.1",
  defaultVersion: "0.2.2-rc.1",
  releases: releases(DSH_TAGS, ["0.2.1", "0.2.2-alpha.3", "0.2.2-rc.1", "0.2.2-rc.3"]),
  images: [image("dsh", "0.2.2-rc.1"), image("qwen", "0.27.4"), image("dsh", "0.2.2-rc.3"), image("dsh", "0.2.1")],
  workspaces: [],
};

test("an agent's versions: current, default, releases, images newest first, running workspaces", () => {
  const info = describeAgentVersions({
    ...base,
    workspaces: [
      { status: "running", agent: "dsh", agentVersion: "0.2.2-rc.1" },
      { status: "starting", agent: "dsh", agentVersion: "0.2.2-rc.1" },
      { status: "running", agent: "dsh", agentVersion: null },
      { status: "running", agent: "dsh", agentVersion: "0.2.1" },
      { status: "running", agent: "qwen", agentVersion: "0.27.4" },
      { status: "stopped", agent: "dsh", agentVersion: null },
      { status: "stopping", agent: "dsh", agentVersion: "0.2.2-rc.3" },
    ],
  });
  assert.deepEqual(info, {
    id: "dsh",
    name: "DeepSeek Harness",
    packageName: "@deepseek-ai/dsh",
    current: "0.2.2-rc.1",
    defaultVersion: "0.2.2-rc.1",
    latest: "0.2.2-rc.1",
    updateAvailable: false,
    releases: [
      { version: "0.2.2-rc.3", publishedAt: 3 * DAY, latest: false, notes: null },
      { version: "0.2.2-rc.1", publishedAt: 2 * DAY, latest: true, notes: null },
      { version: "0.2.1", publishedAt: 0, latest: false, notes: null },
    ],
    installed: [
      { version: "0.2.2-rc.3", image: "workspace-portal/workspace:dsh-0.2.2-rc.3", sizeBytes: 2_000_000_000, createdAt: 1_000, current: false, inUse: 0 },
      { version: "0.2.2-rc.1", image: "workspace-portal/workspace:dsh-0.2.2-rc.1", sizeBytes: 2_000_000_000, createdAt: 1_000, current: true, inUse: 2 },
      { version: "0.2.1", image: "workspace-portal/workspace:dsh-0.2.1", sizeBytes: 2_000_000_000, createdAt: 1_000, current: false, inUse: 1 },
    ],
    running: [
      { version: "0.2.2-rc.1", count: 2 },
      { version: "0.2.1", count: 1 },
      { version: null, count: 1 },
    ],
  });
});

test("updateAvailable means a newer latest, by semver precedence", () => {
  const at = (current: string, latest: string | undefined): boolean =>
    describeAgentVersions({ ...base, current, releases: releases(latest === undefined ? {} : { latest }, []) }).updateAvailable;
  assert.equal(at("0.2.2-rc.1", "0.2.2"), true);
  assert.equal(at("0.2.2-rc.3", "0.2.2-rc.1"), false, "ahead of latest (a newer prerelease)");
  assert.equal(at("0.2.2-rc.1", "0.2.2-rc.1"), false);
  assert.equal(at("0.2.2-rc.1", undefined), false);
});

test("without registry answers latest is unknown, and the table has the current version and the images", () => {
  const info = describeAgentVersions({ ...base, kind: "qwen", current: "0.27.4", defaultVersion: "0.27.0", releases: undefined, images: [image("qwen", "0.26.0"), image("qwen", "0.27.4")] });
  assert.deepEqual([info.latest, info.updateAvailable], [null, false]);
  assert.equal(info.packageName, "@qwen-code/qwen-code");
  assert.deepEqual(info.installed.map((i) => [i.version, i.current]), [["0.27.4", true], ["0.26.0", false]]);
  assert.deepEqual(info.releases, [
    { version: "0.27.4", publishedAt: null, latest: false, notes: null },
    { version: "0.26.0", publishedAt: null, latest: false, notes: null },
  ]);
  assert.equal(describeAgentVersions({ ...base, releases: releases({ latest: "garbage" }, []) }).latest, null, "an unusable latest is unknown");
});

const versionsOf = (list: ReturnType<typeof offeredReleases>) => list.map((release) => release.version);

test("offered: the 5 newest stable releases, no prerelease, nothing deprecated, nothing newer than latest", () => {
  const qwen = releases({ latest: "0.27.4", preview: "0.27.2-preview.0", nightly: "0.27.3-nightly.20261115.6e3b2dcc19", next: "0.28.0" }, [
    "0.26.0",
    "0.26.9",
    "0.27.0",
    "0.27.1",
    "0.27.2-preview.0",
    "0.27.2",
    "0.27.3-nightly.20261115.6e3b2dcc19",
    { version: "0.27.3", deprecated: true },
    "0.27.4",
    "1.0.0-preview.1",
    "0.28.0",
  ]);
  assert.deepEqual(versionsOf(offeredReleases(qwen, [])), ["0.27.4", "0.27.2", "0.27.1", "0.27.0", "0.26.9"]);
  assert.deepEqual(
    versionsOf(offeredReleases(qwen, ["0.26.0", "0.27.3-nightly.20261115.6e3b2dcc19", "0.27.4"])),
    ["0.27.4", "0.27.3-nightly.20261115.6e3b2dcc19", "0.27.2", "0.27.1", "0.27.0", "0.26.9", "0.26.0"],
    "plus the current version and the images on the server, whatever they are, once each",
  );
  const [latest] = offeredReleases(qwen, []);
  assert.deepEqual(latest, { version: "0.27.4", publishedAt: 8 * DAY, latest: true, notes: null });
});

test("offered: a package with other dist-tags on snapshot builds and a placeholder release (OpenCode) offers its stable releases", () => {
  // As the registry reader leaves it: the snapshot builds are no versions, their dist-tags remain.
  const opencode = releases({ reserved: "0.0.0-reserved", beta: "0.0.0-beta-19507", latest: "2.4.1", dev: "0.0.0-dev-1344" }, [
    "0.0.0-reserved",
    "2.2.0",
    "2.3.0",
    "2.3.1",
    "2.3.2",
    "2.4.0",
    "2.4.1",
  ]);
  assert.deepEqual(versionsOf(offeredReleases(opencode, [])), ["2.4.1", "2.4.0", "2.3.2", "2.3.1", "2.3.0"]);
  assert.deepEqual(versionsOf(offeredReleases(opencode, ["2.2.0"])), ["2.4.1", "2.4.0", "2.3.2", "2.3.1", "2.3.0", "2.2.0"]);
});

test("offered: a latest that is a prerelease is the stable one (DeepSeek Harness), filled up with earlier lines' newest", () => {
  const notes: ReleaseNotes = { title: "dsh v0.2.2-rc.1", url: "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1", publishedAt: 2 * DAY, body: "", breaking: false };
  const dsh = releases(DSH_TAGS, ["0.2.1-rc.5", "0.2.2-alpha.3", "0.2.2-rc.1", "0.2.2-rc.2", "0.2.2-rc.3"], { "0.2.2-rc.1": notes });
  assert.deepEqual(offeredReleases(dsh, [])[0], { version: "0.2.2-rc.1", publishedAt: 2 * DAY, latest: true, notes });
  assert.deepEqual(versionsOf(offeredReleases(dsh, [])), ["0.2.2-rc.1", "0.2.1-rc.5"], "0.2.2's other prereleases: its line is latest's");
  assert.deepEqual(versionsOf(offeredReleases(dsh, ["0.2.1-rc.5"])), ["0.2.2-rc.1", "0.2.1-rc.5"]);
  const many = releases({ latest: "0.2.2-rc.1", next: "0.2.2-rc.3" }, [
    "0.1.5-rc.2",
    "0.1.5-rc.3",
    "0.1.6-rc.1",
    { version: "0.1.7-rc.2", deprecated: true },
    "0.1.7-rc.1",
    "0.2.0-rc.2",
    "0.2.1-rc.4",
    "0.2.1-rc.5",
    "0.2.2-rc.1",
    "0.2.2-rc.3",
  ]);
  assert.deepEqual(
    versionsOf(offeredReleases(many, [])),
    ["0.2.2-rc.1", "0.2.1-rc.5", "0.2.0-rc.2", "0.1.7-rc.1", "0.1.6-rc.1"],
    "five, one per line, newest first, nothing deprecated or newer than latest",
  );
  assert.deepEqual(versionsOf(offeredReleases(releases({}, ["1.0.0", "1.1.0", "1.2.0-rc.1"]), [])), ["1.1.0", "1.0.0"], "no latest: every stable release");
});
