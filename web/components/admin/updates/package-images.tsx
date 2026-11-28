"use client";

import type { Ref } from "react";
import { packageSummary } from "@/lib/agent-versions";
import { formatBytes } from "@/lib/format";
import type { ReleaseNotes } from "@portal/core/wire";
import { DataTable, DataTableEmpty, DataTableHead, DataTablePagination, usePagination } from "@/components/common/data-table";
import { GuardedButton } from "@/components/common/guarded-button";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { ReleaseNotesDialog, type ReleaseNotesTarget } from "./release-notes";
import { useDialog } from "./use-dialog";
import { VersionSection } from "./version-card";

/** A row's button: what it says, why it can't run now (null: it can), and what it opens. */
interface RowAction {
  label: string;
  blockedReason: string | null;
  /** Gets the button, for the dialog to hand the focus back to. */
  onClick: (from: HTMLElement) => void;
}

/** One version in a card's Package images table (agentPackageRows, enginePackageRows, appPackageRows). */
export interface PackageImageRow {
  version: string;
  /** The whole id of a commit that `version` cuts short: its tooltip, and written out on a touch screen. */
  commit?: string;
  /** What new workspaces start with (the agents), or what runs (the engine). */
  current: boolean;
  latest: boolean;
  publishedAt: number | null;
  /** Its GitHub release, or the commit's message; null: no Release notes (Commit message) button. */
  notes: ReleaseNotes | null;
  /** Its image (or install) on the server and its size (null: unknown); null when it is built, downloaded or installed first. */
  image: { sizeBytes: number | null } | null;
  /** Workspaces using its image: the agents' table only. */
  inUse?: number;
  /** Use…, Download…, Install… (the AI server's), Build…, Rebuild… (the agents); null for none (the version in use). */
  action: RowAction | null;
  /** Remove… for an image that isn't current; blocked while something still needs it. */
  remove: RowAction | null;
}

interface PackageImagesProps {
  /** The card's product: the release notes' title. */
  name: string;
  /** The section's title, "Package images" by default; "Versions" for a program installed as files. */
  title?: string;
  /** The column that says what is on the server: "Image" by default, "Installed" for files. */
  column?: string;
  /** The date column: "Released" by default, "Committed" for a program whose versions are commits. */
  dateColumn?: string;
  rows: PackageImageRow[];
  /** The current row's badge: "Current" (an agent's) or "In use" (the AI server's). */
  currentLabel: string;
  /** A row without an image: "Build first", "Download first" or "Install first". */
  missingLabel: string;
  /** Where the images are, in the folded summary: "this server", "the AI server". */
  where: string;
  /** With the Workspaces column (the agents). */
  workspaces?: boolean;
  /** Shown in the table while it has no rows. */
  empty: string;
  /** The section's trigger: the focus target once a removed image's row, and its Remove button, is gone. */
  triggerRef?: Ref<HTMLButtonElement>;
}

/**
 * The Package images section of each Updates card, folded by default, newest version first. Release notes open in
 * a dialog here; the other buttons are the card's.
 */
export function PackageImages({
  name,
  title = "Package images",
  column = "Image",
  dateColumn = "Released",
  rows,
  currentLabel,
  missingLabel,
  where,
  workspaces = false,
  empty,
  triggerRef,
}: PackageImagesProps) {
  const { rows: page, pagination } = usePagination(rows);
  const notes = useDialog<ReleaseNotesTarget | null>(null);
  const columns = workspaces ? 5 : 4;
  // A kind of button no row on the page has takes no room.
  const slots = { action: page.some((row) => row.action), remove: page.some((row) => row.remove) };

  return (
    <VersionSection title={title} summary={packageSummary(rows, where)} triggerRef={triggerRef}>
      <DataTable
        footer={<DataTablePagination {...pagination} label={`${name} images pages`} />}
        // A phone keeps the version and the buttons, whose labels say what is on the server.
        tableProps={{ className: "max-sm:[&_:is(th,td):not(:first-child,:last-child)]:hidden" }}
      >
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <DataTableHead>Version</DataTableHead>
            <DataTableHead>{dateColumn}</DataTableHead>
            <DataTableHead>{column}</DataTableHead>
            {workspaces ? <DataTableHead align="right">Workspaces</DataTableHead> : null}
            <DataTableHead className="sticky-actions">
              <span className="sr-only">Actions</span>
            </DataTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.length === 0 ? (
            <DataTableEmpty colSpan={columns}>{empty}</DataTableEmpty>
          ) : (
            page.map((row) => (
              <TableRow key={row.commit ?? row.version} className="h-12">
                <TableCell>
                  <span className="flex items-center gap-2 max-sm:flex-wrap">
                    <span className="font-mono text-13" title={row.commit}>
                      {row.version}
                    </span>
                    {row.current ? <Badge>{currentLabel}</Badge> : null}
                    {row.latest ? <Badge variant="outline">latest</Badge> : null}
                    {/* Cut short for a phone's eye: the whole badge beside the buttons is wider than its screen. */}
                    {row.notes?.breaking ? (
                      <Badge variant="destructive">
                        Breaking<span className="max-sm:sr-only"> changes</span>
                      </Badge>
                    ) : null}
                    {row.commit ? (
                      <span className="hidden font-mono text-12 break-all whitespace-normal text-muted-foreground pointer-coarse:inline">{row.commit}</span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{row.publishedAt ? <LocalTime at={row.publishedAt} relative /> : "—"}</TableCell>
                <TableCell className={row.image ? undefined : "text-muted-foreground"}>
                  {row.image ? `On server${row.image.sizeBytes === null ? "" : ` · ${formatBytes(row.image.sizeBytes)}`}` : missingLabel}
                </TableCell>
                {workspaces ? (
                  <TableCell className="text-right text-muted-foreground tabular-nums">{row.image ? (row.inUse ?? 0) : "—"}</TableCell>
                ) : null}
                <TableCell className="sticky-actions w-0">
                  {/* One cell, which stays in view: its buttons are in line down the table, and stacked on a phone. */}
                  <div className="flex items-center justify-end gap-2 max-sm:w-40 max-sm:flex-wrap max-sm:gap-y-3">
                    {row.notes ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          if (row.notes) notes.show({ name, version: row.version, commit: row.commit, notes: row.notes }, event.currentTarget);
                        }}
                      >
                        {row.commit ? "Commit message" : "Release notes"}
                      </Button>
                    ) : null}
                    {slots.action ? <div className={SLOT}>{row.action ? <RowButton action={row.action} /> : null}</div> : null}
                    {slots.remove ? <div className={SLOT}>{row.remove ? <RowButton action={row.remove} /> : null}</div> : null}
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </DataTable>
      <ReleaseNotesDialog target={notes.dialog} open={notes.open} onOpenChange={notes.setOpen} returnFocusTo={notes.opener} />
    </VersionSection>
  );
}

/** A row button's place: wide enough for the longest label ("Download…"), and kept empty by a row without that button. */
const SLOT = "w-24 max-sm:w-auto max-sm:empty:hidden";

function RowButton({ action }: { action: RowAction }) {
  return (
    <GuardedButton variant="outline" size="sm" className="w-full" blockedReason={action.blockedReason} onClick={(event) => action.onClick(event.currentTarget)}>
      {action.label}
    </GuardedButton>
  );
}
