import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE_BLOCK, WORKSPACE_REFS, type WorkspaceRef } from "@portal/core";
import { loadConfig } from "../config.ts";
import { eraseWorkspaceFiles, prepareWorkspaceFiles, removeUserData, userRoot, workspaceOwner, workspacePaths } from "./paths.ts";

const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
const QWEN_PRIVATE: WorkspaceRef = { agent: "qwen", kind: "private" };
const QWEN_ONLINE: WorkspaceRef = { agent: "qwen", kind: "online" };
const DSH_PRIVATE: WorkspaceRef = { agent: "dsh", kind: "private" };

function write(file: string, content = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("each workspace has its own folder under the user's; nothing of one lies inside another", () => {
  assert.equal(userRoot("/srv/wp", 7), "/srv/wp/users/7");
  const own = workspacePaths("/srv/wp", 7, QWEN_PRIVATE);
  assert.deepEqual(own, {
    root: "/srv/wp/users/7/qwen/private",
    home: "/srv/wp/users/7/qwen/private/home",
    workspace: "/srv/wp/users/7/qwen/private/workspace",
    system: "/srv/wp/users/7/qwen/private/system",
    settings: "/srv/wp/users/7/qwen/private/system/settings",
    passwd: "/srv/wp/users/7/qwen/private/system/passwd",
    group: "/srv/wp/users/7/qwen/private/system/group",
  });
  assert.equal(workspacePaths("/srv/wp", 7, { agent: "opencode", kind: "online" }).home, "/srv/wp/users/7/opencode/online/home");
  const roots = WORKSPACE_REFS.map((ref) => workspacePaths("/srv/wp", 7, ref).root);
  assert.equal(new Set(roots).size, WORKSPACE_REFS.length);
  for (const a of roots) for (const b of roots) assert.ok(a === b || !`${a}/`.startsWith(`${b}/`), `${a} / ${b}`);
});

test("each workspace runs as a UID of its own, whoever's and whichever it is", () => {
  const config = loadConfig({ GATEWAY_CONTROL_SECRET: "c".repeat(32), WORKSPACE_UID_BASE: "300000" });
  assert.deepEqual(workspaceOwner(config, 7, QWEN_PRIVATE), { uid: 300_140, gid: 300_140 });
  assert.deepEqual(workspaceOwner(config, 7, QWEN_ONLINE), { uid: 300_141, gid: 300_141 });
  assert.deepEqual(workspaceOwner(config, 7, DSH_PRIVATE), { uid: 300_142, gid: 300_142 });
  const uids = new Set<number>();
  for (let userId = 1; userId < config.agentPortCount; userId++) for (const ref of WORKSPACE_REFS) uids.add(workspaceOwner(config, userId, ref).uid);
  assert.equal(uids.size, (config.agentPortCount - 1) * WORKSPACE_REFS.length);
  assert.ok(Math.max(...uids) < 300_000 + config.agentPortCount * WORKSPACE_BLOCK);
});

test("a start renders the workspace's own account and settings, in its own folders only", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paths-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({ GATEWAY_CONTROL_SECRET: "c".repeat(32), PORTAL_DATA_DIR: dataDir });
  // The admin's models, which every agent's settings are rendered from.
  write(path.join(config.modelsDir, "system-defaults.json"), JSON.stringify({ modelProviders: { openai: [{ id: "model-a" }] } }));
  prepareWorkspaceFiles(config, 3, DSH_PRIVATE);
  const paths = workspacePaths(dataDir, 3, DSH_PRIVATE);
  const { uid } = workspaceOwner(config, 3, DSH_PRIVATE);
  assert.match(fs.readFileSync(paths.passwd, "utf8"), new RegExp(`^user:x:${uid}:${uid}:Workspace user:/home/user:/bin/bash$`, "m"));
  assert.match(fs.readFileSync(paths.group, "utf8"), new RegExp(`^user:x:${uid}:$`, "m"));
  assert.deepEqual(fs.readdirSync(paths.root).sort(), ["home", "system", "workspace"]);
  assert.ok(fs.readdirSync(paths.settings).length > 0, "the agent's settings");
  for (const dir of [userRoot(dataDir, 3), path.dirname(paths.root), paths.root]) assert.equal(fs.statSync(dir).mode & 0o777, 0o711, dir);
  for (const dir of [paths.home, paths.workspace]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  assert.deepEqual(fs.readdirSync(userRoot(dataDir, 3)), ["dsh"], "no other agent's folder");
  assert.deepEqual(fs.readdirSync(path.dirname(paths.root)), ["private"], "nor the other kind's");
});

test("erasing one workspace empties its home and workspace and leaves the user's others alone", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paths-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const [erased, otherKind, otherAgent] = [QWEN_ONLINE, QWEN_PRIVATE, { agent: "dsh", kind: "online" } as const].map((ref) => workspacePaths(dataDir, 5, ref));
  for (const paths of [erased!, otherKind!, otherAgent!]) {
    write(path.join(paths.home, ".bashrc"));
    write(path.join(paths.workspace, "a", "b.txt"));
    write(paths.passwd);
  }
  fs.chmodSync(path.join(erased!.workspace, "a"), 0o500); // a folder the workspace made read-only
  await eraseWorkspaceFiles(dataDir, 5, QWEN_ONLINE, me);
  assert.deepEqual([fs.readdirSync(erased!.home), fs.readdirSync(erased!.workspace)], [[], []]);
  assert.equal(fs.statSync(erased!.workspace).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(erased!.passwd), "system/ is re-rendered at every start anyway");
  for (const [paths, what] of [[otherKind!, "the same agent's other kind"], [otherAgent!, "another agent's workspace of the same kind"]] as const) {
    assert.ok(fs.existsSync(path.join(paths.workspace, "a", "b.txt")), `${what} is untouched`);
    assert.ok(fs.existsSync(path.join(paths.home, ".bashrc")), what);
  }

  // A workspace that never ran has nothing to erase, and gets no folders.
  await eraseWorkspaceFiles(dataDir, 6, QWEN_ONLINE, me);
  assert.equal(fs.existsSync(userRoot(dataDir, 6)), false);

  await removeUserData(dataDir, 5);
  assert.equal(fs.existsSync(userRoot(dataDir, 5)), false, "deleting the user removes every workspace's files");
});
