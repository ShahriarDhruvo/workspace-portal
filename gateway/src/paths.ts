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
//
// Before kinds existed the Private files were users/<id>/{home,workspace,system}; moveLegacyFiles puts them in
// private/ (renames: nothing is copied, owners and SELinux labels stay) while that user has no container.
import fs from "node:fs";
import path from "node:path";
import type { AgentKind, WorkspaceKind } from "@portal/db";

/** One kind of one user's workspace: what its container mounts. */
export interface UserPaths {
  /** users/<id>/<kind>. */
  root: string;
  /** Mounted at /home/user. */
  home: string;
  /** Mounted at /workspace: the user's files. */
  workspace: string;
  /** Read-only files the gateway renders before every start. */
  system: string;
  /** Mounted at the agent's settingsMount: the settings rendered for that agent. */
  agentSettings(kind: AgentKind): string;
  passwd: string;
  group: string;
}

export interface FileOwner {
  uid: number;
  gid: number;
}

/** users/<id>: everything of both of the user's workspaces. */
export function userRoot(dataDir: string, userId: number): string {
  return path.join(dataDir, "users", String(userId));
}

export function userPaths(dataDir: string, userId: number, kind: WorkspaceKind): UserPaths {
  const root = path.join(userRoot(dataDir, userId), kind);
  const system = path.join(root, "system");
  return {
    root,
    home: path.join(root, "home"),
    workspace: path.join(root, "workspace"),
    system,
    agentSettings: (agent) => path.join(system, agent),
    passwd: path.join(system, "passwd"),
    group: path.join(system, "group"),
  };
}

/** The account a workspace of a kind runs as (`uidBase`: that kind's). */
export function workspaceOwner(uidBase: number, userId: number): FileOwner {
  return { uid: uidBase + userId, gid: uidBase + userId };
}

/**
 * Creates one kind's directories and gives its home and workspace to that kind's own UID. A tree left by another
 * owner (an older install, or a changed UID base) is handed over whole.
 */
export async function ensureUserDirs(paths: UserPaths, owner: FileOwner, agent: AgentKind): Promise<void> {
  ensureDir(path.dirname(paths.root), 0o711, { uid: 0, gid: 0 });
  ensureDir(paths.root, 0o711, { uid: 0, gid: 0 });
  ensureDir(paths.system, 0o755, { uid: 0, gid: 0 });
  ensureDir(paths.agentSettings(agent), 0o755, { uid: 0, gid: 0 });
  for (const dir of [paths.home, paths.workspace]) {
    ensureDir(dir, 0o700, owner);
    const stat = fs.lstatSync(dir);
    if (stat.uid !== owner.uid || stat.gid !== owner.gid) await chownTree(dir, owner);
  }
}

/** The folders of the layout from before kinds, all of them the Private workspace's. */
const LEGACY_DIRS = ["home", "workspace"] as const;

/** users/<id> still holds the Private files where they were before kinds (home/, workspace/ or system/ at its top). */
export function hasLegacyFiles(dataDir: string, userId: number): boolean {
  const root = userRoot(dataDir, userId);
  return [...LEGACY_DIRS, "system"].some((name) => fs.existsSync(path.join(root, name)));
}

/**
 * Moves the Private files from before kinds into users/<id>/private/: home/ and workspace/ by rename (same
 * filesystem: the owner, the mode and the SELinux label stay), and removes the old system/ (re-rendered per kind at
 * every start). Each step can be repeated, so an interrupted move finishes the next time. Only while the user has no
 * container: a running one mounts the old paths. Throws when private/ already has a non-empty folder of that name
 * (nothing is overwritten; the admin has to look).
 */
export async function moveLegacyFiles(dataDir: string, userId: number): Promise<boolean> {
  const root = userRoot(dataDir, userId);
  if (!hasLegacyFiles(dataDir, userId)) return false;
  const target = userPaths(dataDir, userId, "private");
  ensureDir(target.root, 0o711, { uid: 0, gid: 0 });
  for (const name of LEGACY_DIRS) {
    const from = path.join(root, name);
    if (!fs.existsSync(from)) continue;
    const to = target[name];
    if (fs.existsSync(to)) {
      if (fs.readdirSync(to).length > 0) throw new Error(`both ${from} and ${to} exist: move what ${from} holds into ${to} by hand, then remove ${from}`);
      fs.rmdirSync(to);
    }
    fs.renameSync(from, to);
  }
  await fs.promises.rm(path.join(root, "system"), { recursive: true, force: true });
  return true;
}

/**
 * Empties one kind's home and workspace (Admin's "Erase files"): both are removed, then created again empty for
 * `owner`. Private also loses the files of the layout from before kinds, should they still be there.
 */
export async function eraseKindFiles(dataDir: string, userId: number, kind: WorkspaceKind, owner: FileOwner): Promise<void> {
  const paths = userPaths(dataDir, userId, kind);
  const legacy = kind === "private" ? [...LEGACY_DIRS, "system"].map((name) => path.join(userRoot(dataDir, userId), name)) : [];
  for (const dir of [paths.home, paths.workspace, ...legacy]) await removeTree(dir);
  if (!fs.existsSync(paths.root)) return;
  for (const dir of [paths.home, paths.workspace]) ensureDir(dir, 0o700, owner);
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

/** Deletes everything both of the user's workspaces ever stored (user deletion). */
export function removeUserData(dataDir: string, userId: number): Promise<void> {
  return removeTree(userRoot(dataDir, userId));
}

/**
 * Removes a tree without blocking the gateway on a large one. Agents can leave directories without write
 * permission behind; the gateway restores access and retries.
 */
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
