import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_TIMEOUT_MS, agentJson } from "./shared.ts";
import { closeServer, listenLocal } from "./testing.ts";

test("an agent that drips its answer has not answered by the deadline", { timeout: 2_000 }, async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const drip = setInterval(() => res.write(" "), 5);
    res.on("close", () => clearInterval(drip));
  });
  const port = await listenLocal(server);
  const deadline = new AbortController();
  const timeout = t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const answer = agentJson({ host: "127.0.0.1", port, path: "/" }, 1024 * 1024);
  await delay(50); // the answer is under way
  deadline.abort();
  assert.equal(await answer, null);
  assert.deepEqual(timeout.mock.calls.map((call) => call.arguments), [[AGENT_TIMEOUT_MS]]);
  await closeServer(server);
});
