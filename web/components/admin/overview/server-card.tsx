"use client";

import type { ReactNode } from "react";
import { formatBytes } from "@/lib/format";
import { formatBandwidth, formatBytesOf, formatClock, formatClockOrIdle, formatNumber, formatPercent, formatTemp, formatWatts, memoryFree } from "@/lib/live-format";
import type { HostLive, HostSample } from "@/lib/live-types";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { LiveChart } from "./live-chart";

const TITLES = { llm: "LLM server", portal: "Portal server" } as const;

const STATES: Record<HostLive["state"], ReactNode> = {
  online: <Badge variant="success">Online</Badge>,
  connecting: <Badge variant="secondary">Connecting</Badge>,
  offline: <Badge variant="destructive">Can&apos;t reach</Badge>,
  off: <Badge variant="secondary">Not set up</Badge>,
};

/**
 * One server's readings from its portal-hostd, every 500 ms: total power draw (the card's focal number, charted
 * over the last minute), then CPU, GPU and memory. Unknown readings show "—"; a server without portal-hostd says how
 * to set it up.
 */
export function ServerCard({ host, history, now }: { host: HostLive; history: readonly HostSample[]; now: number }) {
  const sample = host.state === "online" ? host.sample : null;
  const info = host.info;
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="flex items-center gap-2">
          <h2 className="text-16">{TITLES[host.role]}</h2>
          {STATES[host.state]}
          {sample?.throttling ? <Badge variant="warning">Throttling</Badge> : null}
        </CardTitle>
        <CardDescription className="truncate" title={info ? `${info.os} · ${info.kernel}` : undefined}>
          {info ? (
            <>
              {/* A machine without a hostname of its own reports "localhost": then the CPU says enough. */}
              {/^localhost\b/.test(info.hostname) ? null : <span className="font-mono">{info.hostname} · </span>}
              {info.cpu.model}
            </>
          ) : (
            "portal-hostd"
          )}
        </CardDescription>
        {sample ? (
          <CardAction className="flex flex-col items-end gap-0.5" title={info?.power?.label ?? undefined}>
            <span className="font-mono text-24 leading-none font-medium tabular-nums">{formatWatts(sample.power.watts)}</span>
            <span className="text-12 text-muted-foreground">{info?.power ? "Power draw" : "Power: not measurable"}</span>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4 py-4">
        {sample ? <Readings host={host} sample={sample} history={history} now={now} /> : <NoReadings host={host} />}
      </CardContent>
    </Card>
  );
}

function Readings({ host, sample, history, now }: { host: HostLive; sample: HostSample; history: readonly HostSample[]; now: number }) {
  const info = host.info;
  const { cpu, gpu, memory } = sample;
  const free = memoryFree(sample);
  const usedPercent = memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : null;
  const fans = sample.fans.filter((fan) => fan.rpm !== null && fan.rpm > 0);
  return (
    <>
      {sample.power.watts !== null ? (
        <LiveChart
          points={history.map((point) => ({ t: point.t, value: point.power.watts }))}
          label="Power, W"
          color="var(--chart-1)"
          now={now}
          format={(value) => formatNumber(value)}
          className="h-24"
        />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <Meter title="CPU" percent={cpu.usage}>
          <Reading label="Clock" value={formatClockOrIdle(cpu.mhz, cpu.usage)} hint={info?.cpu.maxMhz ? `Average of all cores; up to ${formatClock(info.cpu.maxMhz)}` : "Average of all cores"} />
          <Reading label="Fastest core" value={formatClockOrIdle(cpu.mhzPeak, cpu.usage)} />
          <Reading label="Temperature" value={formatTemp(cpu.tempC)} />
          <Reading label="Power" value={formatWatts(cpu.powerW)} />
        </Meter>
        <Meter title={gpu ? "GPU" : "GPU: none found"} percent={gpu?.usage ?? null}>
          <Reading label="Clock" value={formatClockOrIdle(gpu?.mhz, gpu?.usage)} hint={info?.gpu?.maxMhz ? `Up to ${formatClock(info.gpu.maxMhz)}` : undefined} />
          <Reading label="Temperature" value={formatTemp(gpu?.tempC)} />
          <Reading label="Power" value={formatWatts(gpu?.powerW)} />
          {memory.gpuBytes !== null ? (
            <Reading label="Memory" value={formatBytes(memory.gpuBytes)} hint="System memory the GPU uses (GTT and VRAM)" />
          ) : gpu?.memUsedBytes !== null && gpu?.memUsedBytes !== undefined ? (
            <Reading label="Memory" value={formatBytes(gpu.memUsedBytes)} />
          ) : null}
        </Meter>
        <Meter title="Memory" percent={usedPercent}>
          <Reading
            label="Free"
            value={`${formatBytes(free.bytes)} (${formatPercent(free.percent)})`}
            hint="MemAvailable: free memory plus cache the system can drop"
          />
          <Reading label="Used" value={formatBytesOf(memory.usedBytes, memory.totalBytes)} />
          <Reading
            label="Bandwidth"
            value={memory.readBps === null && memory.writeBps === null ? "—" : formatBandwidth((memory.readBps ?? 0) + (memory.writeBps ?? 0))}
            hint={
              memory.readBps === null
                ? "Not measurable on this machine"
                : `Read ${formatBandwidth(memory.readBps)} · write ${formatBandwidth(memory.writeBps)}`
            }
          />
          {memory.swapTotalBytes > 0 ? <Reading label="Swap" value={formatBytesOf(memory.swapUsedBytes, memory.swapTotalBytes)} /> : null}
        </Meter>
      </div>
      {fans.length > 0 ? (
        <p className="text-12 text-muted-foreground tabular-nums">
          Fans: {fans.map((fan) => `${fan.label} ${formatNumber(fan.rpm)} rpm`).join(" · ")}
        </p>
      ) : null}
    </>
  );
}

/** A block of readings under a headline usage percentage and its bar. */
function Meter({ title, percent, children }: { title: string; percent: number | null; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/40 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-13 font-medium">{title}</h3>
        <span className="font-mono text-18 leading-6 font-medium tabular-nums">{formatPercent(percent)}</span>
      </div>
      <Progress value={percent === null ? 0 : Math.min(100, Math.max(0, percent))} aria-label={`${title} usage`} />
      <dl className="flex flex-col gap-1 text-12">{children}</dl>
    </section>
  );
}

/** One row; each label takes only its own width, and a value too long for the row moves under it, right-aligned. */
function Reading({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="ml-auto text-right font-mono tabular-nums" title={hint}>
        {value}
      </dd>
    </div>
  );
}

function NoReadings({ host }: { host: HostLive }) {
  if (host.state === "connecting" || (host.state === "online" && host.sample === null)) {
    return (
      <div className="grid gap-3 sm:grid-cols-3" aria-busy="true" aria-label="Waiting for readings">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-32 rounded-lg" />
        ))}
      </div>
    );
  }
  if (host.state === "offline") {
    return (
      <Empty className="border py-8">
        <EmptyHeader>
          <EmptyTitle className="text-14">Can&apos;t reach this server&apos;s portal-hostd</EmptyTitle>
          <EmptyDescription>
            <span className="block">Trying again by itself.</span>
            {host.error ? <span className="block font-mono text-12 wrap-anywhere">{host.error}</span> : null}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Empty className="border py-8">
      <EmptyHeader>
        <EmptyTitle className="text-14">No readings: portal-hostd isn&apos;t set up</EmptyTitle>
        <EmptyDescription>
          {host.role === "portal" ? (
            <>
              Run <code className="font-mono text-12">sudo bash deploy/install.sh</code> in the portal&apos;s folder; it
              installs it.
            </>
          ) : (
            <>
              On the LLM server run{" "}
              <code className="font-mono text-12 wrap-anywhere">sudo bash ~/workspace-portal/hostd/install.sh llm --portal PORTAL_IP</code>,
              put the two lines it prints into the portal&apos;s <code className="font-mono text-12">.env</code>, then run{" "}
              <code className="font-mono text-12">sudo docker compose up -d</code>.
            </>
          )}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
