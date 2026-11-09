import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionRegistry, PRESENCE_MS, type AgentConnection, type ConnectionRole } from "./connections.ts";

function setup() {
  const clock = { now: 1_000_000 };
  const registry = new ConnectionRegistry(() => clock.now);
  const closedWith: Array<{ sessionId: string; code: number; reason: string }> = [];
  const connect = (userId: number, sessionId: string, role: ConnectionRole = "owner"): { connection: AgentConnection; unregister: () => void } => {
    const connection: AgentConnection = { userId, sessionId, role, close: (code, reason) => closedWith.push({ sessionId, code, reason }) };
    return { connection, unregister: registry.add(connection) };
  };
  return { clock, registry, closedWith, connect };
}

test("a session seen recently has the workspace open until PRESENCE_MS has passed", () => {
  const { clock, registry } = setup();
  assert.deepEqual(registry.count(7), { owner: 0, admin: 0 });
  registry.seen(7, "s1", "owner");
  assert.deepEqual(registry.count(7), { owner: 1, admin: 0 });
  assert.deepEqual(registry.count(8), { owner: 0, admin: 0 }, "per workspace");

  clock.now += PRESENCE_MS;
  assert.deepEqual(registry.count(7), { owner: 1, admin: 0 }, "still present at exactly PRESENCE_MS");
  clock.now += 1;
  assert.deepEqual(registry.count(7), { owner: 0, admin: 0 }, "expired");

  registry.seen(7, "s1", "owner");
  clock.now += PRESENCE_MS - 1;
  registry.seen(7, "s1", "owner");
  clock.now += PRESENCE_MS - 1;
  assert.deepEqual(registry.count(7), { owner: 1, admin: 0 }, "every request renews it");
});

test("each session counts once, whether it has streams, sockets, recent requests or all of them", () => {
  const { clock, registry, connect } = setup();
  const stream = connect(7, "s1");
  connect(7, "s1"); // a terminal socket of the same browser
  registry.seen(7, "s1", "owner");
  assert.deepEqual(registry.count(7), { owner: 1, admin: 0 });

  registry.seen(7, "s2", "owner"); // alice's second browser, polling only
  connect(7, "admin-session", "admin");
  registry.seen(7, "admin-session", "admin");
  assert.deepEqual(registry.count(7), { owner: 2, admin: 1 });

  clock.now += PRESENCE_MS + 1;
  assert.deepEqual(registry.count(7), { owner: 1, admin: 1 }, "open connections need no presence");
  stream.unregister();
  assert.deepEqual(registry.count(7), { owner: 1, admin: 1 }, "the session's other socket is still open");
});

test("closing a session or workspace closes its connections and forgets its presence", () => {
  const { registry, closedWith, connect } = setup();
  connect(7, "s1");
  connect(7, "admin-session", "admin");
  connect(8, "admin-session", "admin");
  registry.seen(7, "s2", "owner");
  registry.seen(7, "admin-session", "admin");
  registry.seen(8, "s3", "owner");

  assert.equal(registry.closeSession("admin-session", 4001, "session disconnected"), 2);
  assert.deepEqual(closedWith, [
    { sessionId: "admin-session", code: 4001, reason: "session disconnected" },
    { sessionId: "admin-session", code: 4001, reason: "session disconnected" },
  ]);
  assert.deepEqual(registry.count(7), { owner: 2, admin: 0 });
  assert.deepEqual(registry.count(8), { owner: 1, admin: 0 });

  assert.equal(registry.closeWorkspace(7, 1001, "workspace stopped"), 1);
  assert.deepEqual(registry.count(7), { owner: 0, admin: 0 }, "presence of the stopped workspace is gone too");
  assert.deepEqual(registry.count(8), { owner: 1, admin: 0 }, "other workspaces are untouched");

  assert.equal(registry.closeAll(1001, "gateway restarting"), 0);
  assert.deepEqual(registry.count(8), { owner: 0, admin: 0 });
});

test("with more than a thousand sessions seen, only recent ones count", () => {
  const { clock, registry } = setup();
  for (let i = 0; i < 1_000; i++) registry.seen(1, `old-${i}`, "owner");
  clock.now += PRESENCE_MS + 1;
  registry.seen(1, "fresh-1", "owner");
  registry.seen(1, "fresh-2", "owner");
  assert.deepEqual(registry.count(1), { owner: 2, admin: 0 });
});
