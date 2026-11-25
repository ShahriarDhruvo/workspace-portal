// The Preview button's choices: which web server of a workspace it opens, in what order it lists them, and at what
// address.
import { PREVIEW_PORT_PATH, type WorkspaceServer } from "@portal/core/wire";

/**
 * The address that shows the workspace's port `port`: on the workspace's preview port and the hostname the user
 * typed (the session cookie is host-scoped), the path that makes that origin serve `port` from then on.
 */
export function previewUrl(location: Pick<Location, "protocol" | "hostname">, previewPort: number, port: number): string {
  return `${location.protocol}//${location.hostname}:${previewPort}${PREVIEW_PORT_PATH}${port}/`;
}

/** The servers as the list shows them: by port. */
export function byPort(servers: readonly WorkspaceServer[]): WorkspaceServer[] {
  return [...servers].sort((a, b) => a.port - b.port);
}

/** The server the button opens by itself: the only one, when the gateway reaches it. Otherwise the button lists them. */
export function onlyServer(servers: readonly WorkspaceServer[]): WorkspaceServer | null {
  const [first] = servers;
  return servers.length === 1 && first?.reachable ? first : null;
}
