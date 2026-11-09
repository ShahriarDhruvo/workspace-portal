// Waiting for Qwen Code to come up inside a freshly started (or adopted) workspace container.
import { setTimeout as delay } from "node:timers/promises";
import { fetchQwenHealth } from "./qwen.ts";
import type { ContainerState } from "./runtime.ts";

const READY_POLL_INTERVAL_MS = 500;
export const READY_TIMEOUT_MS = 90_000;

export type ReadyResult =
  | { ok: true }
  | { ok: false; reason: "exited"; exitCode: number | null; oomKilled: boolean }
  | { ok: false; reason: "timeout" | "aborted" };

export interface ReadinessOptions {
  probe: () => Promise<boolean>;
  state: () => Promise<ContainerState>;
  signal: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
}

/** Polls `probe` until it succeeds, the container exits, the timeout passes or `signal` aborts. */
export async function waitForReady(options: ReadinessOptions): Promise<ReadyResult> {
  const { signal, intervalMs = READY_POLL_INTERVAL_MS, timeoutMs = READY_TIMEOUT_MS } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) return { ok: false, reason: "aborted" };
    if (await options.probe()) return signal.aborted ? { ok: false, reason: "aborted" } : { ok: true };
    const state = await options.state().catch((): ContainerState => ({ running: true }));
    if (!state.running) return { ok: false, reason: "exited", exitCode: state.exitCode, oomKilled: state.oomKilled };
    if (Date.now() >= deadline) return { ok: false, reason: "timeout" };
    try {
      await delay(intervalMs, undefined, { signal });
    } catch {
      return { ok: false, reason: "aborted" };
    }
  }
}

/** Ready once `qwen serve` answers its health check and its agent process can take prompts. */
export async function probeQwen(host: string, port: number, token: string): Promise<boolean> {
  const health = await fetchQwenHealth(host, port, token);
  return health !== null && health.channelAlive;
}
