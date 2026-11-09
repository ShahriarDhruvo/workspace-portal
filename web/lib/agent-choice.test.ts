import { test } from "node:test";
import assert from "node:assert/strict";
import { preselectedAgent, soleAgent, startOnOpen } from "./agent-choice.ts";

const both = [{ id: "qwen" }, { id: "dsh" }] as const;
const qwenOnly = [{ id: "qwen" }] as const;
const dshOnly = [{ id: "dsh" }] as const;

test("soleAgent: the only agent enabled, else nothing to pick without asking", () => {
  assert.equal(soleAgent(qwenOnly), "qwen");
  assert.equal(soleAgent(dshOnly), "dsh");
  assert.equal(soleAgent(both), null);
  assert.equal(soleAgent([]), null);
});

test("startOnOpen attaches to a starting or running workspace, whatever its agent", () => {
  for (const status of ["starting", "running"] as const) {
    assert.deepEqual(startOnOpen({ status }, both), {}, `${status}, two agents`);
    assert.deepEqual(startOnOpen({ status }, qwenOnly), {}, `${status}, one agent: no agent named, so no mismatch`);
  }
});

test("startOnOpen starts a workspace that isn't running only when there is nothing to choose", () => {
  for (const status of ["stopped", "error", "stopping"] as const) {
    assert.deepEqual(startOnOpen({ status }, qwenOnly), { agent: "qwen" }, `${status}, one agent`);
    assert.deepEqual(startOnOpen({ status }, dshOnly), { agent: "dsh" });
    assert.equal(startOnOpen({ status }, both), null, `${status}, two agents: the page asks`);
    assert.equal(startOnOpen({ status }, []), null);
  }
});

test("preselectedAgent: the first preferred agent still enabled, else the first one offered", () => {
  assert.equal(preselectedAgent(both, null, null), "qwen", "never started: the first in display order");
  assert.equal(preselectedAgent(both, null, "dsh"), "dsh", "the workspace's last agent");
  assert.equal(preselectedAgent(both, "qwen", "dsh"), "qwen", "the agent just asked for wins over the last one");
  assert.equal(preselectedAgent(qwenOnly, null, "dsh"), "qwen", "a last agent no longer enabled is skipped");
  assert.equal(preselectedAgent([...both].reverse(), null, null), "dsh", "display order comes from the gateway");
  assert.equal(preselectedAgent([], "qwen", "dsh"), null);
});
