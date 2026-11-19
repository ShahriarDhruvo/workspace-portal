"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ENERGY_SOURCE_NAMES, type EnergyCurrency, type EnergyLocation } from "@portal/core/wire";
import type { DayPrice, EnergyMonth, EnergyTotal } from "@/lib/energy";
import { fetchJson, needsReauth } from "@/lib/fetch-json";
import {
  daysOfMonth,
  formatAxisTick,
  formatCost,
  formatDay,
  formatKwh,
  formatMoney,
  formatMonth,
  formatPricePeriod,
  formatUnitPrice,
  formatWh,
  priceUnit,
  sumKnown,
} from "@/lib/live-format";
import { cn } from "@/lib/utils";
import { Estimate } from "@/components/admin/estimate";
import { DataTable, DataTableEmpty, DataTableHead, DataTablePagination, usePagination } from "@/components/common/data-table";
import { DayChart } from "@/components/common/day-chart";
import { PageHeading } from "@/components/layout/page-heading";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InfoIcon, WarningIcon } from "@/components/ui/icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const REFRESH_MS = 60_000;

/**
 * Admin > Energy: both servers' energy and, once a place is picked in Settings, what it cost (a day whose month
 * isn't published yet uses the latest price, marked). On a change of month the old numbers stay on screen, dimmed,
 * until the new ones arrive.
 */
export function EnergyView({ initial }: { initial: EnergyMonth }) {
  const { data, month, choose, pending, error } = useEnergyMonth(initial);
  const [by, setBy] = useState("Servers");
  const current = data.today.slice(0, 7);
  // Each month's days start on the table's first page.
  const { rows, pagination } = usePagination(data.days, data.month);
  const currency = data.location?.currency ?? null;
  // Both servers' kWh on every day of the month, those still to come included.
  const byDay = new Map(data.days.map((day) => [day.day, day]));
  const points = daysOfMonth(data.month).map((day) => {
    const { kwh = null, cost = null } = byDay.get(day) ?? {};
    return { day, value: kwh, lines: [["Energy", `${formatKwh(kwh)} kWh`], ...(currency ? [["Cost", formatMoney(cost, currency)] as const] : [])] as const };
  });

  return (
    <>
      <PageHeading
        title="Energy"
        actions={
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="What is measured">
                  <InfoIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="flex max-w-80 flex-col gap-1">
                <p>Measured by each server&apos;s own power sensor, not at the wall.</p>
                {data.location ? <p>{priceSourceText(data.location)}</p> : null}
              </TooltipContent>
            </Tooltip>
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
          </>
        }
      />
      <div aria-busy={pending || undefined} className={cn("flex flex-col gap-4 transition-opacity", pending && "opacity-60")}>
        {error ? (
          <Alert variant="warning">
            <WarningIcon />
            <AlertDescription>Not up to date: {error}</AlertDescription>
          </Alert>
        ) : null}
        <Card className="py-0">
          <CardContent className="flex flex-col gap-4 p-4">
            <div className="grid grid-cols-2 gap-3">
              <Total label="Today so far" total={data.todayTotal} currency={currency} />
              <Total
                label={data.month === current ? `${formatMonth(data.month).split(" ")[0]} so far` : formatMonth(data.month)}
                total={data.total}
                currency={currency}
              />
            </div>
            {data.location ? null : (
              <p className="text-13 text-muted-foreground">
                To see costs, choose your electricity price location in{" "}
                <Link href="/settings#electricity" className="font-medium text-foreground underline underline-offset-4">
                  Settings
                </Link>
                .
              </p>
            )}
            <DayChart label="Energy per day" points={points} formatTick={formatAxisTick} />
          </CardContent>
        </Card>
        {/* A press on the one already chosen would clear the choice: there is always one. */}
        <ToggleGroup type="single" variant="outline" spacing={0} value={by} onValueChange={(next) => next && setBy(next)} aria-label="Energy of" className="self-end">
          {["Servers", "Users"].map((each) => (
            <ToggleGroupItem key={each} value={each} className="data-[state=off]:text-muted-foreground">
              {each}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {by === "Users" ? (
          <UserEnergy data={data} currency={currency} />
        ) : (
          <DataTable footer={<DataTablePagination {...pagination} label="Energy pages" />} tableProps={{ "aria-label": "Energy per day" }}>
            <TableHeader>
              <TableRow>
                <DataTableHead>Day</DataTableHead>
                <DataTableHead align="right">LLM server (kWh)</DataTableHead>
                <DataTableHead align="right">Portal server (kWh)</DataTableHead>
                <DataTableHead align="right">Total (kWh)</DataTableHead>
                <DataTableHead align="right">{currency ? `Price (${priceUnit(currency)})` : "Price"}</DataTableHead>
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
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      <PriceValue price={day.price} currency={currency} />
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMoney(day.cost, currency)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </DataTable>
        )}
      </div>
    </>
  );
}

/**
 * What each user's LLM requests used in the month, the most first, then the same per day. The first table ends with
 * what no request used, so it adds up to the month.
 */
function UserEnergy({ data, currency }: { data: EnergyMonth; currency: EnergyCurrency | null }) {
  const { rows, pagination } = usePagination(data.users, data.month);
  const totals = new Map<number, { name: string; wh: number; cost: number | null }>();
  for (const { userId, name, wh, cost } of data.users) {
    const total = totals.get(userId);
    totals.set(userId, { name, wh: (total?.wh ?? 0) + wh, cost: sumKnown([total?.cost ?? null, cost]) });
  }
  const users = [...totals].sort(([, a], [, b]) => b.wh - a.wh);
  const used = { wh: users.reduce((sum, [, user]) => sum + user.wh, 0), cost: sumKnown(users.map(([, user]) => user.cost)) ?? 0 };
  const heads = (
    <>
      <DataTableHead align="right" title="Their share of the LLM server's measured energy while their requests ran">
        Energy
      </DataTableHead>
      <DataTableHead align="right">Cost</DataTableHead>
    </>
  );
  const cells = (wh: number | null, cost: number | null) => (
    <>
      <TableCell className="text-right tabular-nums">{wh === null ? "—" : formatWh(wh)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCost(cost, currency)}</TableCell>
    </>
  );
  if (users.length === 0) {
    return (
      <DataTable>
        <TableBody>
          <DataTableEmpty colSpan={1}>No requests to the LLM in {formatMonth(data.month)}.</DataTableEmpty>
        </TableBody>
      </DataTable>
    );
  }
  return (
    <>
      <DataTable tableProps={{ "aria-label": "Energy per user" }}>
        <TableHeader>
          <TableRow>
            <DataTableHead>User</DataTableHead>
            {heads}
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map(([id, user]) => (
            <TableRow key={id}>
              <TableCell className="font-medium">{user.name}</TableCell>
              {cells(user.wh, user.cost)}
            </TableRow>
          ))}
          <TableRow className="text-muted-foreground">
            <TableCell title="Both servers' energy outside anyone's requests">Idle and the portal server</TableCell>
            {cells(
              data.total.kwh === null ? null : Math.max(0, data.total.kwh * 1000 - used.wh),
              data.total.cost === null ? null : Math.max(0, data.total.cost - used.cost),
            )}
          </TableRow>
        </TableBody>
      </DataTable>
      <DataTable footer={<DataTablePagination {...pagination} label="User energy pages" />} tableProps={{ "aria-label": "Energy per user and day" }}>
        <TableHeader>
          <TableRow>
            <DataTableHead>Day</DataTableHead>
            <DataTableHead>User</DataTableHead>
            {heads}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.day} ${row.userId}`}>
              <TableCell>{formatDay(row.day)}</TableCell>
              <TableCell>{row.name}</TableCell>
              {cells(row.wh, row.cost)}
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
    </>
  );
}

/** "EIA's average residential price in Florida, per month." */
function priceSourceText(location: EnergyLocation): string {
  return location.source === "eia"
    ? `Prices: ${ENERGY_SOURCE_NAMES.eia}'s average residential price in ${location.name}, per month.`
    : `Prices: ${ENERGY_SOURCE_NAMES.eurostat}'s household price in ${location.name} with taxes, per half year.`;
}

/**
 * A day's price per kWh. One that stands in for a month not yet published is underlined with dots, and its tooltip
 * says which period it is.
 */
function PriceValue({ price, currency }: { price: DayPrice | null; currency: EnergyCurrency | null }) {
  const text = formatUnitPrice(price?.price, currency);
  if (!price?.estimate) return text;
  return <Estimate text={text}>{formatPricePeriod(price.period)} average, the latest published</Estimate>;
}

/** Energy and, once a place is picked for prices, its cost over a stretch of time, side by side. */
function Total({ label, total, currency }: { label: string; total: EnergyTotal; currency: EnergyCurrency | null }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">
      <h3 className="text-12 text-muted-foreground">{label}</h3>
      <p className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-24 leading-none font-semibold">
        <span>
          {formatKwh(total.kwh)}
          <span className="ml-1 text-13 font-normal text-muted-foreground">kWh</span>
        </span>
        {currency ? <span>{formatMoney(total.cost, currency)}</span> : null}
      </p>
    </section>
  );
}

/**
 * The shown month's data, and `month`, the one asked for: null follows the current month (also across midnight at a
 * month's end). Asks again every REFRESH_MS while the tab is visible; an answer to an earlier request than the latest
 * is dropped.
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
  };
}
