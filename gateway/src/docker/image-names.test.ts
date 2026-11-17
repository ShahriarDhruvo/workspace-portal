import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkspaceImage, stagingImage, workspaceImage } from "./image-names.ts";

test("workspace images are named after the agent and the version", () => {
  assert.equal(workspaceImage("qwen", "0.27.4"), "workspace-portal/workspace:qwen-0.27.4");
  assert.equal(workspaceImage("dsh", "0.2.2-rc.1"), "workspace-portal/workspace:dsh-0.2.2-rc.1");
  assert.equal(stagingImage("dsh", "0.2.2-rc.1"), "workspace-portal/workspace-build:dsh-0.2.2-rc.1");
});

test("parseWorkspaceImage reads the agent and version back, and nothing else", () => {
  assert.deepEqual(parseWorkspaceImage("workspace-portal/workspace:qwen-0.27.4"), { kind: "qwen", version: "0.27.4" });
  assert.deepEqual(parseWorkspaceImage("workspace-portal/workspace:dsh-0.2.2-rc.1"), { kind: "dsh", version: "0.2.2-rc.1" });
  assert.deepEqual(parseWorkspaceImage("docker.io/workspace-portal/workspace:dsh-0.2.3"), { kind: "dsh", version: "0.2.3" });
  for (const other of [
    "sha256:4f1c0d0e2a",
    "workspace-portal/workspace:latest",
    "workspace-portal/workspace:claude-1.0.0",
    "workspace-portal/workspace:qwen-",
    "workspace-portal/workspace:qwen-latest",
    "workspace-portal/workspace-build:qwen-0.27.4",
    "workspace-portal/gateway:latest",
    "evil/workspace-portal/workspace:qwen-0.27.4",
    "",
  ]) {
    assert.equal(parseWorkspaceImage(other), null, other);
  }
  for (const [kind, version] of [["qwen", "0.28.0-preview.1"], ["dsh", "0.2.2-alpha.3"]] as const) {
    assert.deepEqual(parseWorkspaceImage(workspaceImage(kind, version)), { kind, version });
  }
});
