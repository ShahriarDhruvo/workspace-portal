import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_KINDS, AGENT_NAMES, isVersion } from "@portal/core";
import { BEARER_SUBPROTOCOL_PREFIXES, driverFor } from "./index.ts";

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
  }
});
