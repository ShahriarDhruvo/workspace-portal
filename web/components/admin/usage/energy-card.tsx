"use client";

import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { EnergyMonth, EnergyTotal } from "@/lib/energy";
import { fetchJson, needsReauth } from "@/lib/fetch-json";
import { formatCents, formatDay, formatKwh, formatMonth, formatUsd } from "@/lib/live-format";
import { cn } from "@/lib/utils";
import { DataTable, DataTableEmpty, DataTableHead, DataTablePagination, usePagination } from "@/components/common/data-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoIcon, WarningIcon } from "@/components/ui/icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EnergyChart } from "./energy-chart";
import { PriceDialog } from "./price-dialog";

const REFRESH_MS = 60_000;

/**
 * Both servers' energy and what it cost, from GET /api/admin/energy: today so far and the chosen month (the card's
 * focal numbers), the month's days as bars and as a table, and the electricity price (Prices). The page renders the
 * current month; the card asks again every minute while the tab is visible, and on a change of month, keeping the
 * old numbers on screen, dimmed, until the new ones arrive. `sensors` names what each server measures (its
 * portal-hostd's power label), for the hint. Memoized: the live frames above re-render the page twice a second.
 */
export const EnergyCard = memo(function EnergyCard({ initial, sensors }: { initial: EnergyMonth; sensors: string }) {
  const { data, month, choose, pending, error, reload } = useEnergyMonth(initial);
  const current = data.today.slice(0, 7);
  // Each month's days start on the table's first page.
  const { rows, pagination } = usePagination(data.days, data.month);
  const hint = `Measured by each server's own sensor${sensors ? ` (${sensors})` : ""}, not at the wall.`;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="flex items-center gap-1">
          <h2 className="text-16">Energy</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="What is measured">
                <InfoIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        </CardTitle>
        <CardAction className="flex items-center gap-2">
          <PriceDialog prices={data.prices} today={data.today} onSaved={reload} />
          <Select value={month ?? current} onValueChange={(next) => choose(next === current ? null : next)}>
            <SelectTrigger aria-label="Month" className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {data.months.map((month) => (
                <SelectItem key={month} value={month}>
                  {formatMonth(month)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <div aria-busy={pending || undefined} className={cn("flex flex-col transition-opacity", pending && "opacity-60")}>
        <CardContent className="flex flex-col gap-4 p-4">
          {error ? (
            <Alert variant="warning">
              <WarningIcon />
              <AlertDescription>Not up to date: {error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Total label="Today so far" total={data.todayTotal} />
            <Total label={data.month === current ? `${formatMonth(data.month).split(" ")[0]} so far` : formatMonth(data.month)} total={data.total} />
          </div>
          <EnergyChart month={data.month} days={data.days} />
        </CardContent>
        <DataTable
          variant="flush"
          className="border-t"
          footer={<DataTablePagination {...pagination} label="Energy pages" />}
        >
          <TableHeader>
            <TableRow>
              <DataTableHead>Day</DataTableHead>
              <DataTableHead align="right">LLM server (kWh)</DataTableHead>
              <DataTableHead align="right">Portal server (kWh)</DataTableHead>
              <DataTableHead align="right">Total (kWh)</DataTableHead>
              <DataTableHead align="right">Price (¢/kWh)</DataTableHead>
              <DataTableHead align="right">Cost</DataTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <DataTableEmpty colSpan={6}>No readings in {formatMonth(data.month)}.</DataTableEmpty>
            ) : (
              rows.map((day) => (
                <TableRow key={day.day}>
                  <TableCell>
                    {formatDay(day.day)}
                    {day.day === data.today ? <span className="ml-2 text-muted-foreground">so far</span> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatKwh(day.llmKwh)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatKwh(day.portalKwh)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatKwh(day.kwh)}</TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">{formatCents(day.centsPerKwh)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatUsd(day.usd)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </DataTable>
      </div>
    </Card>
  );
});

/** Energy and its cost over a stretch of time, side by side. */
function Total({ label, total }: { label: string; total: EnergyTotal }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">
      <h3 className="text-12 text-muted-foreground">{label}</h3>
      <p className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-24 leading-none font-semibold">
        <span>
          {formatKwh(total.kwh)}
          <span className="ml-1 text-13 font-normal text-muted-foreground">kWh</span>
        </span>
        <span>{formatUsd(total.usd)}</span>
      </p>
    </section>
  );
}

/**
 * The shown month's data, and `month`, the one asked for (the month picker shows it while its data loads): null
 * follows the current month (also across midnight at a month's end). Asks again every REFRESH_MS while the tab is
 * visible and when it becomes visible; an answer for an earlier request than the latest is dropped. A session that
 * is no longer an admin's re-renders the page, which redirects.
 */
function useEnergyMonth(initial: EnergyMonth) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [month, setMonth] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(
    async (target: string | null, shown: boolean) => {
      const id = ++latest.current;
      if (shown) setPending(true);
      const result = await fetchJson<EnergyMonth>(target ? `/api/admin/energy?month=${target}` : "/api/admin/energy");
      if (id !== latest.current) return;
      setPending(false);
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else if (needsReauth(result) || result.status === 403) {
        router.refresh();
      } else {
        setError(result.error.message);
      }
    },
    [router],
  );

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load(month, false);
    };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, month]);

  return {
    data,
    month,
    pending,
    error,
    choose: (next: string | null) => {
      setMonth(next);
      void load(next, true);
    },
    reload: () => void load(month, false),
  };
}
