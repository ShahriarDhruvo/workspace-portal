import { test } from "node:test";
import assert from "node:assert/strict";
import { hasContainer, initialKind, onlineAccessAfter, onlineBlockedReason, runningWorkspace, startErrorText } from "./workspace-kind.ts";

test("the picker offers Online first when it may start; a failed start offers its own kind again", () => {
  assert.equal(initialKind({ status: "stopped", kind: "private", online: "allowed" }), "online", "Online is the default");
  assert.equal(initialKind({ status: "error", kind: "private", online: "allowed" }), "private");
  assert.equal(initialKind({ status: "error", kind: "online", online: "allowed" }), "online");
  assert.equal(initialKind({ status: "stopped", kind: "online", online: "not_allowed" }), "private");
  assert.equal(initialKind({ status: "error", kind: "online", online: "off" }), "private", "never a kind that can't start");
});

test("Online blocked says why: off for the portal, or not allowed for the account", () => {
  assert.equal(onlineBlockedReason("allowed"), null);
  assert.match(onlineBlockedReason("off") ?? "", /turned off on this portal/);
  assert.match(onlineBlockedReason("not_allowed") ?? "", /aren't enabled for this account/);
  assert.equal(onlineAccessAfter({ error: "online_disabled" }), "off");
  assert.equal(onlineAccessAfter({ error: "online_not_allowed" }), "not_allowed");
  assert.equal(onlineAccessAfter({ error: "capacity" }), null);
});

test("a refused start is said in the portal's words, naming the workspace that runs by kind and harness", () => {
  const refused = (error: string) => ({ error, message: `gateway: ${error}` });
  assert.equal(
    startErrorText(refused("another_running"), "Your", { agent: "opencode", kind: "online" }),
    "Your Online OpenCode workspace is running. Stop it before starting another.",
  );
  assert.equal(
    startErrorText(refused("another_running"), "Ada Lovelace's", { agent: "qwen", kind: "private" }),
    "Ada Lovelace's Private Qwen Code workspace is running. Stop it before starting another.",
  );
  assert.equal(startErrorText(refused("another_running"), "Your", null), "gateway: another_running", "the gateway's message while what runs is unknown");
  assert.equal(startErrorText(refused("capacity"), "Your", null), "All workspace slots are busy. Try again in a minute.");
  assert.equal(startErrorText(refused("online_disabled"), "Your", null), onlineBlockedReason("off"));
  assert.equal(startErrorText(refused("online_not_allowed"), "Your", null), onlineBlockedReason("not_allowed"));
  assert.equal(startErrorText(refused("start_failed"), "Your", null), "gateway: start_failed", "others keep the gateway's message");
  assert.equal(
    startErrorText(refused("start_failed"), "Your", { agent: "dsh", kind: "private" }),
    "gateway: start_failed",
    "a running workspace changes no other refusal",
  );
});

test("only a starting, running or stopping container holds a workspace's files", () => {
  assert.deepEqual(
    (["stopped", "starting", "running", "stopping", "error"] as const).filter(hasContainer),
    ["starting", "running", "stopping"],
  );
});

test("the running workspace is the one with a container, by agent and kind; without one, none runs", () => {
  for (const status of ["starting", "running", "stopping"] as const) {
    assert.deepEqual(runningWorkspace({ status, agent: "dsh", kind: "online" }), { agent: "dsh", kind: "online" }, status);
  }
  for (const status of ["stopped", "error"] as const) {
    assert.equal(runningWorkspace({ status, agent: "dsh", kind: "online" }), null, `${status}: agent and kind name the one used last`);
  }
  assert.equal(runningWorkspace({ status: "stopped", agent: null, kind: "private" }), null, "never started");
});
