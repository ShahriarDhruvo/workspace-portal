"use client";

import { useRef, useState, type Ref } from "react";
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
import { VersionSection } from "./version-card";

/** A row's button: what it says, why it can't run now (null: it can), and what it opens. */
interface RowAction {
  label: string;
  blockedReason: string | null;
  /** Gets the button, for the dialog to hand the focus back to. */
  onClick: (from: HTMLElement) => void;
}

/** One version in a card's Package images table (agentPackageRows, enginePackageRows). */
export interface PackageImageRow {
  version: string;
  /** What new workspaces start with (the agents), or what runs (the engine). */
  current: boolean;
  latest: boolean;
  publishedAt: number | null;
  /** Its GitHub release; null: no Release notes button. */
  notes: ReleaseNotes | null;
  /** Its image on the server and the image's size (null: unknown); null when it is built or downloaded first. */
  image: { sizeBytes: number | null } | null;
  /** Workspaces using its image: the agents' table only. */
  inUse?: number;
  /** Use…, Download… (the engine), Build…, Rebuild… (the agents); null for none (the engine's running version). */
  action: RowAction | null;
  /** Remove… for an image that isn't current; blocked while something still needs it. */
  remove: RowAction | null;
}

interface PackageImagesProps {
  /** The card's product: the release notes' title. */
  name: string;
  rows: PackageImageRow[];
  /** The current row's badge: "Current" (an agent's) or "Running" (the engine's). */
  currentLabel: string;
  /** A row without an image: "Build first" or "Download first". */
  missingLabel: string;
  /** Where the images are, in the folded summary: "this server", "the LLM server". */
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
export function PackageImages({ name, rows, currentLabel, missingLabel, where, workspaces = false, empty, triggerRef }: PackageImagesProps) {
  const { rows: page, pagination } = usePagination(rows);
  const [notes, setNotes] = useState<ReleaseNotesTarget | null>(null);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const columns = workspaces ? 7 : 6;

  return (
    <VersionSection title="Package images" summary={packageSummary(rows, where)} triggerRef={triggerRef}>
      <DataTable footer={<DataTablePagination {...pagination} label={`${name} images pages`} />}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <DataTableHead>Version</DataTableHead>
            <DataTableHead>Released</DataTableHead>
            <DataTableHead>Image</DataTableHead>
            {workspaces ? <DataTableHead align="right">Workspaces</DataTableHead> : null}
            <DataTableHead colSpan={3}>
              <span className="sr-only">Actions</span>
            </DataTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.length === 0 ? (
            <DataTableEmpty colSpan={columns}>{empty}</DataTableEmpty>
          ) : (
            page.map((row) => (
              <TableRow key={row.version} className="h-12">
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-13">{row.version}</span>
                    {row.current ? <Badge>{currentLabel}</Badge> : null}
                    {row.latest ? <Badge variant="outline">latest</Badge> : null}
                    {row.notes?.breaking ? <Badge variant="destructive">Breaking changes</Badge> : null}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{row.publishedAt ? <LocalTime at={row.publishedAt} relative /> : "—"}</TableCell>
                <TableCell className={row.image ? undefined : "text-muted-foreground"}>
                  {row.image ? `On server${row.image.sizeBytes === null ? "" : ` · ${formatBytes(row.image.sizeBytes)}`}` : missingLabel}
                </TableCell>
                {workspaces ? (
                  <TableCell className="text-right text-muted-foreground tabular-nums">{row.image ? (row.inUse ?? 0) : "—"}</TableCell>
                ) : null}
                <TableCell className="w-0 pr-0">
                  {row.notes ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={(event) => {
                        if (!row.notes) return;
                        opener.current = event.currentTarget;
                        setNotes({ name, version: row.version, notes: row.notes });
                        setOpen(true);
                      }}
                    >
                      Release notes
                    </Button>
                  ) : null}
                </TableCell>
                <TableCell className="w-0 pr-0">{row.action ? <RowButton action={row.action} /> : null}</TableCell>
                <TableCell className="w-0">{row.remove ? <RowButton action={row.remove} /> : null}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </DataTable>
      <ReleaseNotesDialog target={notes} open={open} onOpenChange={setOpen} returnFocusTo={opener} />
    </VersionSection>
  );
}

function RowButton({ action }: { action: RowAction }) {
  return (
    <GuardedButton variant="outline" size="sm" className="w-full" blockedReason={action.blockedReason} onClick={(event) => action.onClick(event.currentTarget)}>
      {action.label}
    </GuardedButton>
  );
}
