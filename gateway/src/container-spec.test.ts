import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";
import { containerName, TOKEN_ENV, workspaceContainerOptions, workspaceNetworkOptions } from "./container-spec.ts";

const MIB = 1024 * 1024;
const config = loadConfig({
  GATEWAY_CONTROL_SECRET: "c".repeat(32),
  PORTAL_DATA_DIR: "/srv/hp",
  WORKSPACE_MEMORY: "2g",
  WORKSPACE_CPUS: "1.5",
  WORKSPACE_PIDS: "256",
  WORKSPACE_SHM: "512m",
  WORKSPACE_TMP: "256m",
  WORKSPACE_UID_BASE: "300000",
  IDLE_TIMEOUT_MINUTES: "20",
});

test("workspace containers follow the container spec", () => {
  assert.equal(containerName(42), "wp-ws-42");
  assert.deepEqual(workspaceContainerOptions(config, 42, { token: "per-start-token" }), {
    name: "wp-ws-42",
    Hostname: "workspace",
    Image: "workspace-portal/workspace:qwen-0.27.0",
    User: "300042:300042",
    WorkingDir: "/workspace",
    Labels: { "workspace-portal.workspace": "1", "workspace-portal.user-id": "42" },
    Env: [
      "QWEN_SERVER_TOKEN=per-start-token",
      "PORTAL_LLM_KEY=portal",
      "HOME=/home/user",
      "USER=user",
      "LOGNAME=user",
      "QWEN_USAGE_STATISTICS_ENABLED=false",
      `QWEN_PERMISSION_TIMEOUT_MS=${20 * 60_000}`,
    ],
    HostConfig: {
      Binds: [
        "/srv/hp/users/42/home:/home/user",
        "/srv/hp/users/42/workspace:/workspace",
        "/srv/hp/users/42/system/qwen:/etc/workspace-portal/qwen:ro",
        "/srv/hp/users/42/system/passwd:/etc/passwd:ro",
        "/srv/hp/users/42/system/group:/etc/group:ro",
      ],
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
    },
  });
});

test("a workspace only mounts its own user's directories, and only home and workspace are writable", () => {
  for (const userId of [1, 7, 199]) {
    const binds = workspaceContainerOptions(config, userId, { token: "t" }).HostConfig!.Binds!;
    for (const bind of binds) {
      assert.ok(bind.startsWith(`/srv/hp/users/${userId}/`), bind);
      const writable = !bind.endsWith(":ro");
      assert.equal(writable, /\/(home|workspace):\/(home\/user|workspace)$/.test(bind), bind);
    }
  }
  const a = workspaceContainerOptions(config, 1, { token: "t" });
  const b = workspaceContainerOptions(config, 2, { token: "t" });
  assert.notEqual(a.User, b.User, "no two workspaces share a UID");
});

test("each start carries its own token, readable back from the environment", () => {
  const env = workspaceContainerOptions(config, 3, { token: "second" }).Env!;
  assert.equal(env.filter((entry) => entry.startsWith(`${TOKEN_ENV}=`)).length, 1);
  assert.ok(env.includes(`${TOKEN_ENV}=second`));
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
