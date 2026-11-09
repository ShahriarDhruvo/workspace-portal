// HostStats for GET /control/stats. The gateway runs with the host's /proc, so these are host figures.
import fs from "node:fs";
import os from "node:os";
import type { Config } from "./config.ts";
import type { LlmQueue } from "./llm-queue.ts";
import type { WorkspaceManager } from "./workspaces.ts";

export interface HostStats {
  running: number;
  maxRunning: number;
  idleTimeoutMinutes: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  loadAvg: [number, number, number];
  cpus: number;
  llm: { inFlight: number; queued: number; maxConcurrency: number };
}

export function readHostStats(config: Config, manager: WorkspaceManager, llm: LlmQueue): HostStats {
  const [one = 0, five = 0, fifteen = 0] = os.loadavg();
  return {
    running: manager.runningCount(),
    maxRunning: config.maxRunning,
    idleTimeoutMinutes: config.idleTimeoutMs / 60_000,
    memTotalBytes: os.totalmem(),
    memAvailableBytes: memAvailable(),
    loadAvg: [one, five, fifteen],
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
