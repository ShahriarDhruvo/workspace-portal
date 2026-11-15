import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAgentVersions, type AgentVersionInputs } from "./agent-overview.ts";
import type { WorkspaceImageSummary } from "./image-builder.ts";
import { workspaceImage } from "./image-names.ts";

const image = (kind: "qwen" | "dsh", version: string, createdAt = 1_000): WorkspaceImageSummary => ({
  image: workspaceImage(kind, version),
  kind,
  version,
  id: `sha256:${kind}${version}`,
  sizeBytes: 2_000_000_000,
  createdAt,
});

const base: AgentVersionInputs = {
  kind: "dsh",
  current: "0.2.2-rc.1",
  defaultVersion: "0.2.2-rc.1",
  distTags: { alpha: "0.2.2-alpha.3", latest: "0.2.2-rc.1", next: "0.2.2-rc.3", experiment: "0.0.1-x" },
  images: [image("dsh", "0.2.2-rc.1"), image("qwen", "0.27.4"), image("dsh", "0.2.2-rc.3"), image("dsh", "0.2.1")],
  workspaces: [],
};

test("an agent's versions: current, default, channels, images newest first, running workspaces", () => {
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
    channels: [
      { tag: "latest", version: "0.2.2-rc.1" },
      { tag: "next", version: "0.2.2-rc.3" },
      { tag: "alpha", version: "0.2.2-alpha.3" },
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
    describeAgentVersions({ ...base, current, distTags: latest === undefined ? {} : { latest } }).updateAvailable;
  assert.equal(at("0.2.2-rc.1", "0.2.2"), true);
  assert.equal(at("0.2.2-rc.3", "0.2.2-rc.1"), false, "ahead of latest on the next channel");
  assert.equal(at("0.2.2-rc.1", "0.2.2-rc.1"), false);
  assert.equal(at("0.2.2-rc.1", undefined), false);
});

test("without registry answers the channels and latest are unknown", () => {
  const info = describeAgentVersions({ ...base, kind: "qwen", current: "0.27.4", defaultVersion: "0.27.0", distTags: undefined });
  assert.deepEqual([info.latest, info.updateAvailable, info.channels], [null, false, []]);
  assert.equal(info.packageName, "@qwen-code/qwen-code");
  assert.deepEqual(info.installed.map((i) => [i.version, i.current]), [["0.27.4", true]]);
  assert.equal(describeAgentVersions({ ...base, distTags: { latest: "garbage" } }).latest, null, "an unusable latest is unknown");
});
