"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EnergyCurrency } from "@portal/core/wire";
import { createKey, revokeKey } from "@/lib/actions/api-keys";
import type { ApiKeyRow, ApiKeysView } from "@/lib/api-keys";
import { returnFocus } from "@/lib/focus";
import { formatCount } from "@/lib/format";
import { sumUse, type KeyUse } from "@/lib/key-use";
import { API_KEY_NAME_MAX_LENGTH, MAX_API_KEYS } from "@/lib/limits";
import { daysUntil, formatCost, formatDay, formatWh } from "@/lib/live-format";
import { PAGE_SIZES } from "@/lib/pagination";
import { cn } from "@/lib/utils";
import { Estimate } from "@/components/admin/estimate";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataTable, DataTableEmpty, DataTableHead, DataTablePagination, usePagination } from "@/components/common/data-table";
import { DayChart } from "@/components/common/day-chart";
import { GuardedButton } from "@/components/common/guarded-button";
import { SecretValue } from "@/components/common/secret-value";
import { FormError } from "@/components/forms/form-error";
import { FormField } from "@/components/forms/form-field";
import { SubmitButton } from "@/components/forms/submit-button";
import { LocalTime } from "@/components/local-time";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { KeyIcon, PlusIcon } from "@/components/ui/icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";

const REFRESH_MS = 30_000;
/** The days the tiles add up and the chart shows. */
const WINDOW_DAYS = 30;
const number = "text-right tabular-nums";

/** What the tiles count and the chart can show, in the tiles' order. */
const METRICS: ReadonlyArray<{ id: string; label: string; of: (use: KeyUse) => number | null; show: (value: number, currency: EnergyCurrency | null) => string }> = [
  { id: "requests", label: "Requests", of: (use) => use.requests, show: (count) => count.toLocaleString("en") },
  { id: "in", label: "Tokens in", of: (use) => use.tokensIn, show: formatCount },
  { id: "out", label: "Tokens out", of: (use) => use.tokensOut, show: formatCount },
  { id: "energy", label: "Energy", of: (use) => use.energyWh, show: formatWh },
  { id: "cost", label: "Cost", of: (use) => use.cost, show: formatCost },
];

/** The API page below its connection card: the user's working keys, then what the keys used. */
export function ApiKeys(view: ApiKeysView) {
  const { keys, days, currency, today } = view;
  const router = useRouter();
  const create = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);

  // What other software uses shows without a reload.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);

  const createButton = (
    <GuardedButton
      ref={create}
      type="button"
      blockedReason={keys.length >= MAX_API_KEYS ? `You have ${MAX_API_KEYS} keys. Revoke one to create another.` : null}
      onClick={() => setCreating(true)}
    >
      <PlusIcon />
      Create key
    </GuardedButton>
  );

  return (
    <>
      <Titled title="Keys" note={keys.length > 0 ? `${keys.length} of ${MAX_API_KEYS}` : null} action={keys.length > 0 ? createButton : null}>
        {keys.length === 0 ? (
          <Empty className="border py-10">
            <EmptyHeader>
              <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <KeyIcon />
              </span>
              <EmptyTitle>No keys yet</EmptyTitle>
              <EmptyDescription>
                Create one for each program that connects. You see what each one uses, and can revoke one without touching the others.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{createButton}</EmptyContent>
          </Empty>
        ) : (
          <DataTable
            tableProps={{
              "aria-label": "Keys",
              // A narrow screen shows the key, its last use and Revoke without scrolling sideways: the numbers are under Usage.
              className: "max-md:[&_:is(th,td):not(:first-child,:nth-child(3),:last-child)]:hidden",
            }}
          >
            <TableHeader>
              <TableRow>
                <DataTableHead>Key</DataTableHead>
                <DataTableHead>Created</DataTableHead>
                <DataTableHead>Last used</DataTableHead>
                <UseHeads />
                <DataTableHead>
                  <span className="sr-only">Actions</span>
                </DataTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.id}>
                  {/* The name takes the width the other columns leave. */}
                  <TableCell className="w-full max-w-0">
                    <div className="truncate font-medium" title={key.name}>
                      {key.name}
                    </div>
                    <div className="font-mono text-12 text-muted-foreground" title="How the key ends">
                      sk-…{key.hint}
                    </div>
                  </TableCell>
                  <TableCell>
                    <LocalTime at={key.createdAt} relative />
                  </TableCell>
                  <TableCell>
                    {key.lastUsed === null ? <span className="text-muted-foreground">Never</span> : key.lastUsed === today ? "Today" : formatDay(key.lastUsed)}
                  </TableCell>
                  <UseCells use={key} currency={currency} />
                  <TableCell className="text-right">
                    <Button type="button" variant="outline" size="sm" onClick={() => setRevoking(key)}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Titled>

      {days.length > 0 ? (
        <Usage {...view} />
      ) : keys.length > 0 ? (
        <Titled title="Usage">
          <Card>
            <CardContent className="py-6 text-center text-muted-foreground">
              Nothing yet. What your keys use shows here within half a minute of a request.
            </CardContent>
          </Card>
        </Titled>
      ) : null}

      <AlertDialog open={creating} onOpenChange={setCreating}>
        <AlertDialogContent onCloseAutoFocus={returnFocus(create)}>
          <CreateKeyForm onClose={() => setCreating(false)} />
        </AlertDialogContent>
      </AlertDialog>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => (open ? undefined : setRevoking(null))}
        title="Revoke key?"
        confirm="Revoke"
        pending="Revoking…"
        destructive
        onConfirm={() => revokeKey(revoking!.id)}
        onDone={() => {}}
        // Its own button goes with the key.
        returnFocusTo={create}
      >
        <p>
          Software that uses <strong className="font-medium text-foreground">{revoking?.name}</strong> stops working at once. What the key used
          stays under Usage.
        </p>
      </ConfirmDialog>
    </>
  );
}

/**
 * What the keys used: the last WINDOW_DAYS in tiles and a chart of the tile that is chosen, then every day in a
 * table. One key can be looked at alone.
 */
function Usage({ days, currency, today }: ApiKeysView) {
  const [keyId, setKeyId] = useState("all");
  const [metricId, setMetricId] = useState("in");
  // Every key that was used, revoked ones included: `days` has a row for each of its days.
  const used = [...new Map(days.map((day) => [day.keyId, day])).values()];
  const shown = useMemo(() => (keyId === "all" ? days : days.filter((day) => String(day.keyId) === keyId)), [days, keyId]);
  const { rows, pagination } = usePagination(shown, keyId);

  const metrics = METRICS.filter((metric) => metric.id !== "cost" || currency !== null);
  const metric = metrics.find((each) => each.id === metricId) ?? metrics[0]!;
  const text = (which: (typeof METRICS)[number], use: KeyUse): string => {
    const value = which.of(use);
    return value === null ? "—" : which.show(value, currency);
  };
  const recent = daysUntil(today, WINDOW_DAYS).map((day) => ({ day, use: sumUse(shown.filter((each) => each.day === day)) }));
  const total = sumUse(recent.map((each) => each.use));

  return (
    <Titled
      title="Usage"
      action={
        used.length > 1 ? (
          <Select value={keyId} onValueChange={setKeyId}>
            <SelectTrigger aria-label="Key" className="min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="all">All keys</SelectItem>
              {used.map((key) => (
                <SelectItem key={key.keyId} value={String(key.keyId)}>
                  {key.name}
                  {key.revoked ? " (revoked)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null
      }
    >
      <Card className="py-0">
        <CardContent className="flex flex-col gap-4 p-4">
          <p className="text-12 text-muted-foreground">Last {WINDOW_DAYS} days</p>
          <div role="group" aria-label="What the chart shows" className="-mt-1 grid grid-cols-2 gap-3 md:grid-flow-col md:auto-cols-fr md:grid-cols-none">
            {metrics.map((each) => (
              <button
                key={each.id}
                type="button"
                aria-pressed={each === metric}
                onClick={() => setMetricId(each.id)}
                className={cn(
                  // In two columns a fifth tile takes the whole last row.
                  "flex min-w-0 flex-col gap-1.5 rounded-lg border border-transparent bg-muted/40 p-3 text-left transition-colors outline-none hover:bg-muted/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 max-md:last:odd:col-span-2",
                  each === metric && "border-ring bg-muted/70",
                )}
              >
                <span className="flex items-center gap-1.5 text-12 text-muted-foreground">
                  {each === metric ? <span className="size-1.5 rounded-full bg-(--chart-1)" /> : null}
                  {each.label}
                </span>
                <span className="text-22 font-semibold tabular-nums">{text(each, total)}</span>
                <span className="text-12 text-muted-foreground tabular-nums">Today {text(each, recent.at(-1)!.use)}</span>
              </button>
            ))}
          </div>
          <DayChart
            label={`${metric.label} per day`}
            points={recent.map(({ day, use }) => ({
              day,
              value: metric.of(use),
              lines: metrics.map((each) => [each.label, text(each, use)] as const),
            }))}
            formatTick={(value) => metric.show(value, currency)}
          />
        </CardContent>
      </Card>
      <DataTable
        // Rows that fit the smallest page need no pager.
        footer={shown.length > PAGE_SIZES[0]! ? <DataTablePagination {...pagination} label="Usage pages" /> : null}
        tableProps={{ "aria-label": "Usage by day" }}
      >
        <TableHeader>
          <TableRow>
            <DataTableHead>Day</DataTableHead>
            <DataTableHead>Key</DataTableHead>
            <DataTableHead align="right" title="Requests that reached the LLM server">
              Requests
            </DataTableHead>
            <UseHeads />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((day) => (
            <TableRow key={`${day.day} ${day.keyId}`}>
              <TableCell>{day.day === today ? "Today" : formatDay(day.day)}</TableCell>
              <TableCell>
                <span className="inline-block max-w-40 truncate align-bottom" title={day.name}>
                  {day.name}
                </span>
                {day.revoked ? <Quiet>revoked</Quiet> : null}
              </TableCell>
              <TableCell className={number}>
                {formatCount(day.requests)}
                {day.failed > 0 ? <Quiet className="text-destructive">{formatCount(day.failed)} failed</Quiet> : null}
              </TableCell>
              <UseCells use={day} currency={currency} />
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
    </Titled>
  );
}

/** A part of the page under its heading, with a quiet note beside it and its control at the right. */
function Titled({ title, note, action, children }: { title: string; note?: string | null; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-16 font-medium">{title}</h2>
        {note ? <span className="mr-auto text-13 text-muted-foreground">{note}</span> : null}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A quieter fact after a cell's value: the failed requests, a revoked key. */
function Quiet({ className = "text-muted-foreground", children }: { className?: string; children: ReactNode }) {
  return <span className={`ml-2 ${className}`}>{children}</span>;
}

function UseHeads() {
  return (
    <>
      <DataTableHead align="right" title="Tokens in: prompts">
        In
      </DataTableHead>
      <DataTableHead align="right" title="Tokens out: answers">
        Out
      </DataTableHead>
      <DataTableHead align="right" title="Its share of the LLM server's measured energy while its requests ran">
        Energy
      </DataTableHead>
      <DataTableHead align="right" title="That energy at each day's electricity price">
        Cost
      </DataTableHead>
    </>
  );
}

function UseCells({ use, currency }: { use: KeyUse; currency: EnergyCurrency | null }) {
  const cost = formatCost(use.cost, currency);
  return (
    <>
      <TableCell className={number} title={`${use.tokensIn.toLocaleString("en")} tokens`}>
        {formatCount(use.tokensIn)}
      </TableCell>
      <TableCell className={number} title={`${use.tokensOut.toLocaleString("en")} tokens`}>
        {formatCount(use.tokensOut)}
      </TableCell>
      <TableCell className={number}>{use.energyWh === null ? "—" : formatWh(use.energyWh)}</TableCell>
      <TableCell className={number}>{use.costEstimate && use.cost !== null ? <Estimate text={cost}>At the latest published price</Estimate> : cost}</TableCell>
    </>
  );
}

/** The dialog's body: the name, then the new key, once. It unmounts with the dialog, so each opening starts afresh. */
function CreateKeyForm({ onClose }: { onClose: () => void }) {
  const [state, action] = useActionState(createKey, { status: "idle" });
  if (state.status === "done") {
    return (
      <div className="grid gap-4">
        <AlertDialogHeader>
          <AlertDialogTitle>Copy your key</AlertDialogTitle>
          <AlertDialogDescription>It is shown only now. Paste it where your software asks for the API key.</AlertDialogDescription>
        </AlertDialogHeader>
        <SecretValue value={state.key} />
        <AlertDialogFooter>
          <Button type="button" className="min-w-16" onClick={onClose}>
            Done
          </Button>
        </AlertDialogFooter>
      </div>
    );
  }
  return (
    <form action={action} className="grid gap-4">
      <AlertDialogHeader>
        <AlertDialogTitle>Create key</AlertDialogTitle>
        <AlertDialogDescription>Name it after the software that will use it, so you know which one to revoke.</AlertDialogDescription>
      </AlertDialogHeader>
      <FormField label="Name" name="name" placeholder="VS Code on my laptop" maxLength={API_KEY_NAME_MAX_LENGTH} autoComplete="off" required autoFocus />
      {state.status === "error" ? <FormError>{state.message}</FormError> : null}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <SubmitButton className="min-w-16" pendingLabel="Creating…">
          Create
        </SubmitButton>
      </AlertDialogFooter>
    </form>
  );
}
