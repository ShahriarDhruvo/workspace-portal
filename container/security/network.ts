// The two workspace networks, one per kind, both without inter-container traffic and without IPv6.
//   * Private: internal (no route off the host). The host side of the bridge (WORKSPACE_GATEWAY_IP) is the one
//     address its workspaces can reach, and firewall.sh limits that to the gateway's service port.
//   * Online: a bridge with masquerading (NAT) to the internet. firewall.sh lets it reach public addresses (any TCP
//     port, DNS to ONLINE_DNS_1/2) and ONLINE_GATEWAY_IP:SERVICE_PORT, and nothing else: not the LAN, the host, the
//     other workspaces or the stack's own containers.
import type Docker from "dockerode";
import type { WorkspaceKind } from "@portal/core";
import { KIND_LABEL } from "./spec.ts";

export interface KindNetwork {
  kind: WorkspaceKind;
  network: string;
  subnet: string;
  /** The host's address on the network: the service API listens here for this kind's containers. */
  gatewayIp: string;
  ipRange: string;
  bridge: string;
  /** Its containers' DNS servers; none for Private. */
  dns: readonly string[];
}

export function workspaceNetworkOptions(own: KindNetwork): Docker.NetworkCreateOptions {
  const online = own.kind === "online";
  return {
    Name: own.network,
    Driver: "bridge",
    Internal: !online,
    EnableIPv6: false,
    Options: {
      "com.docker.network.bridge.name": own.bridge,
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.enable_ip_masquerade": online ? "true" : "false",
    },
    IPAM: { Driver: "default", Config: [{ Subnet: own.subnet, Gateway: own.gatewayIp, IPRange: own.ipRange }] },
    Labels: { "workspace-portal.network": "1", [KIND_LABEL]: own.kind },
  };
}

/**
 * How an existing network differs from what workspaceNetworkOptions creates for the kind, attribute by attribute;
 * empty when it matches.
 */
export function networkMismatches(network: Docker.NetworkInspectInfo, own: KindNetwork): string[] {
  const options = network.Options ?? {};
  const online = own.kind === "online";
  const problems: string[] = [];
  const expect = (what: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected) problems.push(`${what} is ${JSON.stringify(actual ?? null)}, expected ${JSON.stringify(expected)}`);
  };
  expect("Driver", network.Driver, "bridge");
  expect("Internal", network.Internal === true, !online);
  expect("EnableIPv6", network.EnableIPv6 === true, false);
  expect("bridge name", options["com.docker.network.bridge.name"], own.bridge);
  expect("enable_icc", options["com.docker.network.bridge.enable_icc"], "false");
  expect("enable_ip_masquerade", options["com.docker.network.bridge.enable_ip_masquerade"], online ? "true" : "false");
  const pools = network.IPAM?.Config ?? [];
  if (pools.length !== 1) problems.push(`it has ${pools.length} IPAM pools, expected 1`);
  const pool = pools[0];
  if (pool) {
    expect("Subnet", pool.Subnet, own.subnet);
    expect("Gateway", pool.Gateway, own.gatewayIp);
    expect("IPRange", pool.IPRange, own.ipRange);
  }
  return problems;
}
