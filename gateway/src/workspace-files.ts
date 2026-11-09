// The files behind a workspace container: the user's directories, owned by the workspace's own UID,
// and the read-only files mounted into it (Qwen Code system settings with the portal's keys forced,
// passwd/group naming that UID). Rendered at every start, so changed admin settings apply on restart.
import path from "node:path";
import type { Config } from "./config.ts";
import { ensureUserDirs, removeUserData, renderGroup, renderPasswd, userPaths, workspaceOwner, writeFileAtomic } from "./paths.ts";
import { loadAdminQwenConfig, renderQwenSettings, type RenderedSettings } from "./qwen.ts";

/** The settings every workspace gets from the admin's files. Throws QwenConfigError when they are unusable. */
export function renderWorkspaceSettings(config: Config): RenderedSettings {
  return renderQwenSettings({
    admin: loadAdminQwenConfig(config.qwenConfigDir),
    serviceBaseUrl: `http://${config.workspace.gatewayIp}:${config.servicePort}`,
    browser: config.workspace.browser,
  });
}

/** Everything a workspace container mounts, ready before it is created. */
export async function prepareWorkspaceFiles(config: Config, userId: number): Promise<void> {
  const paths = userPaths(config.dataDir, userId);
  const owner = workspaceOwner(config.workspace.uidBase, userId);
  // Rendered first: invalid settings fail the start before anything is written.
  const rendered = renderWorkspaceSettings(config);
  await ensureUserDirs(paths, owner);
  writeFileAtomic(path.join(paths.qwenSettings, "settings.json"), `${JSON.stringify(rendered.settings, null, 2)}\n`);
  writeFileAtomic(path.join(paths.qwenSettings, "system-defaults.json"), `${JSON.stringify(rendered.systemDefaults, null, 2)}\n`);
  writeFileAtomic(paths.passwd, renderPasswd(owner));
  writeFileAtomic(paths.group, renderGroup(owner));
}

/** Deletes everything the user's workspace ever stored (user deletion). */
export function removeWorkspaceFiles(config: Config, userId: number): Promise<void> {
  return removeUserData(userPaths(config.dataDir, userId));
}
