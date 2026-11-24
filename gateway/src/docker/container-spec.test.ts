import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadConfig, MIB } from "../config.ts";
import { AGENT_KINDS, WORKSPACE_REFS, sameWorkspace, type WorkspaceRef } from "@portal/core";
import { driverFor } from "../agents/index.ts";
import { containerName, workspaceContainerOptions, workspaceNetworkOptions } from "./container-spec.ts";
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

const QWEN_PRIVATE: WorkspaceRef = { agent: "qwen", kind: "private" };
const QWEN_ONLINE: WorkspaceRef = { agent: "qwen", kind: "online" };
const start = (ref: WorkspaceRef = QWEN_PRIVATE, credential = "t", image = "i") => ({ ref, credential, image });

test("Qwen Code workspace containers follow the container spec", () => {
  assert.equal(containerName(42, QWEN_PRIVATE), "wp-qwen-private-42");
  assert.deepEqual(workspaceContainerOptions(config, 42, start(QWEN_PRIVATE, "per-start-token", "workspace-portal/workspace:qwen-0.27.4")), {
    name: "wp-qwen-private-42",
    Hostname: "workspace",
    Image: "workspace-portal/workspace:qwen-0.27.4",
    User: "300840:300840",
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
      `WORKSPACE_PORTAL_UPLOAD_LIMIT_BYTES=${10240 * MIB}`,
    ],
    HostConfig: {
      Binds: [
        "/srv/workspace-portal/users/42/qwen/private/home:/home/user",
        "/srv/workspace-portal/users/42/qwen/private/workspace:/workspace",
        "/srv/workspace-portal/users/42/qwen/private/system/settings:/etc/workspace-portal/qwen:ro",
        "/srv/workspace-portal/users/42/qwen/private/system/passwd:/etc/passwd:ro",
        "/srv/workspace-portal/users/42/qwen/private/system/group:/etc/group:ro",
      ],
      ...SANDBOX,
    },
  });
});

test("an Online container: its own name, UID, files, network and public DNS; the same sandbox otherwise", () => {
  assert.equal(containerName(42, QWEN_ONLINE), "wp-qwen-online-42");
  const options = workspaceContainerOptions(config, 42, start(QWEN_ONLINE, "per-start-token", "workspace-portal/workspace:qwen-0.27.4"));
  const { Binds, ...hostConfig } = options.HostConfig!;
  assert.equal(options.name, "wp-qwen-online-42");
  assert.equal(options.User, "300841:300841");
  assert.equal(options.Labels!["workspace-portal.kind"], "online");
  assert.deepEqual(Binds, [
    "/srv/workspace-portal/users/42/qwen/online/home:/home/user",
    "/srv/workspace-portal/users/42/qwen/online/workspace:/workspace",
    "/srv/workspace-portal/users/42/qwen/online/system/settings:/etc/workspace-portal/qwen:ro",
    "/srv/workspace-portal/users/42/qwen/online/system/passwd:/etc/passwd:ro",
    "/srv/workspace-portal/users/42/qwen/online/system/group:/etc/group:ro",
  ]);
  assert.deepEqual(hostConfig, { ...SANDBOX, NetworkMode: "workspace-portal-online", Dns: ["1.1.1.1", "9.9.9.9"], DnsSearch: ["."] });
  const privateOptions = workspaceContainerOptions(config, 42, start(QWEN_PRIVATE, "per-start-token"));
  assert.equal(privateOptions.HostConfig!.Dns, undefined, "Private's internal network has no DNS");
  assert.deepEqual(options.Env, privateOptions.Env, "the same environment: the agent learns its service address from its settings");
});

test("a user's workspaces share no mount, no UID and no name, whichever agents and kinds they are", () => {
  const all = WORKSPACE_REFS.map((ref) => ({ ref, options: workspaceContainerOptions(config, 9, start(ref)) }));
  const sources = (options: (typeof all)[number]["options"]) => options.HostConfig!.Binds!.map((bind) => bind.split(":")[0]!);
  for (const a of all) {
    for (const b of all) {
      if (sameWorkspace(a.ref, b.ref)) continue;
      const pair = `${a.options.name} / ${b.options.name}`;
      for (const source of sources(a.options)) {
        assert.ok(!sources(b.options).some((other) => `${other}/`.startsWith(`${source}/`) || `${source}/`.startsWith(`${other}/`)), `${pair}: ${source}`);
      }
      assert.notEqual(a.options.User, b.options.User, pair);
      assert.notEqual(a.options.name, b.options.name, pair);
      // What the kinds differ in; an agent's two kinds are on different networks, two agents of a kind on the same one.
      assert.equal(a.options.HostConfig!.NetworkMode === b.options.HostConfig!.NetworkMode, a.ref.kind === b.ref.kind, pair);
    }
  }
});

test("every agent gets the same sandbox: limits, no capabilities, read-only root, the internal network", () => {
  for (const agent of AGENT_KINDS) {
    const image = workspaceImage(agent, "1.2.3");
    const options = workspaceContainerOptions(config, 5, start({ agent, kind: "private" }, "t", image));
    const { Binds, ...hostConfig } = options.HostConfig!;
    assert.deepEqual(hostConfig, SANDBOX, agent);
    assert.equal(options.Image, image, `${agent}: the image the manager chose`);
    assert.equal(options.Labels!["workspace-portal.agent"], agent);
    assert.ok(Binds!.includes(`/srv/workspace-portal/users/5/${agent}/private/system/settings:${driverFor(agent).settingsMount}:ro`), agent);
  }
});

test("a workspace only mounts its own directories, and only home and workspace are writable", () => {
  for (const ref of WORKSPACE_REFS) {
    for (const userId of [1, 7, 99]) {
      const binds = workspaceContainerOptions(config, userId, start(ref)).HostConfig!.Binds!;
      for (const bind of binds) {
        assert.ok(bind.startsWith(`/srv/workspace-portal/users/${userId}/${ref.agent}/${ref.kind}/`), bind);
        const writable = !bind.endsWith(":ro");
        assert.equal(writable, /\/(home|workspace):\/(home\/user|workspace)$/.test(bind), bind);
      }
    }
  }
  const users = new Set<string>();
  for (const userId of [1, 2, 98, 99]) for (const ref of WORKSPACE_REFS) users.add(workspaceContainerOptions(config, userId, start(ref)).User!);
  assert.equal(users.size, 4 * WORKSPACE_REFS.length, "no two workspaces share a UID");
});

test("each start carries its own credential, readable back from the environment", () => {
  for (const agent of AGENT_KINDS) {
    const driver = driverFor(agent);
    const env = workspaceContainerOptions(config, 3, start({ agent, kind: "private" }, "second")).Env!;
    assert.equal(env.filter((entry) => entry.startsWith(`${driver.credentialEnv}=`)).length, 1, agent);
    assert.ok(env.includes(`${driver.credentialEnv}=second`), agent);
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

test("the image's upload route reads the upload limit under the name the gateway sets", () => {
  const script = fs.readFileSync(new URL("../../../workspace-image/qwen/trim-web-shell.mjs", import.meta.url), "utf8");
  assert.match(script, /^const UPLOAD_LIMIT_ENV = "WORKSPACE_PORTAL_UPLOAD_LIMIT_BYTES";$/m);
});
