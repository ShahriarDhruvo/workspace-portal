// Per-user directories under PORTAL_DATA_DIR and small file helpers.
//
// users/<id>/            root:root 0711  nothing but the three directories below
//   home/                uid:uid   0700  mounted at /home/user (Qwen Code's ~/.qwen, chats, caches)
//   workspace/           uid:uid   0700  mounted at /workspace (the user's files)
//   system/              root:root 0755  mounted read-only: Qwen Code system settings, passwd, group
//
// uid is WORKSPACE_UID_BASE + user id, so no two workspaces share an owner, and a workspace never
// owns anything outside its own home and workspace.
import fs from "node:fs";
import path from "node:path";

export interface UserPaths {
  root: string;
  /** Mounted at /home/user. */
  home: string;
  /** Mounted at /workspace: the user's files. */
  workspace: string;
  /** Read-only files the gateway renders before every start. */
  system: string;
  /** Mounted at QWEN_SETTINGS_MOUNT (settings.json, system-defaults.json). */
  qwenSettings: string;
  passwd: string;
  group: string;
}

export interface FileOwner {
  uid: number;
  gid: number;
}

export function userPaths(dataDir: string, userId: number): UserPaths {
  const root = path.join(dataDir, "users", String(userId));
  const system = path.join(root, "system");
  return {
    root,
    home: path.join(root, "home"),
    workspace: path.join(root, "workspace"),
    system,
    qwenSettings: path.join(system, "qwen"),
    passwd: path.join(system, "passwd"),
    group: path.join(system, "group"),
  };
}

/** The account a workspace runs as. */
export function workspaceOwner(uidBase: number, userId: number): FileOwner {
  return { uid: uidBase + userId, gid: uidBase + userId };
}

/**
 * Creates the user's directories and gives the private ones to the workspace's own UID. A tree
 * left by another owner (an older install, or a changed WORKSPACE_UID_BASE) is handed over whole.
 */
export async function ensureUserDirs(paths: UserPaths, owner: FileOwner): Promise<void> {
  ensureDir(paths.root, 0o711, { uid: 0, gid: 0 });
  ensureDir(paths.system, 0o755, { uid: 0, gid: 0 });
  ensureDir(paths.qwenSettings, 0o755, { uid: 0, gid: 0 });
  for (const dir of [paths.home, paths.workspace]) {
    ensureDir(dir, 0o700, owner);
    const stat = fs.lstatSync(dir);
    if (stat.uid !== owner.uid || stat.gid !== owner.gid) await chownTree(dir, owner);
  }
}

function ensureDir(dir: string, mode: number, owner: FileOwner): void {
  fs.mkdirSync(dir, { recursive: true });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (canChown() && (stat.uid !== owner.uid || stat.gid !== owner.gid)) fs.lchownSync(dir, owner.uid, owner.gid);
  if ((stat.mode & 0o7777) !== mode) fs.chmodSync(dir, mode);
}

/**
 * Changes the owner of a whole tree without following symlinks. Asynchronous, one entry at a time:
 * a large home directory must not stall the gateway (or exhaust file descriptors).
 */
async function chownTree(dir: string, owner: FileOwner): Promise<void> {
  if (!canChown()) return;
  await fs.promises.lchown(dir, owner.uid, owner.gid);
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await chownTree(child, owner);
    else await fs.promises.lchown(child, owner.uid, owner.gid);
  }
}

/** Only root can hand files to other UIDs; in tests and local runs the gateway is an ordinary user. */
function canChown(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/** /etc/passwd of a workspace: the system accounts and `user`, the workspace's own UID. */
export function renderPasswd(owner: FileOwner): string {
  return [
    "root:x:0:0:root:/root:/usr/sbin/nologin",
    "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
    `user:x:${owner.uid}:${owner.gid}:Workspace user:/home/user:/bin/bash`,
    "",
  ].join("\n");
}

export function renderGroup(owner: FileOwner): string {
  return ["root:x:0:", "nogroup:x:65534:", `user:x:${owner.gid}:`, ""].join("\n");
}

/**
 * Deletes everything the user's workspace ever stored, without blocking the gateway on a large
 * tree. Agents can leave directories without write permission behind; the gateway restores access
 * and retries.
 */
export async function removeUserData(paths: UserPaths): Promise<void> {
  try {
    await fs.promises.rm(paths.root, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    await grantOwnerAccess(paths.root);
    await fs.promises.rm(paths.root, { recursive: true, force: true });
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
