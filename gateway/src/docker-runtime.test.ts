import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Docker from "dockerode";
import { loadConfig } from "./config.ts";
import { workspaceNetworkOptions } from "./container-spec.ts";
import { cpuSeconds, demuxDockerLogs, DOCKER_API_TIMEOUT_MS, DockerRuntime, isSupportedDockerVersion, memoryUsage } from "./docker-runtime.ts";

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

// ------------------------------------------------------------------ the workspace network

/** What `docker network inspect` reports for the network the gateway creates. */
function createdNetwork(): Docker.NetworkInspectInfo {
  const options = workspaceNetworkOptions(config.workspace);
  return {
    Name: options.Name,
    Id: "net-1",
    Created: "2026-01-01T00:00:00Z",
    Scope: "local",
    Driver: "bridge",
    EnableIPv6: false,
    IPAM: { Driver: "default", Config: [{ Subnet: "172.29.0.0/16", Gateway: "172.29.0.1", IPRange: "172.29.128.0/17" }] },
    Internal: true,
    Attachable: false,
    Ingress: false,
    ConfigOnly: false,
    Containers: {},
    Options: { ...options.Options },
    Labels: { ...options.Labels },
  };
}

/** A dockerode stand-in with one network (or none), recording what the gateway does to it. */
function fakeDocker(network: Docker.NetworkInspectInfo | null) {
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
      assert.deepEqual(options, workspaceNetworkOptions(config.workspace));
    },
    async version() {
      return { Version: "26.1.4", ApiVersion: "1.45" };
    },
  };
  return { calls, runtime: new DockerRuntime(config, docker as unknown as Docker) };
}

test("ensureNetwork creates the network, and keeps one that matches", async () => {
  const missing = fakeDocker(null);
  assert.equal(await missing.runtime.ensureNetwork(), "created");
  assert.deepEqual(missing.calls, ["inspect workspace-portal-ws", "create workspace-portal-ws"]);

  const matching = fakeDocker(createdNetwork());
  assert.equal(await matching.runtime.ensureNetwork(), "exists");
  assert.deepEqual(matching.calls, ["inspect workspace-portal-ws"]);
});

test("ensureNetwork replaces an unused network that differs in any isolation or address setting", async () => {
  const variants: Array<[string, (network: Docker.NetworkInspectInfo) => void]> = [
    ["not internal", (n) => void (n.Internal = false)],
    ["ICC on", (n) => void (n.Options!["com.docker.network.bridge.enable_icc"] = "true")],
    ["another bridge name (the firewall would not match it)", (n) => void (n.Options!["com.docker.network.bridge.name"] = "docker1")],
    ["no bridge name", (n) => void delete n.Options!["com.docker.network.bridge.name"]],
    ["masquerade on", (n) => void (n.Options!["com.docker.network.bridge.enable_ip_masquerade"] = "true")],
    ["masquerade unset (Docker's default is on)", (n) => void delete n.Options!["com.docker.network.bridge.enable_ip_masquerade"]],
    ["IPv6", (n) => void (n.EnableIPv6 = true)],
    ["another subnet", (n) => void (n.IPAM!.Config![0]!.Subnet = "172.30.0.0/16")],
    ["another gateway", (n) => void (n.IPAM!.Config![0]!.Gateway = "172.29.0.254")],
    ["another IP range", (n) => void (n.IPAM!.Config![0]!.IPRange = "172.29.0.0/16")],
    ["no IP range", (n) => void delete n.IPAM!.Config![0]!.IPRange],
    ["a second pool", (n) => void n.IPAM!.Config!.push({ Subnet: "10.9.0.0/16" })],
    ["no IPAM", (n) => void delete n.IPAM],
    ["no options", (n) => void delete n.Options],
  ];
  for (const [what, change] of variants) {
    const network = createdNetwork();
    change(network);
    const { calls, runtime } = fakeDocker(network);
    assert.equal(await runtime.ensureNetwork(), "replaced", what);
    assert.deepEqual(calls, ["inspect workspace-portal-ws", "remove workspace-portal-ws", "create workspace-portal-ws"], what);
  }
});

test("ensureNetwork refuses a differing network that containers use, and says how it differs", async () => {
  const network = createdNetwork();
  network.Options!["com.docker.network.bridge.name"] = "docker1";
  network.IPAM!.Config![0]!.Subnet = "172.30.0.0/16";
  network.Containers = { abc: { Name: "wp-ws-1", EndpointID: "e", MacAddress: "m", IPv4Address: "172.30.128.2/16", IPv6Address: "" } };
  const { calls, runtime } = fakeDocker(network);
  await assert.rejects(runtime.ensureNetwork(), {
    message:
      'docker network workspace-portal-ws is not the isolated workspace network (bridge name is "docker1", expected "br-wportal"; ' +
      'Subnet is "172.30.0.0/16", expected "172.29.0.0/16") and containers use it; stop them and remove the network',
  });
  assert.deepEqual(calls, ["inspect workspace-portal-ws"], "nothing was removed or created");
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
