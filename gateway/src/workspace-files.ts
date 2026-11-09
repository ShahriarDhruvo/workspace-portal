// The files behind a workspace container: the user's directories, owned by the workspace's own UID,
// and the read-only files mounted into it (the agent's settings with the portal's keys forced,
// passwd/group naming that UID). Rendered at every start, so changed admin settings apply on restart.
import path from "node:path";
import type { AgentKind } from "@portal/db";
import { driverFor } from "./agents/index.ts";
import type { Config } from "./config.ts";
import { ensureUserDirs, removeUserData, renderGroup, renderPasswd, userPaths, workspaceOwner, writeFileAtomic } from "./paths.ts";

/** Everything a workspace container mounts, ready before it is created. Throws AgentConfigError for unusable settings. */
export async function prepareWorkspaceFiles(config: Config, userId: number, agent: AgentKind): Promise<void> {
  const paths = userPaths(config.dataDir, userId);
  const owner = workspaceOwner(config.workspace.uidBase, userId);
  // Rendered first: invalid settings fail the start before anything is written.
  const files = driverFor(agent).renderSettings(config);
  await ensureUserDirs(paths, owner, agent);
  for (const [name, content] of Object.entries(files)) writeFileAtomic(path.join(paths.agentSettings(agent), name), content);
  writeFileAtomic(paths.passwd, renderPasswd(owner));
  writeFileAtomic(paths.group, renderGroup(owner));
}

/** Deletes everything the user's workspace ever stored (user deletion). */
export function removeWorkspaceFiles(config: Config, userId: number): Promise<void> {
  return removeUserData(userPaths(config.dataDir, userId));
}
