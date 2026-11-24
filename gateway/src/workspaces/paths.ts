// Each workspace's directories under PORTAL_DATA_DIR and small file helpers.
//
// users/<id>/                root:root 0711  one directory per agent, nothing else
//   <agent>/                 root:root 0711  one directory per kind, nothing else
//     private/ and online/   root:root 0711  one workspace's own files; no other workspace's container mounts them
//       home/                uid:uid   0700  mounted at /home/user (the agent's state: chats, caches, sign-ins)
//       workspace/           uid:uid   0700  mounted at /workspace (the user's files)
//       system/              root:root 0755  rendered by the gateway, mounted read-only:
//         settings/                           the agent's settings (with the kind's service address)
//         passwd, group
//
// uid is WORKSPACE_UID_BASE + the workspace's number (workspaceNumber), so no two workspaces share an owner, not
// even two of one user, and a workspace never owns anything outside its own home and workspace.
import fs from "node:fs";
import path from "node:path";
import { workspaceNumber, type WorkspaceRef } from "@portal/core";
import { driverFor } from "../agents/index.ts";
import type { Config } from "../config.ts";

interface FileOwner {
  uid: number;
  gid: number;
}

/** users/<id>: everything of all of the user's workspaces. */
export function userRoot(dataDir: string, userId: number): string {
  return path.join(dataDir, "users", String(userId));
}

export function workspacePaths(dataDir: string, userId: number, ref: WorkspaceRef) {
  const root = path.join(userRoot(dataDir, userId), ref.agent, ref.kind);
  const system = path.join(root, "system");
  return {
    root,
    home: path.join(root, "home"),
    workspace: path.join(root, "workspace"),
    system,
    settings: path.join(system, "settings"),
    passwd: path.join(system, "passwd"),
    group: path.join(system, "group"),
  };
}

/** The account a workspace runs as, and no other workspace does. */
export function workspaceOwner(config: Config, userId: number, ref: WorkspaceRef): FileOwner {
  const id = config.workspace.uidBase + workspaceNumber(userId, ref);
  return { uid: id, gid: id };
}

/**
 * Everything a workspace's container mounts, ready before it is created. The read-only files are rendered at every
 * start, so changed admin settings apply on restart. Throws AgentConfigError for unusable settings.
 */
export function prepareWorkspaceFiles(config: Config, userId: number, ref: WorkspaceRef): void {
  const paths = workspacePaths(config.dataDir, userId, ref);
  const owner = workspaceOwner(config, userId, ref);
  // Rendered first: invalid settings fail the start before anything is written.
  const files = driverFor(ref.agent).renderSettings(config, ref.kind);
  for (const dir of [userRoot(config.dataDir, userId), path.dirname(paths.root), paths.root]) ensureDir(dir, 0o711);
  ensureDir(paths.system, 0o755);
  ensureDir(paths.settings, 0o755);
  for (const dir of [paths.home, paths.workspace]) ensureDir(dir, 0o700, owner);
  for (const [name, content] of Object.entries(files)) writeFileAtomic(path.join(paths.settings, name), content);
  writeFileAtomic(
    paths.passwd,
    `root:x:0:0:root:/root:/usr/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\nuser:x:${owner.uid}:${owner.gid}:Workspace user:/home/user:/bin/bash\n`,
  );
  writeFileAtomic(paths.group, `root:x:0:\nnogroup:x:65534:\nuser:x:${owner.gid}:\n`);
}

/** Empties one workspace's home and workspace (Admin's "Erase files"); the caller makes sure it has no container. */
export async function eraseWorkspaceFiles(dataDir: string, userId: number, ref: WorkspaceRef, owner: FileOwner): Promise<void> {
  const paths = workspacePaths(dataDir, userId, ref);
  for (const dir of [paths.home, paths.workspace]) await removeTree(dir);
  if (!fs.existsSync(paths.root)) return;
  for (const dir of [paths.home, paths.workspace]) ensureDir(dir, 0o700, owner);
}

function ensureDir(dir: string, mode: number, owner: FileOwner = { uid: 0, gid: 0 }): void {
  fs.mkdirSync(dir, { recursive: true });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  // Only root can hand files to other UIDs; in tests and local runs the gateway is an ordinary user.
  if (process.getuid?.() === 0 && (stat.uid !== owner.uid || stat.gid !== owner.gid)) fs.lchownSync(dir, owner.uid, owner.gid);
  if ((stat.mode & 0o7777) !== mode) fs.chmodSync(dir, mode);
}

/** Deletes everything the user's workspaces ever stored (user deletion). */
export function removeUserData(dataDir: string, userId: number): Promise<void> {
  return removeTree(userRoot(dataDir, userId));
}

/** Asynchronous: a large tree must not stall the gateway. Agents can leave directories without write permission behind; access is restored and the removal retried. */
async function removeTree(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    await grantOwnerAccess(dir);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

async function grantOwnerAccess(dir: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    await fs.promises.chmod(dir, 0o700);
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // The failed attempt removes other parts of the tree in parallel and may still be at it.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await grantOwnerAccess(path.join(dir, entry.name));
  }
}

/** Writes a file so readers never see a partial version (temp file in the same directory, then rename). */
export function writeFileAtomic(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, content, { mode });
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
}
