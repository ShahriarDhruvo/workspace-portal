import { test } from "node:test";
import assert from "node:assert/strict";
import { agentFrameUrl } from "./agent-url.ts";

test("agentFrameUrl keeps the typed host, uses the workspace's own port, asks for dark mode and passes the token", () => {
  assert.equal(
    agentFrameUrl({ protocol: "http:", hostname: "portal.example.lan" }, { port: 3107, token: "abc_DEF-123" }),
    "http://portal.example.lan:3107/?theme=dark#token=abc_DEF-123",
  );
  assert.equal(
    agentFrameUrl({ protocol: "https:", hostname: "127.0.0.1" }, { port: 8443, token: "t" }),
    "https://127.0.0.1:8443/?theme=dark#token=t",
  );
});
