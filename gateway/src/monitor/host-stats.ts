// HostStats for GET /control/stats. The gateway runs with the host's /proc, so these are host figures.
import fs from "node:fs";
import os from "node:os";
import type { HostStats } from "@portal/core";
import type { Config } from "../config.ts";
import type { LlmQueue } from "../service/llm-queue.ts";
import type { WorkspaceManager } from "../workspaces/manager.ts";

export function readHostStats(config: Config, manager: WorkspaceManager, llm: LlmQueue): HostStats {
  return {
    running: manager.runningCount(),
    maxRunning: config.maxRunning,
    idleTimeoutMinutes: config.idleTimeoutMs / 60_000,
    memTotalBytes: os.totalmem(),
    memAvailableBytes: memAvailable(),
    cpus: os.cpus().length,
    llm: { inFlight: llm.inFlight, queued: llm.queued, maxConcurrency: llm.maxConcurrency },
  };
}

/** MemAvailable from /proc/meminfo (includes reclaimable cache), falling back to free memory. */
function memAvailable(): number {
  try {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (match) return Number(match[1]) * 1024;
  } catch {
    // not Linux
  }
  return os.freemem();
}
