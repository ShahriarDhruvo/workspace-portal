"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { EnergyDay } from "@/lib/energy";
import { axisTicks, daysOfMonth, formatDay, formatKwh, formatUsd } from "@/lib/live-format";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

const CONFIG = { kwh: { label: "Energy", color: "var(--chart-1)" } } satisfies ChartConfig;

const axisKwh = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });

/**
 * Both servers' kWh per day across the whole month (days still to come stay empty, so the month's progress shows),
 * one series in the first chart colour: the card's title names it, so there is no legend. Thin columns from one
 * baseline, rounded at the data end, over solid hairlines; each column's tooltip gives the day, its kWh and its cost
 * (the table under the chart has every value too).
 */
export function EnergyChart({ month, days }: { month: string; days: readonly EnergyDay[] }) {
  const byDay = new Map(days.map((day) => [day.day, day]));
  const data = daysOfMonth(month).map((day) => ({ day, kwh: byDay.get(day)?.kwh ?? null, usd: byDay.get(day)?.usd ?? null }));
  const ticks = axisTicks(Math.max(0, ...data.map((point) => point.kwh ?? 0)));
  return (
    <ChartContainer config={CONFIG} className="aspect-auto h-40 w-full" aria-label="Energy per day">
      <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap={2} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={12}
          tickFormatter={(day: string) => String(Number(day.slice(8)))}
        />
        <YAxis
          width={44}
          tickLine={false}
          axisLine={false}
          domain={[0, ticks.at(-1) ?? 1]}
          ticks={ticks}
          tickFormatter={(kwh: number) => axisKwh.format(kwh)}
        />
        <ChartTooltip
          cursor={{ fillOpacity: 0.5 }}
          isAnimationActive={false}
          content={
            <ChartTooltipContent
              hideIndicator
              labelFormatter={(_, payload) => {
                const day = payload?.[0]?.payload?.day;
                return typeof day === "string" ? formatDay(day) : null;
              }}
              formatter={(value, _name, item) => (
                <span className="grid w-full gap-1">
                  <span className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Energy</span>
                    <span className="font-medium text-foreground tabular-nums">{formatKwh(Number(value))} kWh</span>
                  </span>
                  <span className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Cost</span>
                    <span className="font-medium text-foreground tabular-nums">{formatUsd(item.payload?.usd ?? null)}</span>
                  </span>
                </span>
              )}
            />
          }
        />
        <Bar dataKey="kwh" fill="var(--color-kwh)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}
