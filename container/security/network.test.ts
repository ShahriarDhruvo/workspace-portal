import { test } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import { networkMismatches, workspaceNetworkOptions, type KindNetwork } from "./network.ts";

const PRIVATE: KindNetwork = { kind: "private", network: "workspace-portal-ws", subnet: "172.29.0.0/16", gatewayIp: "172.29.0.1", ipRange: "172.29.128.0/17", bridge: "br-wportal", dns: [] };
const ONLINE: KindNetwork = { kind: "online", network: "workspace-portal-online", subnet: "172.28.0.0/16", gatewayIp: "172.28.0.1", ipRange: "172.28.128.0/17", bridge: "br-wonline", dns: ["9.9.9.9"] };

test("the Private network is internal and has no inter-container traffic", () => {
  assert.deepEqual(workspaceNetworkOptions(PRIVATE), {
    Name: "workspace-portal-ws",
    Driver: "bridge",
    Internal: true,
    EnableIPv6: false,
    Options: {
      "com.docker.network.bridge.name": "br-wportal",
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.enable_ip_masquerade": "false",
    },
    IPAM: { Driver: "default", Config: [{ Subnet: "172.29.0.0/16", Gateway: "172.29.0.1", IPRange: "172.29.128.0/17" }] },
    Labels: { "workspace-portal.network": "1", "workspace-portal.kind": "private" },
  });
});

test("the Online network reaches out through NAT, with no inter-container traffic and no IPv6", () => {
  assert.deepEqual(workspaceNetworkOptions(ONLINE), {
    Name: "workspace-portal-online",
    Driver: "bridge",
    Internal: false,
    EnableIPv6: false,
    Options: {
      "com.docker.network.bridge.name": "br-wonline",
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.enable_ip_masquerade": "true",
    },
    IPAM: { Driver: "default", Config: [{ Subnet: "172.28.0.0/16", Gateway: "172.28.0.1", IPRange: "172.28.128.0/17" }] },
    Labels: { "workspace-portal.network": "1", "workspace-portal.kind": "online" },
  });
});

test("networkMismatches: a network as created matches its own kind only, and each difference is named", () => {
  const created = (own: KindNetwork) => workspaceNetworkOptions(own) as unknown as Docker.NetworkInspectInfo;
  assert.deepEqual(networkMismatches(created(PRIVATE), PRIVATE), []);
  assert.deepEqual(networkMismatches(created(ONLINE), ONLINE), []);
  assert.deepEqual(networkMismatches(created(ONLINE), PRIVATE), [
    "Internal is false, expected true",
    'bridge name is "br-wonline", expected "br-wportal"',
    'enable_ip_masquerade is "true", expected "false"',
    'Subnet is "172.28.0.0/16", expected "172.29.0.0/16"',
    'Gateway is "172.28.0.1", expected "172.29.0.1"',
    'IPRange is "172.28.128.0/17", expected "172.29.128.0/17"',
  ]);
  assert.deepEqual(networkMismatches({ ...created(PRIVATE), EnableIPv6: true, IPAM: { Config: [] } } as Docker.NetworkInspectInfo, PRIVATE), [
    "EnableIPv6 is true, expected false",
    "it has 0 IPAM pools, expected 1",
  ]);
});
