// Whether the host firewall that fences the Online workspaces in (deploy/firewall.sh, nftables table
// inet workspace_portal) is loaded. Without it an Online container is on a Docker NAT bridge with nothing
// between it and the LAN, the LLM server or the host, so the gateway starts no Online workspace, and stops
// the running ones, unless this says "loaded" (WorkspaceManager). Private workspaces don't depend on it:
// their network is a Docker internal one.
//
// The gateway may not list the ruleset (that takes CAP_NET_ADMIN, which it doesn't have), so it asks the
// table's marker instead: the table's input chain refuses TCP to 127.0.0.1:SERVICE_PORT, where nothing
// listens, as "administratively prohibited". A connection there fails with EHOSTUNREACH while the table is
// loaded, and with ECONNREFUSED (or connects, should something listen there) without it. The gateway runs in
// the host's network namespace (network_mode: host), so it sees the host's loopback.
import net from "node:net";

/** "loaded": the marker answered. "missing": the table is not loaded. "unknown": no clear answer (taken as not loaded). */
export type FenceState = "loaded" | "missing" | "unknown";

const PROBE_TIMEOUT_MS = 2_000;

/** One look at the marker on 127.0.0.1:port. */
export function probeFence(port: number): Promise<FenceState> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (state: FenceState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => settle("unknown"), PROBE_TIMEOUT_MS);
    // Something listens there and nothing refused the connection: no marker.
    socket.once("connect", () => settle("missing"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "EHOSTUNREACH" ? "loaded" : error.code === "ECONNREFUSED" ? "missing" : "unknown");
    });
  });
}

/** The fence check WorkspaceManager uses: the marker of this gateway's SERVICE_PORT, asked twice before it says "unknown". */
export function fenceCheck(servicePort: number): () => Promise<FenceState> {
  return async () => {
    const first = await probeFence(servicePort);
    return first === "unknown" ? probeFence(servicePort) : first;
  };
}
