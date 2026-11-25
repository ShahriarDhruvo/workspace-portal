import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sandbox, workspaceContainerOptions, type WorkspaceContainer } from "./spec.ts";

const MIB = 1024 * 1024;
const WORKSPACE: WorkspaceContainer = {
  userId: 7,
  ref: { agent: "opencode", kind: "online" },
  image: "workspace-portal/workspace:opencode-2.4.1",
  version: "2.4.1",
  owner: { uid: 300_145, gid: 300_145 },
  paths: { home: "/data/home", workspace: "/data/workspace", settings: "/data/system/settings", passwd: "/data/system/passwd", group: "/data/system/group" },
  settingsMount: "/etc/opencode",
  env: ["OPENCODE_PASSWORD=secret"],
  network: { kind: "online", network: "workspace-portal-online", subnet: "172.28.0.0/16", gatewayIp: "172.28.0.1", ipRange: "172.28.128.0/17", bridge: "br-wonline", dns: ["9.9.9.9", "149.112.112.112"] },
  limits: { memoryBytes: 2048 * MIB, nanoCpus: 2e9, pidsLimit: 512, shmBytes: 256 * MIB, tmpBytes: 512 * MIB },
};

test("a workspace container: the sandbox, its own account, files, network and limits, and nothing a harness could widen", () => {
  assert.deepEqual(workspaceContainerOptions(WORKSPACE), {
    name: "wp-opencode-online-7",
    Hostname: "workspace",
    Image: "workspace-portal/workspace:opencode-2.4.1",
    User: "300145:300145",
    WorkingDir: "/workspace",
    Labels: {
      "workspace-portal.workspace": "1",
      "workspace-portal.user-id": "7",
      "workspace-portal.kind": "online",
      "workspace-portal.agent": "opencode",
      "workspace-portal.version": "2.4.1",
    },
    Env: ["HOME=/home/user", "USER=user", "LOGNAME=user", "OPENCODE_PASSWORD=secret"],
    HostConfig: {
      Binds: ["/data/home:/home/user", "/data/workspace:/workspace", "/data/system/settings:/etc/opencode:ro", "/data/system/passwd:/etc/passwd:ro", "/data/system/group:/etc/group:ro"],
      ...sandbox(512 * MIB),
      NetworkMode: "workspace-portal-online",
      Dns: ["9.9.9.9", "149.112.112.112"],
      DnsSearch: ["."],
      Memory: 2048 * MIB,
      MemorySwap: 2560 * MIB,
      NanoCpus: 2e9,
      PidsLimit: 512,
      ShmSize: 256 * MIB,
      Init: false,
      OomScoreAdj: 500,
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
  });
  const unversioned = workspaceContainerOptions({ ...WORKSPACE, version: undefined, network: { ...WORKSPACE.network, kind: "private", dns: [] } });
  assert.equal("workspace-portal.version" in unversioned.Labels!, false);
  assert.equal("Dns" in unversioned.HostConfig!, false, "a network without resolvers gets no DNS settings");
});

test("sandbox.sh gives the shell scripts the hardening of sandbox()", () => {
  const profile = sandbox(16 * MIB);
  assert.deepEqual(profile, { ReadonlyRootfs: true, Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${16 * MIB}` }, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"] });
  const flags = ["--read-only", ...profile.CapDrop!.flatMap((capability) => ["--cap-drop", capability]), ...profile.SecurityOpt!.flatMap((option) => ["--security-opt", option.replace(/:true$/, "")])];
  const script = fs.readFileSync(new URL("sandbox.sh", import.meta.url), "utf8");
  assert.ok(script.includes(`\nSANDBOX=(${flags.join(" ")})\n`));
  assert.ok(script.includes(`\nSANDBOX_TMPFS=${profile.Tmpfs!["/tmp"]!.replace(/,size=\d+$/, "")}\n`));
  // The scripts that start a container from a workspace image take the options from there.
  for (const file of ["../../deploy/lib.sh", "../../deploy/verify-isolation.sh"]) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(text.includes('"${SANDBOX[@]}"') && text.includes("$SANDBOX_TMPFS"), file);
    assert.doesNotMatch(text, /--cap-drop|--read-only|--security-opt/, `${file} spells none of them out`);
  }
});
