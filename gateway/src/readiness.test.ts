import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { probeQwen, waitForReady } from "./readiness.ts";
import type { ContainerState } from "./runtime.ts";

const running = async (): Promise<ContainerState> => ({ running: true });

test("waitForReady succeeds once the probe does", async () => {
  let probes = 0;
  const result = await waitForReady({
    probe: async () => ++probes >= 3,
    state: running,
    signal: new AbortController().signal,
    intervalMs: 1,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(probes, 3);
});

test("waitForReady reports an exited container", async () => {
  const result = await waitForReady({
    probe: async () => false,
    state: async () => ({ running: false, exitCode: 137, oomKilled: true }),
    signal: new AbortController().signal,
    intervalMs: 1,
  });
  assert.deepEqual(result, { ok: false, reason: "exited", exitCode: 137, oomKilled: true });
});

test("waitForReady times out and can be aborted", async () => {
  const timeout = await waitForReady({ probe: async () => false, state: running, signal: new AbortController().signal, intervalMs: 1, timeoutMs: 20 });
  assert.deepEqual(timeout, { ok: false, reason: "timeout" });

  const abort = new AbortController();
  setTimeout(() => abort.abort(), 10);
  const aborted = await waitForReady({ probe: async () => false, state: running, signal: abort.signal, intervalMs: 5_000 });
  assert.deepEqual(aborted, { ok: false, reason: "aborted" });
});

test("probeQwen asks the deep health check with the container token and needs a live agent process", async () => {
  const seen: Array<{ url: string | undefined; authorization: string | undefined }> = [];
  let channelAlive = false;
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (req.headers.authorization !== "Bearer tok") return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":"Unauthorized"}');
    if (req.url !== "/health?deep=1") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", activePrompts: 0, pendingPermissions: 0, activeWork: false, connectedClients: 0, channelAlive, idleSinceMs: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  assert.equal(await probeQwen("127.0.0.1", port, "tok"), false, "up, but the agent process is not");
  channelAlive = true;
  assert.equal(await probeQwen("127.0.0.1", port, "tok"), true);
  assert.equal(await probeQwen("127.0.0.1", port, "wrong"), false, "a 401 is not ready");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await probeQwen("127.0.0.1", port, "tok"), false, "connection refused");
  assert.deepEqual(seen, [
    { url: "/health?deep=1", authorization: "Bearer tok" },
    { url: "/health?deep=1", authorization: "Bearer tok" },
    { url: "/health?deep=1", authorization: "Bearer wrong" },
  ]);
});
