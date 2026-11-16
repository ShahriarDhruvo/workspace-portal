"use client";

import { useActionState, useEffect, useEffectEvent, useState } from "react";
import { setEnergyPrice, type EnergyPriceState } from "@/lib/actions/energy";
import type { EnergyPrice } from "@/lib/energy";
import { formatCents, formatDate } from "@/lib/live-format";
import { DataTable, DataTableHead, DataTablePagination, usePagination } from "@/components/common/data-table";
import { FormField } from "@/components/forms/form-field";
import { SubmitButton } from "@/components/forms/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";

const IDLE: EnergyPriceState = { status: "idle" };

/**
 * The electricity price: a form that sets a new one from a day on (one for a day that already has a price replaces
 * it), and every price so far, newest first, the one in force today marked. `onSaved` refreshes the energy card.
 */
export function PriceDialog({ prices, today, onSaved }: { prices: EnergyPrice[]; today: string; onSaved: () => void }) {
  const [round, setRound] = useState(0);
  const current = prices.find((price) => price.effectiveFrom <= today) ?? null;
  const { rows, pagination } = usePagination(prices);
  return (
    <Dialog onOpenChange={(open) => (open ? null : setRound((n) => n + 1))}>
      <DialogTrigger asChild>
        <Button variant="outline">Prices</Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        // The dialog itself takes the focus, not its first field: a date field would open a phone's date picker.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Electricity price</DialogTitle>
        </DialogHeader>
        <PriceForm
          key={round}
          today={today}
          placeholder={current ? formatCents(current.centsPerKwh) : "14.258"}
          onSaved={() => {
            setRound((n) => n + 1);
            onSaved();
          }}
        />
        <DataTable footer={<DataTablePagination {...pagination} label="Prices pages" />}>
          <TableHeader>
            <TableRow>
              <DataTableHead>From</DataTableHead>
              <DataTableHead align="right">¢/kWh</DataTableHead>
              <DataTableHead>Note</DataTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((price) => (
              <TableRow key={price.effectiveFrom}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    {formatDate(price.effectiveFrom)}
                    {price === current ? <Badge variant="secondary">Now</Badge> : null}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(price.centsPerKwh)}</TableCell>
                <TableCell className="text-muted-foreground">
                  <span className="block max-w-56 truncate" title={price.note ?? undefined}>
                    {price.note ?? "—"}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      </DialogContent>
    </Dialog>
  );
}

/** Day, price and note; remounted (emptied) once saved and each time the dialog closes. */
function PriceForm({ today, placeholder, onSaved }: { today: string; placeholder: string; onSaved: () => void }) {
  const [state, action] = useActionState(setEnergyPrice, IDLE);
  const saved = useEffectEvent(onSaved);
  useEffect(() => {
    if (state.status === "saved") saved();
  }, [state]);
  const errors = state.status === "invalid" ? state.fieldErrors : {};
  const values = state.status === "invalid" ? state.values : undefined;
  return (
    <form action={action} className="grid grid-cols-2 gap-3">
      <FormField label="From" name="effectiveFrom" type="date" required defaultValue={values?.effectiveFrom ?? today} error={errors.effectiveFrom} />
      <FormField
        label="¢ per kWh"
        name="centsPerKwh"
        inputMode="decimal"
        autoComplete="off"
        required
        placeholder={placeholder}
        defaultValue={values?.centsPerKwh}
        error={errors.centsPerKwh}
      />
      <div className="col-span-2">
        <FormField label="Note" name="note" optional autoComplete="off" placeholder="TECO, Jan 2027" defaultValue={values?.note} error={errors.note} />
      </div>
      <div className="col-span-2 flex justify-end">
        <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
      </div>
    </form>
  );
}
