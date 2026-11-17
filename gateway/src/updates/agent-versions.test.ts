import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentVersions, parseVersionsFile, withVersion } from "./agent-versions.ts";
import { loadConfig } from "../config.ts";
import type { Logger } from "../lib/log.ts";

const DEFAULTS = { qwen: "0.27.0", dsh: "0.2.2-rc.1" };

function setup(content?: string): { file: string; dir: string; errors: string[]; log: Logger } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-versions-"));
  const file = path.join(dir, "config", "agent-versions.env");
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const errors: string[] = [];
  const log: Logger = { info: () => undefined, warn: () => undefined, error: (msg) => void errors.push(msg) };
  return { file, dir, errors, log };
}

test("parseVersionsFile reads KEY=VALUE lines like deploy/lib.sh env_value", () => {
  const text = [
    "# comment",
    "QWEN_CODE_VERSION=0.27.0",
    "",
    "  indented=ignored",
    "DSH_VERSION=\"0.2.2-rc.3\" # quoted",
    "OTHER='single' x",
    "QWEN_CODE_VERSION=0.27.4 # the last line wins",
    "EMPTY=",
    "CRLF=1.2.3\r",
    "not a line",
  ].join("\n");
  assert.deepEqual(
    [...parseVersionsFile(text)],
    [
      ["QWEN_CODE_VERSION", "0.27.4"],
      ["DSH_VERSION", "0.2.2-rc.3"],
      ["OTHER", "single"],
      ["EMPTY", ""],
      ["CRLF", "1.2.3"],
    ],
  );
  const serialized = withVersion(withVersion(null, "DSH_VERSION", "0.2.3"), "QWEN_CODE_VERSION", "0.28.0");
  assert.match(serialized, /^# /);
  assert.ok(serialized.endsWith("DSH_VERSION=0.2.3\nQWEN_CODE_VERSION=0.28.0\n"));
  assert.deepEqual([...parseVersionsFile(serialized)], [["DSH_VERSION", "0.2.3"], ["QWEN_CODE_VERSION", "0.28.0"]], "round trip");
});

test("withVersion replaces the key's lines like deploy/lib.sh agent_version_set and keeps every other line", () => {
  const text = "# mine\nQWEN_CODE_VERSION=0.26.0\nnot a line\nQWEN_CODE_VERSION_OLD=1.0.0\nQWEN_CODE_VERSION=0.27.0 # dup\nDSH_VERSION=0.2.1";
  assert.equal(withVersion(text, "QWEN_CODE_VERSION", "0.28.0"), "# mine\nnot a line\nQWEN_CODE_VERSION_OLD=1.0.0\nDSH_VERSION=0.2.1\nQWEN_CODE_VERSION=0.28.0\n");
  assert.equal(withVersion("", "DSH_VERSION", "0.2.3"), "DSH_VERSION=0.2.3\n", "an empty file gets no header");
});

test("without a file every agent is at its default version", () => {
  const { file, log, errors } = setup();
  const versions = new AgentVersions({ file, defaults: DEFAULTS, log });
  assert.equal(versions.current("qwen"), "0.27.0");
  assert.deepEqual(versions.selection("dsh"), { version: "0.2.2-rc.1", image: "workspace-portal/workspace:dsh-0.2.2-rc.1" });
  assert.equal(versions.defaultVersion("dsh"), "0.2.2-rc.1");
  assert.deepEqual(errors, [], "a missing file is not an error");
  assert.equal(fs.existsSync(file), false, "reading creates nothing");
});

test("the file overrides the defaults; an invalid version in it is reported and ignored", () => {
  const { file, log, errors } = setup("DSH_VERSION=0.2.2-rc.3\nQWEN_CODE_VERSION=latest; rm -rf /\n");
  const versions = new AgentVersions({ file, defaults: DEFAULTS, log });
  assert.equal(versions.current("dsh"), "0.2.2-rc.3");
  assert.equal(versions.current("qwen"), "0.27.0");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /QWEN_CODE_VERSION .* is not a version/);
});

test("set writes the file atomically (0600 in a new 0700 directory) and keeps other entries", () => {
  const { file, dir, log } = setup();
  const versions = new AgentVersions({ file, defaults: DEFAULTS, log });
  versions.set("qwen", "0.27.4");
  assert.equal(versions.current("qwen"), "0.27.4");
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual([...parseVersionsFile(fs.readFileSync(file, "utf8"))], [["QWEN_CODE_VERSION", "0.27.4"]], "only what was chosen");
  fs.appendFileSync(file, "SOMETHING_ELSE=kept\n");
  const reread = new AgentVersions({ file, defaults: DEFAULTS, log });
  assert.equal(reread.current("qwen"), "0.27.4", "a restarted gateway reads the choice back");
  reread.set("dsh", "0.2.2-rc.3");
  assert.deepEqual([...parseVersionsFile(fs.readFileSync(file, "utf8"))], [["QWEN_CODE_VERSION", "0.27.4"], ["SOMETHING_ELSE", "kept"], ["DSH_VERSION", "0.2.2-rc.3"]]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["agent-versions.env"], "no temp file left behind");
  assert.throws(() => reread.set("dsh", "next"), /not a version/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("set changes only its own line of the file as it is on disk, so it keeps what deploy/update-image.sh wrote meanwhile", () => {
  const { file, dir, log } = setup("# chosen by the admin\nQWEN_CODE_VERSION=0.27.0\n");
  try {
    const versions = new AgentVersions({ file, defaults: DEFAULTS, log });
    // update-image.sh switches DeepSeek Harness while the gateway runs (it restarts the gateway afterwards).
    fs.writeFileSync(file, "# chosen by the admin\nQWEN_CODE_VERSION=0.27.0\n# a note\nDSH_VERSION=0.2.2-rc.3\nweird line\n");
    versions.set("qwen", "0.27.4");
    assert.equal(fs.readFileSync(file, "utf8"), "# chosen by the admin\n# a note\nDSH_VERSION=0.2.2-rc.3\nweird line\nQWEN_CODE_VERSION=0.27.4\n");
    assert.equal(versions.current("qwen"), "0.27.4");
    assert.equal(versions.current("dsh"), "0.2.2-rc.1", "the gateway's own view of the other agent changes at its restart");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed write changes nothing", () => {
  const { file, dir, log } = setup("QWEN_CODE_VERSION=0.27.4\n");
  const versions = new AgentVersions({ file, defaults: DEFAULTS, log });
  fs.chmodSync(path.dirname(file), 0o500);
  try {
    if (process.getuid?.() === 0) return; // root writes anyway
    assert.throws(() => versions.set("qwen", "0.28.0"));
    assert.equal(versions.current("qwen"), "0.27.4");
  } finally {
    fs.chmodSync(path.dirname(file), 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fromConfig uses PORTAL_DATA_DIR/config/agent-versions.env and the .env defaults", () => {
  const { dir, log } = setup();
  const config = loadConfig({ GATEWAY_CONTROL_SECRET: "c".repeat(32), PORTAL_DATA_DIR: dir, QWEN_CODE_VERSION: "0.26.0" });
  assert.equal(config.agentVersionsFile, path.join(dir, "config", "agent-versions.env"));
  const versions = AgentVersions.fromConfig(config, log);
  assert.equal(versions.current("qwen"), "0.26.0");
  versions.set("qwen", "0.27.4");
  assert.equal(AgentVersions.fromConfig(config, log).current("qwen"), "0.27.4");
  fs.rmSync(dir, { recursive: true, force: true });
});
