import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, MIB } from "./config.ts";
import { AGENT_KINDS } from "@portal/db";
import { driverFor } from "./agents/index.ts";
import { qwenDriver } from "./agents/qwen.ts";
import { containerName, workspaceContainerOptions, workspaceNetworkOptions } from "./container-spec.ts";

const config = loadConfig({
  GATEWAY_CONTROL_SECRET: "c".repeat(32),
  PORTAL_DATA_DIR: "/srv/workspace-portal",
  WORKSPACE_MEMORY: "2g",
  WORKSPACE_CPUS: "1.5",
  WORKSPACE_PIDS: "256",
  WORKSPACE_SHM: "512m",
  WORKSPACE_TMP: "256m",
  WORKSPACE_UID_BASE: "300000",
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

test("Qwen Code workspace containers follow the container spec", () => {
  assert.equal(containerName(42), "wp-ws-42");
  assert.deepEqual(workspaceContainerOptions(config, 42, qwenDriver, "per-start-token"), {
    name: "wp-ws-42",
    Hostname: "workspace",
    Image: "workspace-portal/workspace:qwen-0.27.0",
    User: "300042:300042",
    WorkingDir: "/workspace",
    Labels: { "workspace-portal.workspace": "1", "workspace-portal.user-id": "42", "workspace-portal.agent": "qwen" },
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
        "/srv/workspace-portal/users/42/home:/home/user",
        "/srv/workspace-portal/users/42/workspace:/workspace",
        "/srv/workspace-portal/users/42/system/qwen:/etc/workspace-portal/qwen:ro",
        "/srv/workspace-portal/users/42/system/passwd:/etc/passwd:ro",
        "/srv/workspace-portal/users/42/system/group:/etc/group:ro",
      ],
      ...SANDBOX,
    },
  });
});

test("every agent gets the same sandbox: limits, no capabilities, read-only root, the internal network", () => {
  for (const kind of AGENT_KINDS) {
    const options = workspaceContainerOptions(config, 5, driverFor(kind), "t");
    const { Binds, ...hostConfig } = options.HostConfig!;
    assert.deepEqual(hostConfig, SANDBOX, kind);
    assert.equal(options.User, "300005:300005", kind);
    assert.equal(options.Image, config.workspace.images[kind].image, kind);
    assert.equal(options.Labels!["workspace-portal.agent"], kind);
    assert.ok(Binds!.includes(`/srv/workspace-portal/users/5/system/${kind}:${driverFor(kind).settingsMount}:ro`), kind);
  }
});

test("a workspace only mounts its own user's directories, and only home and workspace are writable", () => {
  for (const kind of AGENT_KINDS) {
    for (const userId of [1, 7, 199]) {
      const binds = workspaceContainerOptions(config, userId, driverFor(kind), "t").HostConfig!.Binds!;
      for (const bind of binds) {
        assert.ok(bind.startsWith(`/srv/workspace-portal/users/${userId}/`), bind);
        const writable = !bind.endsWith(":ro");
        assert.equal(writable, /\/(home|workspace):\/(home\/user|workspace)$/.test(bind), bind);
      }
    }
  }
  const a = workspaceContainerOptions(config, 1, qwenDriver, "t");
  const b = workspaceContainerOptions(config, 2, qwenDriver, "t");
  assert.notEqual(a.User, b.User, "no two workspaces share a UID");
});

test("each start carries its own credential, readable back from the environment", () => {
  for (const kind of AGENT_KINDS) {
    const driver = driverFor(kind);
    const env = workspaceContainerOptions(config, 3, driver, "second").Env!;
    assert.equal(env.filter((entry) => entry.startsWith(`${driver.credentialEnv}=`)).length, 1, kind);
    assert.ok(env.includes(`${driver.credentialEnv}=second`), kind);
  }
});

test("the workspace network is internal and has no inter-container traffic", () => {
  assert.deepEqual(workspaceNetworkOptions(config.workspace), {
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
    Labels: { "workspace-portal.network": "1" },
  });
});
