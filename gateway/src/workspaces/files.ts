// The files behind a workspace container: one kind's directories of the user, owned by that kind's own UID, and
// the read-only files mounted into it (the agent's settings with the portal's keys and that kind's service address
// forced, passwd/group naming that UID). Rendered at every start, so changed admin settings apply on restart.
import path from "node:path";
import type { AgentKind, WorkspaceKind } from "@portal/core";
import { driverFor } from "../agents/index.ts";
import type { Config } from "../config.ts";
import {
  ensureUserDirs,
  eraseKindFiles,
  moveLegacyFiles,
  removeUserData,
  renderGroup,
  renderPasswd,
  userPaths,
  workspaceOwner,
  writeFileAtomic,
} from "./paths.ts";

/** The UID/GID a kind of the user's workspace runs as and owns its files with. */
export function kindOwner(config: Config, userId: number, kind: WorkspaceKind): { uid: number; gid: number } {
  return workspaceOwner(config.workspace.kinds[kind].uidBase, userId);
}

/**
 * Everything a workspace container of `kind` mounts, ready before it is created. The caller makes sure the user has
 * no container: the Private files of the layout from before kinds are moved into place first. Throws
 * AgentConfigError for unusable settings.
 */
export async function prepareWorkspaceFiles(config: Config, userId: number, kind: WorkspaceKind, agent: AgentKind): Promise<void> {
  const paths = userPaths(config.dataDir, userId, kind);
  const owner = kindOwner(config, userId, kind);
  // Rendered first: invalid settings fail the start before anything is written.
  const files = driverFor(agent).renderSettings(config, kind);
  await moveLegacyFiles(config.dataDir, userId);
  await ensureUserDirs(paths, owner, agent);
  for (const [name, content] of Object.entries(files)) writeFileAtomic(path.join(paths.agentSettings(agent), name), content);
  writeFileAtomic(paths.passwd, renderPasswd(owner));
  writeFileAtomic(paths.group, renderGroup(owner));
}

/** Empties one kind's home and workspace; the caller makes sure that kind has no container. */
export function eraseWorkspaceFiles(config: Config, userId: number, kind: WorkspaceKind): Promise<void> {
  return eraseKindFiles(config.dataDir, userId, kind, kindOwner(config, userId, kind));
}

/** Deletes everything both of the user's workspaces ever stored (user deletion). */
export function removeWorkspaceFiles(config: Config, userId: number): Promise<void> {
  return removeUserData(config.dataDir, userId);
}
