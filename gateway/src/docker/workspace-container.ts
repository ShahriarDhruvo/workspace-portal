// A workspace's container as the gateway asks Docker for it: the common security profile (@portal/container), filled
// in with whose workspace it is, where its files are, and what its harness adds: an environment and a settings mount.
import type Docker from "dockerode";
import { workspaceContainerOptions } from "@portal/container";
import { driverFor, LLM_KEY_ENV } from "@portal/harnesses";
import type { Config } from "../config.ts";
import { workspaceOwner, workspacePaths } from "../workspaces/paths.ts";
import { parseWorkspaceImage } from "./image-names.ts";
import type { WorkspaceStartOptions } from "./runtime.ts";

export function workspaceContainer(config: Config, userId: number, { ref, credential, image }: WorkspaceStartOptions): Docker.ContainerCreateOptions {
  const driver = driverFor(ref.agent);
  return workspaceContainerOptions({
    userId,
    ref,
    image,
    version: parseWorkspaceImage(image)?.version,
    owner: workspaceOwner(config, userId, ref),
    paths: workspacePaths(config.dataDir, userId, ref),
    settingsMount: driver.settingsMount,
    // The key is a placeholder: the gateway replaces it with the real LLM key, which never enters a workspace.
    env: [`${LLM_KEY_ENV}=portal`, ...driver.containerEnv(credential, config)],
    network: config.workspace.kinds[ref.kind],
    limits: config.workspace,
  });
}
