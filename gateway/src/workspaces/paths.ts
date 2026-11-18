// Per-user directories under PORTAL_DATA_DIR and small file helpers.
//
// users/<id>/              root:root 0711  one directory per workspace kind, nothing else
//   private/ and online/   root:root 0711  the kind's own files; neither kind's container mounts the other's
//     home/                uid:uid   0700  mounted at /home/user (each agent's state in its own
//                                           dot-dir: ~/.qwen, ~/.dsh; chats, caches)
//     workspace/           uid:uid   0700  mounted at /workspace (the user's files, for either agent)
//     system/              root:root 0755  rendered by the gateway, mounted read-only:
//       <agent>/                            that agent's settings (with this kind's service address)
//       passwd, group
//
// uid is the kind's UID base + user id (WORKSPACE_UID_BASE for Private, ONLINE_UID_BASE for Online), so no two
// workspaces share an owner, not even one user's two kinds, and a workspace never owns anything outside its own
// home and workspace.
import fs from "node:fs";
import path from "node:path";
import type { AgentKind, WorkspaceKind } from "@portal/core";
import { driverFor } from "../agents/index.ts";
import type { Config } from "../config.ts";

interface FileOwner {
  uid: number;
  gid: number;
}

/** users/<id>: everything of both of the user's workspaces. */
export function userRoot(dataDir: string, userId: number): string {
  return path.join(dataDir, "users", String(userId));
}

export function userPaths(dataDir: string, userId: number, kind: WorkspaceKind) {
  const root = path.join(userRoot(dataDir, userId), kind);
  const system = path.join(root, "system");
  return {
    root,
    home: path.join(root, "home"),
    workspace: path.join(root, "workspace"),
    system,
    agentSettings: (agent: AgentKind) => path.join(system, agent),
    passwd: path.join(system, "passwd"),
    group: path.join(system, "group"),
  };
}

/** The account a workspace of a kind runs as. */
export function workspaceOwner(config: Config, userId: number, kind: WorkspaceKind): FileOwner {
  const id = config.workspace.kinds[kind].uidBase + userId;
  return { uid: id, gid: id };
}

/**
 * Everything a workspace container of `kind` mounts, ready before it is created. The read-only files are rendered at
 * every start, so changed admin settings apply on restart. Throws AgentConfigError for unusable settings.
 */
export function prepareWorkspaceFiles(config: Config, userId: number, kind: WorkspaceKind, agent: AgentKind): void {
  const paths = userPaths(config.dataDir, userId, kind);
  const owner = workspaceOwner(config, userId, kind);
  // Rendered first: invalid settings fail the start before anything is written.
  const files = driverFor(agent).renderSettings(config, kind);
  ensureDir(path.dirname(paths.root), 0o711);
  ensureDir(paths.root, 0o711);
  ensureDir(paths.system, 0o755);
  ensureDir(paths.agentSettings(agent), 0o755);
  for (const dir of [paths.home, paths.workspace]) ensureDir(dir, 0o700, owner);
  for (const [name, content] of Object.entries(files)) writeFileAtomic(path.join(paths.agentSettings(agent), name), content);
  writeFileAtomic(
    paths.passwd,
    `root:x:0:0:root:/root:/usr/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\nuser:x:${owner.uid}:${owner.gid}:Workspace user:/home/user:/bin/bash\n`,
  );
  writeFileAtomic(paths.group, `root:x:0:\nnogroup:x:65534:\nuser:x:${owner.gid}:\n`);
}

/** Empties one kind's home and workspace (Admin's "Erase files"); the caller makes sure that kind has no container. */
export async function eraseKindFiles(dataDir: string, userId: number, kind: WorkspaceKind, owner: FileOwner): Promise<void> {
  const paths = userPaths(dataDir, userId, kind);
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

/** Deletes everything both of the user's workspaces ever stored (user deletion). */
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
