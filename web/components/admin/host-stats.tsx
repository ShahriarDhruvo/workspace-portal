import type { ReactNode } from "react";
import { formatBytes } from "@/lib/format";
import type { HostStats as HostStatsData } from "@/lib/gateway-types";

// KPI row of stat tiles, styled like the Web Shell's Daemon Status metrics: transparent tiles with a 1px border,
// an 11px uppercase label, a bold mono number and a muted hint. Ratios against a limit get a meter whose fill
// carries severity (info → warning → danger) over a faint neutral track.

type Severity = "normal" | "high" | "critical";

const METER_FILL: Record<Severity, string> = {
  normal: "bg-info",
  high: "bg-warning",
  critical: "bg-danger",
};

function severity(ratio: number): Severity {
  return ratio >= 0.9 ? "critical" : ratio >= 0.75 ? "high" : "normal";
}

function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-1.5 w-full overflow-hidden rounded-full bg-line/55"
    >
      <div className={`h-full min-w-0.75 rounded-full ${METER_FILL[severity(ratio)]}`} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

function Tile({ label, value, caption, meter }: { label: string; value: string; caption: string; meter?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-line-soft px-3.5 py-3">
      <div className="text-11 tracking-[0.04em] text-fg-muted uppercase">{label}</div>
      <div className="mt-1.5 mb-0.5 truncate font-mono text-22 font-bold tabular-nums">{value}</div>
      {meter ? <div className="py-1.5">{meter}</div> : null}
      <div className="text-12 text-fg-muted tabular-nums">{caption}</div>
    </div>
  );
}

export function HostStats({ stats }: { stats: HostStatsData | null }) {
  if (!stats) {
    const unknown = { value: "—", caption: "Unavailable" };
    return (
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {["Workspaces running", "Memory used", "Load average", "LLM requests"].map((label) => (
          <Tile key={label} label={label} {...unknown} />
        ))}
      </div>
    );
  }
  const memUsed = Math.max(0, stats.memTotalBytes - stats.memAvailableBytes);
  const [load1, load5, load15] = stats.loadAvg;
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label="Workspaces running"
        value={`${stats.running} / ${stats.maxRunning}`}
        meter={<Meter value={stats.running} max={stats.maxRunning} label="Running workspaces" />}
        caption={`Idle ones stop after ${stats.idleTimeoutMinutes} min`}
      />
      <Tile
        label="Memory used"
        value={formatBytes(memUsed)}
        meter={<Meter value={memUsed} max={stats.memTotalBytes} label="Memory used" />}
        caption={`of ${formatBytes(stats.memTotalBytes)}`}
      />
      <Tile
        label="Load average"
        value={load1.toFixed(2)}
        caption={`${load5.toFixed(2)} · ${load15.toFixed(2)} over 5 · 15 min, ${stats.cpus} CPUs`}
      />
      <Tile
        label="LLM requests"
        value={`${stats.llm.inFlight} in flight`}
        caption={`${stats.llm.queued} queued · limit ${stats.llm.maxConcurrency}`}
      />
    </div>
  );
}
