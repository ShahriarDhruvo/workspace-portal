import assert from "node:assert/strict";
import { test } from "node:test";
import { agentBrowserToken, agentPortFor, agentPortRange, tokensEqual, workspaceForAgentPort } from "./agent-origin.ts";
import { AGENT_KINDS, WORKSPACE_BLOCK, WORKSPACE_KINDS, WORKSPACE_REFS, sameWorkspace, workspaceIndex, workspaceName, workspaceNumber, workspaceOf } from "./wire/index.ts";

const BASE = 12_000;
const COUNT = 100;

test("a user has a workspace for every agent and kind, each with a place of its own in the user's block", () => {
  assert.equal(WORKSPACE_REFS.length, AGENT_KINDS.length * WORKSPACE_KINDS.length);
  assert.deepEqual(WORKSPACE_REFS.map(workspaceIndex), WORKSPACE_REFS.map((_, index) => index));
  assert.ok(WORKSPACE_REFS.length <= WORKSPACE_BLOCK, "a block holds every workspace of a user");
  // Places are for good: files on disk belong to the UIDs they give, and browsers keep the ports.
  assert.deepEqual(
    WORKSPACE_REFS.map((ref) => `${ref.agent}/${ref.kind}`),
    ["qwen/private", "qwen/online", "dsh/private", "dsh/online", "opencode/private", "opencode/online"],
  );
  assert.equal(workspaceName({ agent: "dsh", kind: "online" }), "Online DeepSeek Harness");
  assert.ok(sameWorkspace({ agent: "qwen", kind: "private" }, { kind: "private", agent: "qwen" }));
  assert.ok(!sameWorkspace({ agent: "qwen", kind: "private" }, { agent: "qwen", kind: "online" }));
  assert.ok(!sameWorkspace({ agent: "qwen", kind: "private" }, { agent: "opencode", kind: "private" }));
  assert.deepEqual(workspaceOf({ agent: "dsh", kind: "online" }), { agent: "dsh", kind: "online" });
  assert.equal(workspaceOf({ agent: null, kind: "private" }), null, "nothing ran yet");
});

test("no two workspaces share a number, whoever's they are", () => {
  const numbers = new Set<number>();
  for (let userId = 1; userId < COUNT; userId++) for (const ref of WORKSPACE_REFS) numbers.add(workspaceNumber(userId, ref));
  assert.equal(numbers.size, (COUNT - 1) * WORKSPACE_REFS.length);
});

test("a workspace's port names that workspace and no other", () => {
  for (const userId of [1, 2, 57, COUNT - 1]) {
    for (const ref of WORKSPACE_REFS) {
      const port = agentPortFor(BASE, COUNT, userId, ref);
      assert.equal(port, BASE + userId * WORKSPACE_BLOCK + workspaceIndex(ref));
      assert.deepEqual(workspaceForAgentPort(BASE, COUNT, port!), { userId, ref });
    }
  }
  assert.equal(agentPortFor(BASE, COUNT, 7, { agent: "qwen", kind: "private" }), 12_140);
  assert.equal(agentPortFor(BASE, COUNT, 7, { agent: "opencode", kind: "online" }), 12_145);
});

test("users outside 1 … count - 1 have no port, and ports outside the workspaces' serve none", () => {
  const ref = WORKSPACE_REFS[0]!;
  for (const userId of [0, -1, COUNT, COUNT + 1, 1.5, Number.NaN]) assert.equal(agentPortFor(BASE, COUNT, userId, ref), null, String(userId));
  const { first, last } = agentPortRange(BASE, COUNT);
  assert.deepEqual([first, last], [12_020, 13_999]);
  assert.deepEqual(workspaceForAgentPort(BASE, COUNT, first), { userId: 1, ref });
  // The rest of a block is free for agents to come: no workspace yet.
  assert.equal(workspaceForAgentPort(BASE, COUNT, first + WORKSPACE_REFS.length), null);
  assert.equal(workspaceForAgentPort(BASE, COUNT, last), null);
  for (const port of [BASE, BASE + 1, first - 1, last + 1, BASE - 1, 0, Number.NaN]) assert.equal(workspaceForAgentPort(BASE, COUNT, port), null, String(port));
});

test("a browser token is one session's for one workspace", () => {
  const token = (sessionId: string, userId: number, ref = WORKSPACE_REFS[0]!) => agentBrowserToken("a-secret-of-16-chars", sessionId, userId, ref);
  assert.match(token("s1", 1), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token("s1", 1), token("s1", 1));
  assert.notEqual(token("s1", 1), token("s2", 1));
  assert.notEqual(token("s1", 1), token("s1", 2));
  assert.equal(new Set(WORKSPACE_REFS.map((ref) => token("s1", 1, ref))).size, WORKSPACE_REFS.length, "one per workspace");
  assert.notEqual(token("s1", 1), agentBrowserToken("another-secret-16", "s1", 1, WORKSPACE_REFS[0]!));
  assert.ok(tokensEqual(token("s1", 1), token("s1", 1)));
  assert.ok(!tokensEqual(token("s1", 1), token("s1", 1).slice(1)));
  assert.ok(!tokensEqual(token("s1", 1), token("s1", 2)));
});
