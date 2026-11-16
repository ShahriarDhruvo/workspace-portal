import { test } from "node:test";
import assert from "node:assert/strict";
import { agentFrameUrl } from "./agent-url.ts";

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

test("agentFrameUrl for DeepSeek Harness is the root of the workspace's port: no token (dsh uses a cookie), no theme", () => {
  for (const theme of ["dark", "light"] as const) {
    const url = agentFrameUrl({ protocol: "http:", hostname: "portal.example.lan" }, { port: 3107, token: "abc_DEF-123" }, "dsh", theme);
    assert.equal(url, "http://portal.example.lan:3107/");
    assert.ok(!url.includes("abc_DEF-123"), "the session's workspace token stays out of the URL");
  }
});
