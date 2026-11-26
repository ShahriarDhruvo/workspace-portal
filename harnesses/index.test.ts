import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_KINDS, AGENT_NAMES, isVersion } from "@portal/core";
import type { HarnessConfig } from "./harness.ts";
import { BEARER_SUBPROTOCOL_PREFIXES, driverFor } from "./index.ts";
import { agentInstructions, INSTRUCTIONS_FILE } from "./instructions.ts";
import { opencodeFacts } from "./opencode/settings.ts";

test("every harness has a driver of its own kind, port, credential and settings mount", () => {
  for (const kind of AGENT_KINDS) {
    const driver = driverFor(kind);
    assert.equal(driver.kind, kind);
    assert.equal(driver.name, AGENT_NAMES[kind]);
    assert.ok(isVersion(driver.release.defaultVersion), kind);
  }
  for (const key of ["port", "credentialEnv", "settingsMount"] as const) {
    assert.equal(new Set(AGENT_KINDS.map((kind) => driverFor(kind)[key])).size, AGENT_KINDS.length, `no two share a ${key}`);
  }
  assert.deepEqual(BEARER_SUBPROTOCOL_PREFIXES, ["qwen-bearer."], "only token harnesses have one");
});

test("each harness's folder tells the deploy scripts what its driver says, and holds what the image build runs", () => {
  for (const kind of AGENT_KINDS) {
    const folder = new URL(`${kind}/`, import.meta.url);
    const manifest = fileURLToPath(new URL("harness.env", folder));
    const read = (key: string): string => execFileSync("bash", ["-c", 'source "$1"; printf %s "${!2}"', "bash", manifest, key], { encoding: "utf8" });
    const { name, port, release } = driverFor(kind);
    assert.deepEqual([read("NAME"), read("VERSION_KEY"), read("PORT"), read("CLI")], [name, release.versionKey, String(port), release.cli], kind);
    for (const file of ["install.sh", "env.sh", "check.sh", "start.sh"]) assert.ok(fs.existsSync(new URL(`image/${file}`, folder)), `${kind}/image/${file}`);
    assert.match(fs.readFileSync(new URL("image/start.sh", folder), "utf8"), new RegExp(`--port ${port}\\b`), `${kind}: start.sh listens on the driver's port`);
    assert.ok(fs.readFileSync(new URL("image/install.sh", folder), "utf8").includes(`npm install -g "${release.packageName}@$1"`), `${kind}: install.sh installs the package Admin > Updates lists`);
  }
});

test("every harness's settings hold the agent's instructions, and each harness is pointed at them", () => {
  const config: HarnessConfig = {
    modelsDir: fileURLToPath(new URL("../models/", import.meta.url)),
    instructionsFile: "/nowhere/instructions.md",
    servicePort: 4001,
    idleTimeoutMs: 1_800_000,
    uploadLimitBytes: 1024,
    reader: { url: "" },
    llm: { imageModels: ["Image-Turbo", "Image"] },
    workspace: { kinds: { private: { gatewayIp: "172.29.0.1" }, online: { gatewayIp: "172.30.0.1" } }, browser: true, defaultEffort: null },
  };
  const online = { kind: "online", person: "Ana Lima", place: "Florida, US" } as const;
  const files = (kind: (typeof AGENT_KINDS)[number]) => driverFor(kind).renderSettings(config, online);
  for (const kind of AGENT_KINDS.filter((kind) => kind !== "opencode")) assert.equal(files(kind)[INSTRUCTIONS_FILE], agentInstructions(config, online), kind);
  // OpenCode's instructions add its image tool's fact; the other harnesses have no image tool.
  assert.equal(files("opencode")[INSTRUCTIONS_FILE], agentInstructions(config, online, opencodeFacts(config.llm.imageModels)));
  assert.match(files("opencode")[INSTRUCTIONS_FILE]!, /\n- Images: generate_image /);
  const file = (kind: (typeof AGENT_KINDS)[number]): string => `${driverFor(kind).settingsMount}/${INSTRUCTIONS_FILE}`;

  assert.deepEqual(JSON.parse(files("opencode")["opencode.json"]!).instructions, [file("opencode")], "OpenCode: a file its settings name");
  const { context } = JSON.parse(files("qwen")["settings.json"]!);
  assert.deepEqual(context, { includeDirectories: [driverFor("qwen").settingsMount], loadFromIncludeDirectories: true }, "Qwen Code: the AGENTS.md of a folder its settings include");
  const start = fs.readFileSync(new URL("dsh/image/start.sh", import.meta.url), "utf8");
  assert.ok(start.includes(`INSTRUCTIONS=${file("dsh")}\n`) && start.includes('ln -s "$INSTRUCTIONS" "$DSH_AGENTS_HOME/AGENTS.md"'), "DeepSeek Harness: the AGENTS.md of the folder start.sh puts together");
});
