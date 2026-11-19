"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { axisTicks, formatDay } from "@/lib/live-format";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

const CONFIG = { value: { color: "var(--chart-1)" } } satisfies ChartConfig;
const monthName = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

export interface DayPoint {
  /** YYYY-MM-DD. */
  day: string;
  /** null: no bar that day. */
  value: number | null;
  /** The day's tooltip: each line's name and value. */
  lines: ReadonlyArray<readonly [name: string, value: string]>;
}

interface DayChartProps {
  /** What the bars are, for assistive technology: the card around the chart says it to everyone else. */
  label: string;
  /** Every day of the stretch, in order: days still to come or without a value stay empty, so the stretch shows whole. */
  points: readonly DayPoint[];
  formatTick: (value: number, ticks: readonly number[]) => string;
}

/** One value per day as bars. One series, named by its card, so there is no legend. */
export function DayChart({ label, points, formatTick }: DayChartProps) {
  const ticks = axisTicks(Math.max(0, ...points.map((point) => point.value ?? 0)));
  return (
    <ChartContainer config={CONFIG} className="aspect-auto h-40 w-full" aria-label={label}>
      <BarChart data={[...points]} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap={2} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={12}
          // A month that begins inside the stretch is named at its first day.
          tickFormatter={(day: string) =>
            day.endsWith("-01") && day !== points[0]?.day ? `${monthName.format(new Date(`${day}T00:00:00Z`))} 1` : String(Number(day.slice(8)))
          }
        />
        <YAxis
          width="auto"
          tickLine={false}
          axisLine={false}
          domain={[0, ticks.at(-1) ?? 1]}
          ticks={ticks}
          tickFormatter={(value: number) => (value === 0 ? "0" : formatTick(value, ticks))}
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
              formatter={(_value, _name, item) => (
                <span className="grid w-full gap-1">
                  {(item.payload as DayPoint).lines.map(([name, value]) => (
                    <span key={name} className="flex justify-between gap-4">
                      <span className="text-muted-foreground">{name}</span>
                      <span className="font-medium text-foreground tabular-nums">{value}</span>
                    </span>
                  ))}
                </span>
              )}
            />
          }
        />
        <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}
