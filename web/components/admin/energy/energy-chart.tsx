"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { EnergyCurrency } from "@portal/db";
import type { EnergyDay } from "@/lib/energy";
import { axisTicks, daysOfMonth, formatAxisTick, formatDay, formatKwh, formatMoney } from "@/lib/live-format";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

const CONFIG = { kwh: { label: "Energy", color: "var(--chart-1)" } } satisfies ChartConfig;

/**
 * Both servers' kWh per day across the whole month (days still to come stay empty, so the month's progress shows),
 * one series in the first chart colour: the card's title names it, so there is no legend. Thin columns from one
 * baseline, rounded at the data end, over solid hairlines; each column's tooltip gives the day, its kWh and, once a
 * place is picked for prices (`currency`), its cost (the table under the chart has every value too).
 */
export function EnergyChart({ month, days, currency }: { month: string; days: readonly EnergyDay[]; currency: EnergyCurrency | null }) {
  const byDay = new Map(days.map((day) => [day.day, day]));
  const data = daysOfMonth(month).map((day) => ({ day, kwh: byDay.get(day)?.kwh ?? null, cost: byDay.get(day)?.cost ?? null }));
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
          tickFormatter={(kwh: number) => formatAxisTick(kwh, ticks)}
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
                  {currency ? (
                    <span className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Cost</span>
                      <span className="font-medium text-foreground tabular-nums">{formatMoney(item.payload?.cost ?? null, currency)}</span>
                    </span>
                  ) : null}
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
