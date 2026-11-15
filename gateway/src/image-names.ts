// Names of the workspace images. Each agent version has its own image, so running workspaces keep the
// image they started from while new starts use another, and rolling back to a version whose image is
// still there just checks and uses it (no build, no registry). deploy/lib.sh (workspace_image) names
// them the same way.
import { isAgentKind, type AgentKind } from "@portal/db";
import { isVersion } from "./versions.ts";

export const WORKSPACE_REPOSITORY = "workspace-portal/workspace";
/**
 * Where the gateway builds an image before it is checked: only a verified image gets the workspace
 * tag, so a failed rebuild of the current version never replaces the image new workspaces start from.
 */
export const STAGING_REPOSITORY = "workspace-portal/workspace-build";

/** `workspace-portal/workspace:<agent>-<version>`. */
export function workspaceImage(kind: AgentKind, version: string): string {
  return `${WORKSPACE_REPOSITORY}:${kind}-${version}`;
}

/** The tag a build of this agent version gets until it passes its check. */
export function stagingImage(kind: AgentKind, version: string): string {
  return `${STAGING_REPOSITORY}:${kind}-${version}`;
}

/**
 * The agent and version of a workspace image reference, as Docker reports it for an image tag or a
 * container (`workspace-portal/workspace:dsh-0.2.2-rc.1`); null for anything else, an image id included.
 */
export function parseWorkspaceImage(reference: string): { kind: AgentKind; version: string } | null {
  const prefix = `${WORKSPACE_REPOSITORY}:`;
  const rest = reference.startsWith(prefix) ? reference.slice(prefix.length) : reference.startsWith(`docker.io/${prefix}`) ? reference.slice(prefix.length + 10) : null;
  if (rest === null) return null;
  const dash = rest.indexOf("-");
  const kind = rest.slice(0, dash);
  const version = rest.slice(dash + 1);
  return dash > 0 && isAgentKind(kind) && isVersion(version) ? { kind, version } : null;
}
