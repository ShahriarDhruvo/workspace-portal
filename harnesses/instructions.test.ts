import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessConfig, WorkspaceFacts } from "./harness.ts";
import { agentInstructions, MAX_INSTRUCTIONS_BYTES } from "./instructions.ts";
import { AgentConfigError } from "./shared.ts";

function config(instructionsFile: string, browser = true): HarnessConfig {
  return {
    modelsDir: "/nowhere",
    instructionsFile,
    servicePort: 4001,
    idleTimeoutMs: 0,
    uploadLimitBytes: 0,
    reader: { url: "" },
    llm: { imageModels: [] },
    workspace: { kinds: { private: { gatewayIp: "172.29.0.1" }, online: { gatewayIp: "172.30.0.1" } }, browser, defaultEffort: null },
  };
}

const PRIVATE: WorkspaceFacts = { kind: "private", person: "Ana Lima", place: null };

test("without a file of the admin's, an agent is told its workspace's facts: whose it is, its network, and how a web server is opened", () => {
  const none = config("/nowhere/instructions.md");
  const told = agentInstructions(none, PRIVATE);
  assert.match(told, /^# This workspace\n/);
  assert.match(told, /\n\n- The person: Ana Lima\.\n- Files: /, "no place while the admin has set none");
  assert.match(agentInstructions(none, { ...PRIVATE, place: "Florida, US" }), /^- The person: Ana Lima\.\n- Place: the portal's server is in Florida, US\.\n- Files: /m);
  assert.match(told, /^- Network: none\./m);
  assert.match(told, /listen on 0\.0\.0\.0.*Preview button.*Never give them a localhost link/);
  assert.match(told, /headless Chromium/);
  assert.ok(told.endsWith(".\n") && !told.endsWith("\n\n"));

  const online = agentInstructions(none, { ...PRIVATE, kind: "online" });
  assert.match(online, /^- Network: the internet/m);
  assert.equal(online.replace(/^- Network: .*$/m, ""), told.replace(/^- Network: .*$/m, ""), "the kinds differ in the network only");
  assert.doesNotMatch(agentInstructions(config("/nowhere/instructions.md", false), PRIVATE), /Chromium/, "no browser tools, no line about them");
});

test("the instructions a fresh install starts with (instructions.md) follow the facts and take the name and the place from them", () => {
  const told = agentInstructions(config(fileURLToPath(new URL("instructions.md", import.meta.url))), PRIVATE);
  assert.match(told, /^- The browser tools .*\n\n# How to work with me\n/m);
  assert.equal(told.split('"This workspace"').length - 1, 2, "its lines about the name and the place");
});

test("the admin's file follows the facts; one that can't be read, or is too long, fails the start", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instructions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "instructions.md");
  fs.writeFileSync(file, "\n# House rules\n\nAnswer in plain English.\n\n");
  const told = agentInstructions(config(file), PRIVATE);
  assert.ok(told.startsWith("# This workspace\n"));
  assert.ok(told.endsWith(" is this workspace: use them to look at what you built.\n\n# House rules\n\nAnswer in plain English.\n"));

  fs.writeFileSync(file, "   \n");
  assert.equal(agentInstructions(config(file), PRIVATE), agentInstructions(config("/nowhere/instructions.md"), PRIVATE), "an empty file adds nothing");

  fs.writeFileSync(file, "x".repeat(MAX_INSTRUCTIONS_BYTES));
  assert.ok(agentInstructions(config(file), PRIVATE).endsWith("x\n"), "as long as allowed");
  fs.writeFileSync(file, "é".repeat(MAX_INSTRUCTIONS_BYTES / 2 + 1));
  assert.throws(() => agentInstructions(config(file), PRIVATE), new AgentConfigError(`the instructions file ${file} is longer than 32 KiB: every request to the model carries it.`));
  assert.throws(() => agentInstructions(config(dir), PRIVATE), (error: unknown) => error instanceof AgentConfigError && error.message.startsWith(`cannot read the instructions file ${dir}: `));
});
