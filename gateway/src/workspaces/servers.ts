// The web servers running in a workspace: the TCP ports something in it listens on, read from the kernel's own
// tables as the container sees them (/proc/net/tcp and /proc/net/tcp6). The portal's Preview button offers them, and
// the preview port shows them (proxy/preview-proxy.ts). The text comes out of a workspace, so nothing but lines of
// the kernel's exact form is read.
import type { WorkspaceServer } from "@portal/core";

/** The first port a workspace's server may listen on: the ports below need root, and nothing in a workspace is root. */
export const FIRST_SERVER_PORT = 1024;
/** Ports the kernel hands to a socket that asked for none (net.ipv4.ip_local_port_range's default) start here. */
const FIRST_EPHEMERAL_PORT = 32_768;
/** More than a workspace's web servers ever are; a table that lists more is cut here, lowest ports first. */
export const MAX_SERVERS = 32;

/** `<address>:<port>` of the local and the remote end, then the state: 0A is TCP_LISTEN. */
const LISTENING = /^\s*\d+: ([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4}) [0-9A-F]+:[0-9A-F]{4} 0A /;
const ANY = /^0+$/;
/** ::ffff:a.b.c.d, the form an IPv6 socket has an IPv4 address in. */
const MAPPED = /^0{16}FFFF0000([0-9A-F]{8})$/;
const LOOPBACK6 = `${"0".repeat(24)}01000000`;

/** An address word as the kernel prints it on the machines the portal runs on (little-endian): 0100007F is 127.0.0.1. */
function ipv4(hex: string): string {
  return [6, 4, 2, 0].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(".");
}

/**
 * The servers `tables` lists, by port, without the agent's own, each with whether the gateway can reach it: it
 * connects to `containerIp`, so a server has to listen on every address or on that one. A server on localhost only
 * is still listed, for the person to see why it can't be opened, unless the kernel picked its port: that is a
 * helper's (a debugger, a browser's control port, Docker's resolver), not a web server someone started.
 */
export function listeningServers(tables: string, containerIp: string, agentPort: number): WorkspaceServer[] {
  const reachable = new Map<number, boolean>();
  for (const line of tables.split("\n")) {
    const match = LISTENING.exec(line);
    if (!match) continue;
    const port = Number.parseInt(match[2]!, 16);
    if (port < FIRST_SERVER_PORT || port === agentPort) continue;
    const address = match[1]!;
    const v4 = address.length === 8 ? address : MAPPED.exec(address)?.[1];
    const local = v4 === undefined ? address === LOOPBACK6 : ipv4(v4).startsWith("127.");
    const open = ANY.test(address) || (v4 !== undefined && ipv4(v4) === containerIp);
    if (!open && !(local && port < FIRST_EPHEMERAL_PORT)) continue;
    reachable.set(port, open || reachable.get(port) === true);
  }
  return [...reachable]
    .sort(([a], [b]) => a - b)
    .slice(0, MAX_SERVERS)
    .map(([port, open]) => ({ port, reachable: open }));
}
