"use client";

import type { ReactNode } from "react";
import { formatBytes } from "@/lib/format";
import {
  formatBandwidth,
  formatBytesOf,
  formatClock,
  formatClockOrIdle,
  formatNumber,
  formatPercent,
  formatRate,
  formatTemp,
  formatWatts,
  hottestChip,
  memoryFree,
  usedPercent,
} from "@/lib/live-format";
import type { HostLive, HostSample } from "@portal/core/wire";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon } from "@/components/ui/icons";
import { Progress } from "@/components/ui/progress";
import { LiveChart } from "./live-chart";
import { DETAIL_GRID, METRIC_GRID, ServerBodySkeleton } from "./usage-skeleton";

const TITLES = { llm: "AI server", portal: "Portal server" } as const;

const STATES: Record<HostLive["state"], ReactNode> = {
  online: <Badge variant="success">Online</Badge>,
  connecting: <Badge variant="secondary">Connecting</Badge>,
  offline: <Badge variant="destructive">Can&apos;t reach</Badge>,
  off: <Badge variant="secondary">Not set up</Badge>,
};

/**
 * One server's readings from its portal-hostd. A reading the server can't give shows "—"; a server without
 * portal-hostd says how to set it up.
 */
export function ServerCard({ host, history, now }: { host: HostLive; history: readonly HostSample[]; now: number }) {
  const sample = host.state === "online" ? host.sample : null;
  const info = host.info;
  return (
    <Card className="gap-0 py-0 xl:has-data-[state=open]:row-span-2">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-16">{TITLES[host.role]}</h2>
          {STATES[host.state]}
          {sample?.throttling ? <Badge variant="warning">Throttling</Badge> : null}
        </CardTitle>
        <CardDescription className="truncate" title={info?.cpu.model}>
          {info?.cpu.model ?? "portal-hostd"}
        </CardDescription>
        {sample ? <HeaderStats sample={sample} powerMeasurable={Boolean(info?.power)} /> : null}
      </CardHeader>
      {sample ? <Readings host={host} sample={sample} history={history} now={now} /> : <NoReadings host={host} />}
    </Card>
  );
}

/** The hotter chip's temperature (none without a sensor) and the power draw, each a figure over what it is. */
function HeaderStats({ sample, powerMeasurable }: { sample: HostSample; powerMeasurable: boolean }) {
  const hottest = hottestChip(sample);
  const watts = sample.power.watts;
  return (
    <CardAction className="flex items-start gap-4">
      {hottest ? <HeaderStat value={String(hottest.celsius)} unit="°C" caption={`${hottest.chip} temp`} /> : null}
      <HeaderStat value={formatNumber(watts)} unit={watts === null ? null : "W"} caption={powerMeasurable ? "Power draw" : "Power: not measurable"} />
    </CardAction>
  );
}

function HeaderStat({ value, unit, caption }: { value: string; unit: string | null; caption: string }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-24 leading-none font-semibold whitespace-nowrap tabular-nums">
        {value}
        {unit ? <span className="ml-1 text-13 font-normal text-muted-foreground">{unit}</span> : null}
      </span>
      <span className="text-12 whitespace-nowrap text-muted-foreground">{caption}</span>
    </div>
  );
}

function Readings({ host, sample, history, now }: { host: HostLive; sample: HostSample; history: readonly HostSample[]; now: number }) {
  const { cpu, gpu, memory, net, disk } = sample;
  const free = memoryFree(sample);
  const diskUsed = disk?.totalBytes && disk.freeBytes !== null ? disk.totalBytes - disk.freeBytes : null;
  const today = host.today;
  return (
    <Collapsible className="flex flex-1 flex-col">
      <CardContent className="@container flex flex-1 flex-col gap-4 p-4">
        {sample.power.watts !== null ? (
          <LiveChart
            points={history.map((point) => ({ t: point.t, value: point.power.watts }))}
            label="Power, W"
            color="var(--chart-1)"
            now={now}
            format={formatWatts}
            className="h-auto min-h-24 flex-1"
          />
        ) : null}
        <div className={METRIC_GRID}>
          <Metric label="CPU" value={formatPercent(cpu.usage)} share={cpu.usage} />
          <Metric label="GPU" value={formatPercent(gpu?.usage)} share={gpu?.usage ?? null} />
          <Metric label="Memory" value={formatPercent(usedPercent(memory.usedBytes, memory.totalBytes))} share={usedPercent(memory.usedBytes, memory.totalBytes)}>
            {formatBytes(free.bytes)} free
          </Metric>
          <Metric
            label="Disk"
            value={disk?.freeBytes == null ? "—" : formatBytes(disk.freeBytes)}
            unit={disk?.freeBytes == null ? undefined : "free"}
            share={usedPercent(diskUsed, disk?.totalBytes)}
          >
            <Fact short="R" name="Read" value={formatRate(disk?.readBps)} />
            <Fact short="W" name="Write" value={formatRate(disk?.writeBps)} />
          </Metric>
          <section className="col-span-2 flex min-w-0 flex-col gap-2 rounded-lg bg-muted/40 p-3">
            <h3 className="text-12 text-muted-foreground">Network</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Direction icon={<ArrowDownIcon aria-label="Download" />} rate={net?.rxBps} today={today?.rxBytes} />
              <Direction icon={<ArrowUpIcon aria-label="Upload" />} rate={net?.txBps} today={today?.txBytes} />
            </div>
          </section>
        </div>
        <Readouts host={host} sample={sample} />
        <CollapsibleContent>
          <Details host={host} sample={sample} />
        </CollapsibleContent>
      </CardContent>
      <CardFooter className="p-0">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="group/details h-10 w-full rounded-none text-muted-foreground">
            Details
            <ChevronDownIcon className="transition-transform group-data-[state=open]/details:rotate-180" />
          </Button>
        </CollapsibleTrigger>
      </CardFooter>
    </Collapsible>
  );
}

// The quiet facts' size: 12 px, smaller in a phone's narrow tile (down to 10 px) so that Disk's longest pair,
// "R 999 MB/s  W 999 MB/s" (130 px at 12 px in Noto Sans, 3% added for other system fonts, and the 6 px gap),
// stays on one line. A tile is a container, so 100cqi is its width inside the padding.
const FACT_SIZE = "clamp(10px, calc((100cqi - 6px) * 12 / 134), 12px)";

/**
 * One metric: a figure, a bar when it is a share of a whole (null: unknown, an empty bar) and at most two quiet
 * facts on one line, so the tiles keep their height whatever the figures.
 */
function Metric({ label, value, unit, share, children }: { label: string; value: string; unit?: string; share?: number | null; children?: ReactNode }) {
  return (
    <section className="@container flex min-w-0 flex-col gap-2 rounded-lg bg-muted/40 p-3">
      <h3 className="text-12 text-muted-foreground">{label}</h3>
      <p className="text-22 font-semibold tabular-nums">
        {value}
        {unit ? <span className="ml-1 text-13 font-normal text-muted-foreground">{unit}</span> : null}
      </p>
      {share !== undefined ? <Progress value={share ?? 0} aria-label={`${label} used`} /> : null}
      {children ? (
        <p className="flex flex-wrap gap-x-1.5 text-12 whitespace-nowrap text-muted-foreground tabular-nums" style={{ fontSize: FACT_SIZE }}>
          {children}
        </p>
      ) : null}
    </section>
  );
}

/** A fact with a one-letter name ("R 69 kB/s"); screen readers hear the whole word. */
function Fact({ short, name, value }: { short: string; name: string; value: string }) {
  return (
    <span title={`${name} ${value}`}>
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{name}</span> {value}
    </span>
  );
}

/** Network one way: the rate now and the bytes since midnight. */
function Direction({ icon, rate, today }: { icon: ReactNode; rate: number | null | undefined; today: number | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="flex items-center gap-1 text-22 font-semibold tabular-nums">
        <span className="text-muted-foreground">{icon}</span>
        {formatRate(rate)}
      </p>
      <p className="truncate text-12 text-muted-foreground tabular-nums">{today === undefined ? "—" : `${formatBytes(today)} today`}</p>
    </div>
  );
}

/** The readings behind CPU, GPU and memory. */
function Readouts({ host, sample }: { host: HostLive; sample: HostSample }) {
  const info = host.info;
  const { cpu, gpu, memory } = sample;
  const free = memoryFree(sample);
  const gpuMemory = memory.gpuBytes ?? gpu?.memUsedBytes ?? null;
  return (
    <div className={cn(DETAIL_GRID, "border-t pt-4")}>
      <DetailGroup title="CPU">
        <Reading label="Clock" value={formatClockOrIdle(cpu.mhz, cpu.usage)} />
        <Reading label="Up to" value={formatClock(info?.cpu.maxMhz)} />
        <Reading label="Temperature" value={formatTemp(cpu.tempC)} />
        <Reading label="Power" value={formatWatts(cpu.powerW)} />
        {info ? <Reading label="Cores" value={`${info.cpu.cores} · ${info.cpu.threads} threads`} /> : null}
      </DetailGroup>
      <DetailGroup title="GPU">
        <Reading label="Clock" value={formatClockOrIdle(gpu?.mhz, gpu?.usage)} />
        <Reading label="Up to" value={formatClock(info?.gpu?.maxMhz)} />
        <Reading label="Temperature" value={formatTemp(gpu?.tempC)} />
        <Reading label="Power" value={formatWatts(gpu?.powerW)} />
        <Reading label="Memory" value={gpuMemory === null ? "—" : formatBytes(gpuMemory)} />
      </DetailGroup>
      <DetailGroup title="Memory">
        <Reading label="Used" value={formatBytesOf(memory.usedBytes, memory.totalBytes)} />
        <Reading label="Free" value={`${formatBytes(free.bytes)} (${formatPercent(free.percent)})`} />
        <Reading label="Swap" value={memory.swapTotalBytes > 0 ? formatBytesOf(memory.swapUsedBytes, memory.swapTotalBytes) : "—"} />
        <Reading
          label="Bandwidth"
          value={memory.readBps === null && memory.writeBps === null ? "—" : formatBandwidth((memory.readBps ?? 0) + (memory.writeBps ?? 0))}
        />
      </DetailGroup>
    </div>
  );
}

function Details({ host, sample }: { host: HostLive; sample: HostSample }) {
  const info = host.info;
  const { disk } = sample;
  const fans = sample.fans.filter((fan) => fan.rpm !== null && fan.rpm > 0);
  return (
    <div className={DETAIL_GRID}>
      <DetailGroup title="Disk">
        <Reading
          label="Used"
          value={disk?.totalBytes && disk.freeBytes !== null ? formatBytesOf(disk.totalBytes - disk.freeBytes, disk.totalBytes) : "—"}
        />
        <Reading label="Disks" value={info?.disks?.devices.join(", ") || "—"} />
      </DetailGroup>
      <DetailGroup title="Network">
        <Reading label="Interfaces" value={info?.network?.interfaces.join(", ") || "—"} />
      </DetailGroup>
      {fans.length > 0 ? (
        <DetailGroup title="Fans">
          {fans.map((fan) => (
            <Reading key={fan.label} label={fan.label} value={`${formatNumber(fan.rpm)} rpm`} />
          ))}
        </DetailGroup>
      ) : null}
      {info ? (
        <DetailGroup title="System" className="col-span-2">
          <Reading label="Power sensor" value={info.power?.label ?? "—"} />
          <Reading label="System" value={info.os} />
          <Reading label="Kernel" value={info.kernel} />
        </DetailGroup>
      ) : null}
    </div>
  );
}

function DetailGroup({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <h3 className="text-12 font-medium">{title}</h3>
      <dl className="flex flex-col gap-1 text-12">{children}</dl>
    </section>
  );
}

/** One row; each label takes only its own width, and a value too long for the row moves under it, right-aligned. */
function Reading({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="ml-auto text-right tabular-nums wrap-anywhere">{value}</dd>
    </div>
  );
}

function NoReadings({ host }: { host: HostLive }) {
  if (host.state === "connecting" || (host.state === "online" && host.sample === null)) {
    return <ServerBodySkeleton busyLabel="Waiting for readings" />;
  }
  return (
    <CardContent className="flex flex-1 flex-col p-4">
      {host.state === "offline" ? (
        <Empty className="flex-1 border py-8">
          <EmptyHeader>
            <EmptyTitle className="text-14">Can&apos;t reach this server&apos;s portal-hostd</EmptyTitle>
            <EmptyDescription>
              <span className="block">Trying again by itself.</span>
              {host.error ? <span className="block font-mono text-12 wrap-anywhere">{host.error}</span> : null}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Empty className="flex-1 border py-8">
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
                  On the AI server run{" "}
                  <code className="font-mono text-12 wrap-anywhere">sudo bash ~/workspace-portal/hostd/install.sh llm --portal PORTAL_IP</code>,
                  put the two lines it prints into the portal&apos;s <code className="font-mono text-12">.env</code>, then run{" "}
                  <code className="font-mono text-12">sudo docker compose up -d</code>.
                </>
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </CardContent>
  );
}
