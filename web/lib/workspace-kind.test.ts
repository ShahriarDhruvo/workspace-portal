import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKSPACE_KIND_NAMES } from "@portal/core";
import { hasContainer, initialKind, KIND_NAMES, onlineAccessAfter, onlineBlockedReason, otherKind, startErrorText } from "./workspace-kind.ts";

test("the browser's kind names are the database package's", () => {
  assert.deepEqual(KIND_NAMES, WORKSPACE_KIND_NAMES);
  assert.equal(otherKind("private"), "online");
  assert.equal(otherKind("online"), "private");
});

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

test("a refused start is said in the portal's words, naming the kind that runs", () => {
  const refused = (error: string) => ({ error, message: `gateway: ${error}` });
  assert.equal(
    startErrorText(refused("kind_mismatch"), "online", "Your"),
    "Your Private workspace is running. Stop it before starting the Online one.",
  );
  assert.equal(
    startErrorText(refused("kind_mismatch"), "private", "Ada Lovelace's"),
    "Ada Lovelace's Online workspace is running. Stop it before starting the Private one.",
  );
  assert.equal(startErrorText(refused("capacity"), "online", "Your"), "All workspace slots are busy. Try again in a minute.");
  assert.equal(startErrorText(refused("online_disabled"), "online", "Your"), onlineBlockedReason("off"));
  assert.equal(startErrorText(refused("online_not_allowed"), "online", "Your"), onlineBlockedReason("not_allowed"));
  assert.equal(startErrorText(refused("start_failed"), "online", "Your"), "gateway: start_failed", "others keep the gateway's message");
});

test("only a starting, running or stopping container holds the kind's files", () => {
  assert.deepEqual(
    (["stopped", "starting", "running", "stopping", "error"] as const).filter(hasContainer),
    ["starting", "running", "stopping"],
  );
});
