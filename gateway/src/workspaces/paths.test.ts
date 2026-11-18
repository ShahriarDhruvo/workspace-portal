import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eraseKindFiles, removeUserData, userPaths, userRoot } from "./paths.ts";

const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

function write(file: string, content = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("each kind has its own folder under the user's; nothing of one lies inside the other", () => {
  const priv = userPaths("/srv/wp", 7, "private");
  const online = userPaths("/srv/wp", 7, "online");
  assert.equal(userRoot("/srv/wp", 7), "/srv/wp/users/7");
  assert.deepEqual([priv.root, priv.home, priv.workspace, priv.passwd], ["/srv/wp/users/7/private", "/srv/wp/users/7/private/home", "/srv/wp/users/7/private/workspace", "/srv/wp/users/7/private/system/passwd"]);
  assert.equal(online.agentSettings("dsh"), "/srv/wp/users/7/online/system/dsh");
  for (const a of [priv.root, priv.home, priv.workspace, priv.system]) {
    for (const b of [online.root, online.home, online.workspace, online.system]) assert.ok(!a.startsWith(b) && !b.startsWith(a), `${a} / ${b}`);
  }
});

test("erasing one kind empties its home and workspace and leaves the other kind alone", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paths-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const priv = userPaths(dataDir, 5, "private");
  const online = userPaths(dataDir, 5, "online");
  for (const paths of [priv, online]) {
    write(path.join(paths.home, ".bashrc"));
    write(path.join(paths.workspace, "a", "b.txt"));
    write(paths.passwd);
  }
  fs.chmodSync(path.join(online.workspace, "a"), 0o500); // a folder the workspace made read-only
  await eraseKindFiles(dataDir, 5, "online", me);
  assert.deepEqual([fs.readdirSync(online.home), fs.readdirSync(online.workspace)], [[], []]);
  assert.equal(fs.statSync(online.workspace).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(online.passwd), "system/ is re-rendered at every start anyway");
  assert.ok(fs.existsSync(path.join(priv.workspace, "a", "b.txt")), "the Private files are untouched");
  assert.ok(fs.existsSync(path.join(priv.home, ".bashrc")));

  await eraseKindFiles(dataDir, 5, "private", me);
  assert.deepEqual([fs.readdirSync(priv.home), fs.readdirSync(priv.workspace)], [[], []]);
  assert.deepEqual(fs.readdirSync(userRoot(dataDir, 5)).sort(), ["online", "private"]);

  // A kind that never ran has nothing to erase, and gets no folders.
  await eraseKindFiles(dataDir, 6, "online", me);
  assert.equal(fs.existsSync(userRoot(dataDir, 6)), false);

  await removeUserData(dataDir, 5);
  assert.equal(fs.existsSync(userRoot(dataDir, 5)), false, "deleting the user removes both kinds");
});
