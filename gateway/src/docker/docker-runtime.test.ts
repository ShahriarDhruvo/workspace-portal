import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Docker from "dockerode";
import type { WorkspaceKind } from "@portal/core";
import { loadConfig } from "../config.ts";
import { workspaceNetworkOptions } from "./container-spec.ts";
import { cpuSeconds, demuxDockerLogs, DOCKER_API_TIMEOUT_MS, DockerRuntime, isSupportedDockerVersion, memoryUsage, networkMismatches } from "./docker-runtime.ts";

const config = loadConfig({ GATEWAY_CONTROL_SECRET: "c".repeat(32) });

function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function stats(partial: object): Docker.ContainerStats {
  return partial as Docker.ContainerStats;
}

test("demuxDockerLogs joins stdout and stderr frames", () => {
  const logs = Buffer.concat([frame(1, "starting qwen serve\n"), frame(2, "warn: x\n"), frame(1, "listening\n")]);
  assert.equal(demuxDockerLogs(logs), "starting qwen serve\nwarn: x\nlistening\n");
  assert.equal(demuxDockerLogs(Buffer.alloc(0)), "");
});

test("demuxDockerLogs passes TTY output through", () => {
  assert.equal(demuxDockerLogs(Buffer.from("plain tty output\n")), "plain tty output\n");
  const truncated = frame(1, "hello").subarray(0, 10);
  assert.equal(demuxDockerLogs(truncated), truncated.toString("utf8"));
});

test("memoryUsage subtracts reclaimable cache (cgroup v2 and v1)", () => {
  assert.equal(memoryUsage(stats({ memory_stats: { usage: 1000, stats: { inactive_file: 300 } } })), 700);
  assert.equal(memoryUsage(stats({ memory_stats: { usage: 1000, stats: { total_inactive_file: 100 } } })), 900);
  assert.equal(memoryUsage(stats({ memory_stats: { usage: 1000 } })), 1000);
  assert.equal(memoryUsage(stats({ memory_stats: {} })), null);
});

test("cpuSeconds reads the cumulative CPU time", () => {
  assert.equal(cpuSeconds(stats({ cpu_stats: { cpu_usage: { total_usage: 2.5e9 } } })), 2.5);
  assert.equal(cpuSeconds(stats({ cpu_stats: {} })), null);
});

// ------------------------------------------------------------------ the workspace networks

/** What `docker network inspect` reports for the network the gateway creates for a kind. */
function createdNetwork(kind: WorkspaceKind = "private"): Docker.NetworkInspectInfo {
  const own = config.workspace.kinds[kind];
  const options = workspaceNetworkOptions(own);
  return {
    Name: options.Name,
    Id: "net-1",
    Created: "2026-01-01T00:00:00Z",
    Scope: "local",
    Driver: "bridge",
    EnableIPv6: false,
    IPAM: { Driver: "default", Config: [{ Subnet: own.subnet, Gateway: own.gatewayIp, IPRange: own.ipRange }] },
    Internal: kind === "private",
    Attachable: false,
    Ingress: false,
    ConfigOnly: false,
    Containers: {},
    Options: { ...options.Options },
    Labels: { ...options.Labels },
  };
}

/** A dockerode stand-in with one network (or none), recording what the gateway does to it. */
function fakeDocker(network: Docker.NetworkInspectInfo | null, kind: WorkspaceKind = "private") {
  const calls: string[] = [];
  const docker = {
    getNetwork(name: string) {
      return {
        async inspect() {
          calls.push(`inspect ${name}`);
          if (!network) throw Object.assign(new Error("no such network"), { statusCode: 404 });
          return network;
        },
        async remove() {
          calls.push(`remove ${name}`);
        },
      };
    },
    async createNetwork(options: Docker.NetworkCreateOptions) {
      calls.push(`create ${options.Name}`);
      assert.deepEqual(options, workspaceNetworkOptions(config.workspace.kinds[kind]));
    },
    async version() {
      return { Version: "26.1.4", ApiVersion: "1.45" };
    },
  };
  return { calls, runtime: new DockerRuntime(config, docker as unknown as Docker) };
}

test("ensureNetwork creates each kind's network, and keeps one that matches", async () => {
  for (const [kind, name] of [["private", "workspace-portal-ws"], ["online", "workspace-portal-online"]] as const) {
    const missing = fakeDocker(null, kind);
    assert.equal(await missing.runtime.ensureNetwork(kind), "created");
    assert.deepEqual(missing.calls, [`inspect ${name}`, `create ${name}`]);

    const matching = fakeDocker(createdNetwork(kind), kind);
    assert.equal(await matching.runtime.ensureNetwork(kind), "exists");
    assert.deepEqual(matching.calls, [`inspect ${name}`]);
  }
});

/** Changes that make a network another than the one the gateway creates, for either kind. */
const COMMON_VARIANTS: Array<[string, (network: Docker.NetworkInspectInfo) => void]> = [
  ["ICC on", (n) => void (n.Options!["com.docker.network.bridge.enable_icc"] = "true")],
  ["ICC unset (Docker's default is on)", (n) => void delete n.Options!["com.docker.network.bridge.enable_icc"]],
  ["another bridge name (the firewall would not match it)", (n) => void (n.Options!["com.docker.network.bridge.name"] = "docker1")],
  ["no bridge name", (n) => void delete n.Options!["com.docker.network.bridge.name"]],
  ["IPv6", (n) => void (n.EnableIPv6 = true)],
  ["another driver", (n) => void (n.Driver = "macvlan")],
  ["another subnet", (n) => void (n.IPAM!.Config![0]!.Subnet = "172.30.0.0/16")],
  ["another gateway", (n) => void (n.IPAM!.Config![0]!.Gateway = "172.29.0.254")],
  ["another IP range", (n) => void (n.IPAM!.Config![0]!.IPRange = "172.29.0.0/16")],
  ["no IP range", (n) => void delete n.IPAM!.Config![0]!.IPRange],
  ["a second pool", (n) => void n.IPAM!.Config!.push({ Subnet: "10.9.0.0/16" })],
  ["no IPAM", (n) => void delete n.IPAM],
  ["no options", (n) => void delete n.Options],
];

test("ensureNetwork replaces an unused Private network that differs in any isolation or address setting", async () => {
  const variants: Array<[string, (network: Docker.NetworkInspectInfo) => void]> = [
    ...COMMON_VARIANTS,
    ["not internal", (n) => void (n.Internal = false)],
    ["masquerade on", (n) => void (n.Options!["com.docker.network.bridge.enable_ip_masquerade"] = "true")],
    ["masquerade unset (Docker's default is on)", (n) => void delete n.Options!["com.docker.network.bridge.enable_ip_masquerade"]],
  ];
  for (const [what, change] of variants) {
    const network = createdNetwork();
    change(network);
    const { calls, runtime } = fakeDocker(network);
    assert.equal(await runtime.ensureNetwork("private"), "replaced", what);
    assert.deepEqual(calls, ["inspect workspace-portal-ws", "remove workspace-portal-ws", "create workspace-portal-ws"], what);
  }
});

test("ensureNetwork replaces an unused Online network that differs in any attribute: internal, no masquerade, ICC, IPv6, addresses", async () => {
  const variants: Array<[string, (network: Docker.NetworkInspectInfo) => void]> = [
    ...COMMON_VARIANTS,
    ["internal (no way out)", (n) => void (n.Internal = true)],
    ["masquerade off", (n) => void (n.Options!["com.docker.network.bridge.enable_ip_masquerade"] = "false")],
    ["masquerade unset", (n) => void delete n.Options!["com.docker.network.bridge.enable_ip_masquerade"]],
    ["the Private bridge's name", (n) => void (n.Options!["com.docker.network.bridge.name"] = "br-wportal")],
  ];
  for (const [what, change] of variants) {
    const network = createdNetwork("online");
    change(network);
    assert.notDeepEqual(networkMismatches(network, config.workspace.kinds.online), [], what);
    const { calls, runtime } = fakeDocker(network, "online");
    assert.equal(await runtime.ensureNetwork("online"), "replaced", what);
    assert.deepEqual(calls, ["inspect workspace-portal-online", "remove workspace-portal-online", "create workspace-portal-online"], what);
  }
  assert.deepEqual(networkMismatches(createdNetwork("online"), config.workspace.kinds.online), []);
  assert.deepEqual(networkMismatches(createdNetwork("online"), config.workspace.kinds.private).length > 3, true, "the Online network is never taken for the Private one");
});

test("ensureNetwork refuses a differing network that containers use, and says how it differs", async () => {
  const network = createdNetwork();
  network.Options!["com.docker.network.bridge.name"] = "docker1";
  network.IPAM!.Config![0]!.Subnet = "172.30.0.0/16";
  network.Containers = { abc: { Name: "wp-ws-1", EndpointID: "e", MacAddress: "m", IPv4Address: "172.30.128.2/16", IPv6Address: "" } };
  const { calls, runtime } = fakeDocker(network);
  await assert.rejects(runtime.ensureNetwork("private"), {
    message:
      'docker network workspace-portal-ws is not the private workspace network the gateway creates (bridge name is "docker1", expected "br-wportal"; ' +
      'Subnet is "172.30.0.0/16", expected "172.29.0.0/16") and containers use it; stop them and remove the network',
  });
  assert.deepEqual(calls, ["inspect workspace-portal-ws"], "nothing was removed or created");
});

// ------------------------------------------------------------------ workspace containers

/** A dockerode stand-in for containers: records removals and creations, lists the given rows. */
function containerDocker(rows: unknown[] = []) {
  const calls: string[] = [];
  const created: Docker.ContainerCreateOptions[] = [];
  const docker = {
    getContainer(id: string) {
      return {
        async remove() {
          calls.push(`remove ${id}`);
          throw Object.assign(new Error("no such container"), { statusCode: 404 });
        },
      };
    },
    async createContainer(options: Docker.ContainerCreateOptions) {
      created.push(options);
      calls.push(`create ${options.name}`);
      return {
        id: `id-${options.name}`,
        async start() {},
        async inspect() {
          return { NetworkSettings: { Networks: { [options.HostConfig!.NetworkMode!]: { IPAddress: "172.28.128.2" } } } };
        },
      };
    },
    async listContainers() {
      return rows;
    },
  };
  return { calls, created, runtime: new DockerRuntime(config, docker as unknown as Docker) };
}

test("a start removes whatever is left of either kind first, then creates its own kind's container", async () => {
  const { calls, created, runtime } = containerDocker();
  const started = await runtime.startWorkspace(7, { kind: "online", agent: "qwen", credential: "c", image: "workspace-portal/workspace:qwen-0.27.0" });
  assert.deepEqual(calls, ["remove wp-ws-7", "remove wp-wo-7", "create wp-wo-7"]);
  assert.equal(created[0]!.HostConfig!.NetworkMode, "workspace-portal-online");
  assert.deepEqual(started, { id: "id-wp-wo-7", ip: "172.28.128.2", port: 4170 });
});

test("list reads each container's kind from its label, and its address on its own kind's network only", async () => {
  const row = (id: string, labels: Record<string, string>, networks: Record<string, string>) => ({
    Id: id,
    Labels: { "workspace-portal.workspace": "1", "workspace-portal.user-id": "3", ...labels },
    State: "running",
    Image: "workspace-portal/workspace:qwen-0.27.0",
    NetworkSettings: { Networks: Object.fromEntries(Object.entries(networks).map(([name, ip]) => [name, { IPAddress: ip }])) },
  });
  const { runtime } = containerDocker([
    row("unlabelled", {}, { "workspace-portal-ws": "172.29.128.1" }),
    row("private", { "workspace-portal.kind": "private" }, { "workspace-portal-ws": "172.29.128.2" }),
    row("on",{ "workspace-portal.kind": "online" }, { "workspace-portal-online": "172.28.128.2" }),
    // An Online container somehow also on the Private network: only its Online address is its own.
    row("both", { "workspace-portal.kind": "online" }, { "workspace-portal-ws": "172.29.128.9" }),
    row("odd", { "workspace-portal.kind": "public" }, { "workspace-portal-ws": "172.29.128.3" }),
  ]);
  const listed = await runtime.list();
  assert.deepEqual(
    listed.map(({ id, kind, ip }) => ({ id, kind, ip })),
    [
      { id: "unlabelled", kind: null, ip: null },
      { id: "private", kind: "private", ip: "172.29.128.2" },
      { id: "on", kind: "online", ip: "172.28.128.2" },
      { id: "both", kind: "online", ip: null },
      { id: "odd", kind: null, ip: null },
    ],
  );
});

// ------------------------------------------------------------------ the engine

test("isSupportedDockerVersion: 25.0.5 and later; older or unparseable versions are refused", () => {
  for (const version of ["25.0.5", "25.0.14", "25.1.0", "26.0.0", "26.1.4", "27.0.0-rc.1", "28.3.2", " 29.0.1 "]) {
    assert.equal(isSupportedDockerVersion(version), true, version);
  }
  for (const version of ["25.0.4", "24.0.9", "23.0.11", "20.10.24+dfsg1", "1.13.1", "", "dev", "26.1", "v26.1.4"]) {
    assert.equal(isSupportedDockerVersion(version), false, version);
  }
});

test("engineVersion reads the server version", async () => {
  assert.equal(await fakeDocker(null).runtime.engineVersion(), "26.1.4");
});

test("a Docker API call that never answers fails after the client timeout instead of hanging", async () => {
  assert.ok(DOCKER_API_TIMEOUT_MS > 10_000 + 20_000, "well above stop -t 10");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-hang-"));
  const socketPath = path.join(dir, "docker.sock");
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => void sockets.push(socket)); // accepts, never answers
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const runtime = new DockerRuntime(config, new Docker({ socketPath, timeout: 200 }));
    const started = Date.now();
    await assert.rejects(runtime.list());
    assert.ok(Date.now() - started < 5_000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
