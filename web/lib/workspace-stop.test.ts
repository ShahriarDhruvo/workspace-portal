import { test } from "node:test";
import assert from "node:assert/strict";
import { restartKind, stopWarnings } from "./workspace-stop.ts";

const quiet = { busy: false, connections: { owner: 0, admin: 0 } };

test("the stop confirmation warns when the agent works, someone else has the workspace open, or an admin does", () => {
  assert.deepEqual(stopWarnings(quiet, false), { busy: false, openElsewhere: false, admin: false }, "nothing to interrupt");
  assert.deepEqual(stopWarnings({ ...quiet, busy: true }, false), { busy: true, openElsewhere: false, admin: false });
  assert.deepEqual(stopWarnings({ ...quiet, connections: { owner: 0, admin: 1 } }, false), {
    busy: false,
    openElsewhere: false,
    admin: true,
  });
  assert.equal(stopWarnings({ ...quiet, busy: true }, true).busy, true);
});

test("the workspace page's own session doesn't count as open elsewhere; on Home or Settings every session does", () => {
  const openOnce = { ...quiet, connections: { owner: 1, admin: 0 } };
  assert.equal(stopWarnings(openOnce, true).openElsewhere, false, "the workspace page itself");
  assert.equal(stopWarnings(openOnce, false).openElsewhere, true, "Home: a workspace tab is open somewhere");
  assert.equal(stopWarnings({ ...quiet, connections: { owner: 2, admin: 0 } }, true).openElsewhere, true);
});

test("Restart now starts again only the kind that is starting or running; a stopped workspace stays stopped", () => {
  assert.equal(restartKind({ status: "running", kind: "online" }), "online");
  assert.equal(restartKind({ status: "starting", kind: "private" }), "private");
  for (const status of ["stopped", "stopping", "error"] as const) {
    assert.equal(restartKind({ status, kind: "online" }), null, `${status}: nothing to restart`);
  }
});
