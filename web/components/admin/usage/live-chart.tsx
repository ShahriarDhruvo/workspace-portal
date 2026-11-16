"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { HISTORY_MS } from "@/lib/live-format";
import { cn } from "@/lib/utils";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

export interface LivePoint {
  t: number;
  value: number | null;
}

interface LiveChartProps {
  /** Oldest first, within the last minute. */
  points: readonly LivePoint[];
  /** The series' name (the card's title or the selected total names it, so there is no legend). */
  label: string;
  /** A chart token: var(--chart-1) ... */
  color: string;
  /** The newest frame's time: the right edge. */
  now: number;
  /** The tooltip's value. */
  format: (value: number) => string;
  /** Upper end of the y axis when it is fixed (percentages); otherwise it follows the data. */
  max?: number;
  className?: string;
}

const TICKS_S = [-60, -30, 0];
const axisNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/**
 * One reading over the last minute, as a thin area with a crosshair tooltip: the x axis is seconds before now, the
 * y axis keeps three recessive ticks over solid hairlines. Animation is off: a new point arrives every 500 ms.
 */
export function LiveChart({ points, label, color, now, format, max, className }: LiveChartProps) {
  const config = { value: { label, color } } satisfies ChartConfig;
  const data = points.map((point) => ({ t: point.t, value: point.value }));
  return (
    <ChartContainer config={config} className={cn("aspect-auto h-32 w-full", className)}>
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={[now - HISTORY_MS, now]}
          ticks={TICKS_S.map((s) => now + s * 1000)}
          tickFormatter={(t: number) => (Math.round((t - now) / 1000) === 0 ? "now" : `${Math.round((t - now) / 1000)} s`)}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          allowDataOverflow
        />
        <YAxis
          domain={[0, max ?? "auto"]}
          tickCount={3}
          width={44}
          tickLine={false}
          axisLine={false}
          tickFormatter={(value: number) => axisNumber.format(value)}
          allowDecimals={false}
        />
        <ChartTooltip
          cursor
          isAnimationActive={false}
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(_, payload) => {
                const t = Number(payload?.[0]?.payload?.t);
                const ago = Math.max(0, Math.round((now - t) / 1000));
                return Number.isFinite(t) ? (ago === 0 ? "Now" : `${ago} s ago`) : null;
              }}
              formatter={(value) => (
                <span className="flex w-full justify-between gap-4">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono font-medium text-foreground tabular-nums">{format(Number(value))}</span>
                </span>
              )}
            />
          }
        />
        <Area
          dataKey="value"
          type="monotone"
          stroke="var(--color-value)"
          strokeWidth={2}
          fill="var(--color-value)"
          fillOpacity={0.12}
          isAnimationActive={false}
          connectNulls={false}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
        />
      </AreaChart>
    </ChartContainer>
  );
}
