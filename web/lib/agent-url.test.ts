import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKSPACE_REFS, workspaceName } from "@portal/core/wire";
import { agentFrameUrl, frameOf, framesOf } from "./agent-url.ts";

test("every workspace of a user has its own frame, and the lookup finds a workspace's own", () => {
  const frames = framesOf((workspace) => ({ port: 12140 + WORKSPACE_REFS.indexOf(workspace), token: workspaceName(workspace) }));
  assert.equal(frames.length, WORKSPACE_REFS.length);
  assert.equal(new Set(frames.map((frame) => frame?.port)).size, WORKSPACE_REFS.length, "no two share a port");
  for (const workspace of WORKSPACE_REFS) {
    assert.equal(frameOf(frames, { ...workspace })?.token, workspaceName(workspace), "found by agent and kind, not by identity");
  }
  assert.deepEqual(frameOf(frames, { agent: "qwen", kind: "private" }), { port: 12140, token: "Private Qwen Code" });
  assert.deepEqual(frameOf(frames, { agent: "opencode", kind: "online" }), { port: 12145, token: "Online OpenCode" });
});

test("a user without workspace ports has no frame for any workspace", () => {
  const frames = framesOf(() => null);
  for (const workspace of WORKSPACE_REFS) assert.equal(frameOf(frames, workspace), null);
});

test("agentFrameUrl for Qwen Code keeps the typed host, uses the workspace's own port, passes the theme and the token", () => {
  assert.equal(
    agentFrameUrl({ protocol: "http:", hostname: "portal.example.lan" }, { port: 3107, token: "abc_DEF-123" }, "qwen", "dark"),
    "http://portal.example.lan:3107/?theme=dark#token=abc_DEF-123",
  );
  assert.equal(
    agentFrameUrl({ protocol: "https:", hostname: "127.0.0.1" }, { port: 8443, token: "t" }, "qwen", "light"),
    "https://127.0.0.1:8443/?theme=light#token=t",
  );
});

test("agentFrameUrl for DeepSeek Harness and OpenCode is the root of the workspace's port: no token (the gateway adds their credential), no theme", () => {
  for (const agent of ["dsh", "opencode"] as const) {
    for (const theme of ["dark", "light"] as const) {
      const url = agentFrameUrl({ protocol: "http:", hostname: "portal.example.lan" }, { port: 3107, token: "abc_DEF-123" }, agent, theme);
      assert.equal(url, "http://portal.example.lan:3107/", agent);
      assert.ok(!url.includes("abc_DEF-123"), "the session's workspace token stays out of the URL");
    }
  }
});
