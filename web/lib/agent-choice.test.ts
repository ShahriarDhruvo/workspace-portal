import { test } from "node:test";
import assert from "node:assert/strict";
import { startingAgent } from "./agent-choice.ts";

const both = [{ id: "qwen" }, { id: "dsh" }] as const;
const qwenOnly = [{ id: "qwen" }] as const;

test("startingAgent: the saved choice while it is enabled", () => {
  assert.equal(startingAgent("dsh", both), "dsh");
  assert.equal(startingAgent("qwen", both), "qwen");
});

test("startingAgent: without a choice, or with one no longer enabled, the first enabled agent (the default)", () => {
  assert.equal(startingAgent(null, both), "qwen");
  assert.equal(startingAgent(null, [...both].reverse()), "dsh", "display order comes from the gateway");
  assert.equal(startingAgent("dsh", qwenOnly), "qwen");
  assert.equal(startingAgent("qwen", []), null, "nothing enabled");
});
