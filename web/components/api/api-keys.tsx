"use client";

import { useActionState, useRef, useState, type ReactNode } from "react";
import type { EnergyCurrency } from "@portal/core/wire";
import { createKey, revokeKey } from "@/lib/actions/api-keys";
import type { ApiKeyRow, ApiKeysView } from "@/lib/api-keys";
import { returnFocus } from "@/lib/focus";
import { formatCount } from "@/lib/format";
import { API_KEY_NAME_MAX_LENGTH, MAX_API_KEYS } from "@/lib/limits";
import { formatCost, formatDay, formatWh } from "@/lib/live-format";
import { Estimate } from "@/components/admin/estimate";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataTable, DataTableEmpty, DataTableHead, DataTablePagination, usePagination } from "@/components/common/data-table";
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
import { PlusIcon } from "@/components/ui/icons";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";

const number = "text-right tabular-nums";
type Use = Pick<ApiKeyRow, "requests" | "failed" | "tokensIn" | "tokensOut" | "energyWh" | "cost" | "costEstimate">;

/** The API page's two tables: the user's working keys with what each used in all, and every key's use per day. */
export function ApiKeys({ keys, days, currency }: ApiKeysView) {
  const create = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const { rows, pagination } = usePagination(days);

  return (
    <>
      <Titled
        title="Keys"
        action={
          <GuardedButton
            ref={create}
            type="button"
            blockedReason={keys.length >= MAX_API_KEYS ? `You have ${MAX_API_KEYS} keys. Revoke one to create another.` : null}
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
            Create key
          </GuardedButton>
        }
      >
        <DataTable tableProps={{ "aria-label": "Keys" }}>
          <TableHeader>
            <TableRow>
              <DataTableHead>Name</DataTableHead>
              <DataTableHead title="How the key ends">Key</DataTableHead>
              <DataTableHead>Created</DataTableHead>
              <DataTableHead>Last used</DataTableHead>
              <UseHeads />
              <DataTableHead>
                <span className="sr-only">Actions</span>
              </DataTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 ? (
              <DataTableEmpty colSpan={10}>No keys yet. Create one for each software that connects.</DataTableEmpty>
            ) : (
              keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="max-w-56 truncate font-medium" title={key.name}>
                    {key.name}
                  </TableCell>
                  <TableCell className="font-mono text-12 text-muted-foreground">sk-…{key.hint}</TableCell>
                  <TableCell>
                    <LocalTime at={key.createdAt} relative />
                  </TableCell>
                  <TableCell>{key.lastUsed ? formatDay(key.lastUsed) : <span className="text-muted-foreground">Never</span>}</TableCell>
                  <UseCells use={key} currency={currency} />
                  <TableCell className="text-right">
                    <Button type="button" variant="outline" size="sm" onClick={() => setRevoking(key)}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </DataTable>
      </Titled>

      <Titled title="Usage by day">
        <DataTable footer={<DataTablePagination {...pagination} label="Usage pages" />} tableProps={{ "aria-label": "Usage by day" }}>
          <TableHeader>
            <TableRow>
              <DataTableHead>Day</DataTableHead>
              <DataTableHead>Key</DataTableHead>
              <UseHeads />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <DataTableEmpty colSpan={7}>No key was used yet.</DataTableEmpty>
            ) : (
              rows.map((day) => (
                <TableRow key={`${day.day} ${day.keyId}`}>
                  <TableCell>{formatDay(day.day)}</TableCell>
                  <TableCell>
                    <span className="inline-block max-w-56 truncate align-bottom" title={day.name}>
                      {day.name}
                    </span>
                    {day.revoked ? <Quiet>revoked</Quiet> : null}
                  </TableCell>
                  <UseCells use={day} currency={currency} />
                </TableRow>
              ))
            )}
          </TableBody>
        </DataTable>
      </Titled>

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
          stays under Usage by day.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** A table under its heading, with the button that adds to it. */
function Titled({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 items-center gap-2">
        <h2 className="mr-auto text-16 font-medium">{title}</h2>
        {action}
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
      <DataTableHead align="right" title="Requests that reached the LLM server">
        Requests
      </DataTableHead>
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

function UseCells({ use, currency }: { use: Use; currency: EnergyCurrency | null }) {
  const cost = formatCost(use.cost, currency);
  return (
    <>
      <TableCell className={number}>
        {formatCount(use.requests)}
        {use.failed > 0 ? <Quiet className="text-destructive">{formatCount(use.failed)} failed</Quiet> : null}
      </TableCell>
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
