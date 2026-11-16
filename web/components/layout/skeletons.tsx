import type { ReactNode } from "react";
import { DataTable, DataTableHead } from "@/components/common/data-table";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

// The parts of the loading skeletons (loading.tsx) of the account pages, each the size of the real thing, so a page
// takes the skeleton's place without anything moving.

/** A page title (PageHeading's 18/24 line). */
export function HeadingSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-6 w-32", className)} />;
}

/** A button's place (32px tall), as wide as its label. */
export function ButtonSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-8 w-24", className)} />;
}

/** A labelled input (FormField): the label's line, a 32px input, and with `hint` the hint's line under it. */
export function FieldSkeleton({ hint = false }: { hint?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-8 w-full" />
      {hint ? <Skeleton className="h-4.5 w-48 max-w-full" /> : null}
    </div>
  );
}

/**
 * A Section card: its title (and description) over `children`, then `footer`'s buttons in the footer strip, on its
 * right unless `footerStart` (a footer whose buttons start on the left, like a user's Account card).
 */
export function SectionSkeleton({
  description = false,
  footer,
  footerStart = false,
  children,
}: {
  description?: boolean;
  footer?: ReactNode;
  footerStart?: boolean;
  children?: ReactNode;
}) {
  return (
    <Card aria-hidden="true">
      <CardHeader>
        <Skeleton className="h-6 w-28" />
        {description ? <Skeleton className="h-5 w-64 max-w-full" /> : null}
      </CardHeader>
      {children ? <CardContent>{children}</CardContent> : null}
      {footer ? (
        <CardFooter className={cn("flex-wrap gap-2", footerStart ? "justify-start" : "justify-end")}>{footer}</CardFooter>
      ) : null}
    </Card>
  );
}

/**
 * A DataTable with its real column headings, `rows` rows of bars and the pager's row. `rowHeight`: the real rows'
 * height (a class), e.g. taller with a button in each row.
 */
export function TableSkeleton({ columns, rows, rowHeight = "h-9" }: { columns: readonly string[]; rows: number; rowHeight?: string }) {
  return (
    <DataTable
      footer={
        <div className="flex items-center justify-between gap-6 border-t px-4 py-2.5">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-8 w-56 max-sm:w-36" />
        </div>
      }
    >
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {columns.map((column, index) => (
            <DataTableHead key={index}>{column}</DataTableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }, (_, row) => (
          <TableRow key={row} className="hover:bg-transparent">
            {columns.map((_, cell) => (
              <TableCell key={cell} className={rowHeight}>
                <Skeleton className="h-4 w-full min-w-12" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </DataTable>
  );
}
