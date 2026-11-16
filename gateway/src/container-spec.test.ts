import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, MIB } from "./config.ts";
import { AGENT_KINDS, WORKSPACE_KINDS } from "@portal/db";
import { driverFor } from "./agents/index.ts";
import { qwenDriver } from "./agents/qwen.ts";
import { containerKind, containerName, workspaceContainerOptions, workspaceNetworkOptions } from "./container-spec.ts";
import { workspaceImage } from "./image-names.ts";

const config = loadConfig({
  GATEWAY_CONTROL_SECRET: "c".repeat(32),
  PORTAL_DATA_DIR: "/srv/workspace-portal",
  WORKSPACE_MEMORY: "2g",
  WORKSPACE_CPUS: "1.5",
  WORKSPACE_PIDS: "256",
  WORKSPACE_SHM: "512m",
  WORKSPACE_TMP: "256m",
  WORKSPACE_UID_BASE: "300000",
  ONLINE_UID_BASE: "400000",
  IDLE_TIMEOUT_MINUTES: "20",
});

const SANDBOX = {
  ReadonlyRootfs: true,
  Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${256 * MIB}` },
  NetworkMode: "workspace-portal-ws",
  Memory: 2048 * MIB,
  MemorySwap: 2560 * MIB,
  NanoCpus: 1.5e9,
  PidsLimit: 256,
  ShmSize: 512 * MIB,
  CapDrop: ["ALL"],
  SecurityOpt: ["no-new-privileges:true"],
  Init: false,
  OomScoreAdj: 500,
  RestartPolicy: { Name: "no" },
  LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
};

const start = (kind: "private" | "online" = "private", credential = "t", image = "i") => ({ kind, credential, image });

test("Qwen Code workspace containers follow the container spec", () => {
  assert.equal(containerName(42, "private"), "wp-ws-42");
  assert.deepEqual(workspaceContainerOptions(config, 42, qwenDriver, start("private", "per-start-token", "workspace-portal/workspace:qwen-0.27.4")), {
    name: "wp-ws-42",
    Hostname: "workspace",
    Image: "workspace-portal/workspace:qwen-0.27.4",
    User: "300042:300042",
    WorkingDir: "/workspace",
    Labels: {
      "workspace-portal.workspace": "1",
      "workspace-portal.user-id": "42",
      "workspace-portal.kind": "private",
      "workspace-portal.agent": "qwen",
      "workspace-portal.version": "0.27.4",
    },
    Env: [
      "PORTAL_LLM_KEY=portal",
      "HOME=/home/user",
      "USER=user",
      "LOGNAME=user",
      "QWEN_SERVER_TOKEN=per-start-token",
      "QWEN_USAGE_STATISTICS_ENABLED=false",
      `QWEN_PERMISSION_TIMEOUT_MS=${20 * 60_000}`,
    ],
    HostConfig: {
      Binds: [
        "/srv/workspace-portal/users/42/private/home:/home/user",
        "/srv/workspace-portal/users/42/private/workspace:/workspace",
        "/srv/workspace-portal/users/42/private/system/qwen:/etc/workspace-portal/qwen:ro",
        "/srv/workspace-portal/users/42/private/system/passwd:/etc/passwd:ro",
        "/srv/workspace-portal/users/42/private/system/group:/etc/group:ro",
      ],
      ...SANDBOX,
    },
  });
});

test("an Online container: its own name, UID, files, network and public DNS; the same sandbox otherwise", () => {
  assert.equal(containerName(42, "online"), "wp-wo-42");
  const options = workspaceContainerOptions(config, 42, qwenDriver, start("online", "per-start-token", "workspace-portal/workspace:qwen-0.27.4"));
  const { Binds, ...hostConfig } = options.HostConfig!;
  assert.equal(options.name, "wp-wo-42");
  assert.equal(options.User, "400042:400042");
  assert.equal(options.Labels!["workspace-portal.kind"], "online");
  assert.deepEqual(Binds, [
    "/srv/workspace-portal/users/42/online/home:/home/user",
    "/srv/workspace-portal/users/42/online/workspace:/workspace",
    "/srv/workspace-portal/users/42/online/system/qwen:/etc/workspace-portal/qwen:ro",
    "/srv/workspace-portal/users/42/online/system/passwd:/etc/passwd:ro",
    "/srv/workspace-portal/users/42/online/system/group:/etc/group:ro",
  ]);
  assert.deepEqual(hostConfig, { ...SANDBOX, NetworkMode: "workspace-portal-online", Dns: ["1.1.1.1", "9.9.9.9"], DnsSearch: ["."] });
  const privateOptions = workspaceContainerOptions(config, 42, qwenDriver, start("private", "per-start-token"));
  assert.equal(privateOptions.HostConfig!.Dns, undefined, "Private's internal network has no DNS");
  assert.deepEqual(options.Env, privateOptions.Env, "the same environment: the agent learns its service address from its settings");
});

test("a user's two kinds share no mount, no UID, no network and no name", () => {
  for (const agent of AGENT_KINDS) {
    const [a, b] = WORKSPACE_KINDS.map((kind) => workspaceContainerOptions(config, 9, driverFor(agent), start(kind)));
    const sources = (options: typeof a) => options!.HostConfig!.Binds!.map((bind) => bind.split(":")[0]!);
    for (const source of sources(a)) {
      assert.ok(!sources(b).some((other) => other.startsWith(source) || source.startsWith(other)), `${agent}: ${source}`);
    }
    assert.notEqual(a!.User, b!.User);
    assert.notEqual(a!.HostConfig!.NetworkMode, b!.HostConfig!.NetworkMode);
    assert.notEqual(a!.name, b!.name);
  }
  assert.equal(containerKind(undefined), "private", "containers from before kinds are Private");
  assert.equal(containerKind("online"), "online");
  assert.equal(containerKind("bogus"), null);
});

test("every agent gets the same sandbox: limits, no capabilities, read-only root, the internal network", () => {
  for (const kind of AGENT_KINDS) {
    const image = workspaceImage(kind, "1.2.3");
    const options = workspaceContainerOptions(config, 5, driverFor(kind), start("private", "t", image));
    const { Binds, ...hostConfig } = options.HostConfig!;
    assert.deepEqual(hostConfig, SANDBOX, kind);
    assert.equal(options.User, "300005:300005", kind);
    assert.equal(options.Image, image, `${kind}: the image the manager chose`);
    assert.equal(options.Labels!["workspace-portal.agent"], kind);
    assert.ok(Binds!.includes(`/srv/workspace-portal/users/5/private/system/${kind}:${driverFor(kind).settingsMount}:ro`), kind);
  }
});

test("a workspace only mounts its own user's directories of its kind, and only home and workspace are writable", () => {
  for (const kind of AGENT_KINDS) {
    for (const workspaceKind of WORKSPACE_KINDS) {
      for (const userId of [1, 7, 199]) {
        const binds = workspaceContainerOptions(config, userId, driverFor(kind), start(workspaceKind)).HostConfig!.Binds!;
        for (const bind of binds) {
          assert.ok(bind.startsWith(`/srv/workspace-portal/users/${userId}/${workspaceKind}/`), bind);
          const writable = !bind.endsWith(":ro");
          assert.equal(writable, /\/(home|workspace):\/(home\/user|workspace)$/.test(bind), bind);
        }
      }
    }
  }
  const a = workspaceContainerOptions(config, 1, qwenDriver, start());
  const b = workspaceContainerOptions(config, 2, qwenDriver, start());
  assert.notEqual(a.User, b.User, "no two workspaces share a UID");
});

test("each start carries its own credential, readable back from the environment", () => {
  for (const kind of AGENT_KINDS) {
    const driver = driverFor(kind);
    const env = workspaceContainerOptions(config, 3, driver, start("private", "second")).Env!;
    assert.equal(env.filter((entry) => entry.startsWith(`${driver.credentialEnv}=`)).length, 1, kind);
    assert.ok(env.includes(`${driver.credentialEnv}=second`), kind);
  }
});

test("the Private network is internal and has no inter-container traffic", () => {
  assert.deepEqual(workspaceNetworkOptions(config.workspace.kinds.private), {
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
  assert.deepEqual(workspaceNetworkOptions(config.workspace.kinds.online), {
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
