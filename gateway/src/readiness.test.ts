import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForReady } from "./readiness.ts";
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
