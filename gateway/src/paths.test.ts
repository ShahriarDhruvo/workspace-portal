import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eraseKindFiles, hasLegacyFiles, moveLegacyFiles, removeUserData, userPaths, userRoot } from "./paths.ts";

const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paths-"));
  return run(dataDir).finally(() => fs.rmSync(dataDir, { recursive: true, force: true }));
}

function write(file: string, content = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** The layout from before kinds: users/<id>/{home,workspace,system}. */
function legacyLayout(dataDir: string, userId: number): string {
  const root = userRoot(dataDir, userId);
  write(path.join(root, "home", ".qwen", "chats.json"), "chats");
  write(path.join(root, "workspace", "project", "main.py"), "print(1)");
  write(path.join(root, "system", "qwen", "settings.json"), "{}");
  return root;
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

test("the files from before kinds become the Private ones, by rename; the old system/ goes; a second run does nothing", () =>
  withDataDir(async (dataDir) => {
    const root = legacyLayout(dataDir, 3);
    const inode = fs.statSync(path.join(root, "workspace", "project", "main.py")).ino;
    assert.equal(hasLegacyFiles(dataDir, 3), true);
    assert.equal(await moveLegacyFiles(dataDir, 3), true);

    const priv = userPaths(dataDir, 3, "private");
    assert.equal(fs.readFileSync(path.join(priv.workspace, "project", "main.py"), "utf8"), "print(1)");
    assert.equal(fs.statSync(path.join(priv.workspace, "project", "main.py")).ino, inode, "moved, not copied");
    assert.equal(fs.readFileSync(path.join(priv.home, ".qwen", "chats.json"), "utf8"), "chats");
    assert.deepEqual(fs.readdirSync(root), ["private"], "nothing of the old layout is left");
    assert.equal(fs.statSync(priv.root).mode & 0o777, 0o711);
    assert.equal(fs.existsSync(userPaths(dataDir, 3, "online").root), false, "Online starts empty");

    assert.equal(hasLegacyFiles(dataDir, 3), false);
    assert.equal(await moveLegacyFiles(dataDir, 3), false);
    assert.equal(fs.readFileSync(path.join(priv.workspace, "project", "main.py"), "utf8"), "print(1)");
  }));

test("an interrupted move finishes; an empty Private folder makes way, one with files stops the move", () =>
  withDataDir(async (dataDir) => {
    const root = legacyLayout(dataDir, 4);
    const priv = userPaths(dataDir, 4, "private");
    // home/ was moved, then the gateway stopped; a start had already created an empty workspace/.
    fs.mkdirSync(priv.root, { recursive: true });
    fs.renameSync(path.join(root, "home"), priv.home);
    fs.mkdirSync(priv.workspace);
    assert.equal(await moveLegacyFiles(dataDir, 4), true);
    assert.equal(fs.readFileSync(path.join(priv.workspace, "project", "main.py"), "utf8"), "print(1)");
    assert.deepEqual(fs.readdirSync(root), ["private"]);

    write(path.join(root, "workspace", "other.txt"));
    await assert.rejects(moveLegacyFiles(dataDir, 4), /both .*\/users\/4\/workspace and .*\/users\/4\/private\/workspace exist: move what/);
    assert.ok(fs.existsSync(path.join(root, "workspace", "other.txt")), "nothing was overwritten or removed");
    assert.ok(fs.existsSync(path.join(priv.workspace, "project", "main.py")));
  }));

test("erasing one kind empties its home and workspace and leaves the other kind alone", () =>
  withDataDir(async (dataDir) => {
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

    // Private also loses files still in the layout from before kinds.
    write(path.join(userRoot(dataDir, 5), "workspace", "old.txt"));
    await eraseKindFiles(dataDir, 5, "private", me);
    assert.deepEqual([fs.readdirSync(priv.home), fs.readdirSync(priv.workspace)], [[], []]);
    assert.deepEqual(fs.readdirSync(userRoot(dataDir, 5)).sort(), ["online", "private"]);

    // A kind that never ran has nothing to erase, and gets no folders.
    await eraseKindFiles(dataDir, 6, "online", me);
    assert.equal(fs.existsSync(userRoot(dataDir, 6)), false);

    await removeUserData(dataDir, 5);
    assert.equal(fs.existsSync(userRoot(dataDir, 5)), false, "deleting the user removes both kinds");
  }));
