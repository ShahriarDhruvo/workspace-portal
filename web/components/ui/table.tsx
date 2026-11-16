import * as React from "react";
import { cn } from "@/lib/utils";

// shadcn/ui Table as the Web Shell's data table: a #171717 shell with a 1px border and 14px radius that
// scrolls sideways when narrow, a 600-weight 40px header row, body rows with 50% separators and a faint hover
// (also while a row's menu is open). Dense: 13px text, about 44px rows. Cells wrap unless told not to.
// `stacked` names the breakpoint below which the screen is too narrow for the table's columns. There (the
// `stacked:` variant of app/globals.css) it is not a grid: each row becomes a block of lines, one per cell (two
// side by side from sm), with the column's name in front of the value (TableCell's `label`; a cell without one
// takes the full width), and the header row is left to screen readers. The parts name their roles, which
// browsers may drop from table elements that aren't displayed as a table.

function Table({ className, stacked, ...props }: React.ComponentProps<"table"> & { stacked?: "lg" | "xl" }) {
  return (
    <div
      data-slot="table-container"
      data-stacked={stacked}
      className="relative w-full overflow-x-auto rounded-3xl border bg-card"
    >
      <table data-slot="table" role="table" className={cn("w-full caption-bottom text-13 stacked:block", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      role="rowgroup"
      className={cn("[&_tr]:border-b [&_tr]:border-border [&_tr]:hover:bg-transparent stacked:sr-only", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      role="rowgroup"
      className={cn("[&_tr:last-child]:border-0 stacked:block", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      role="row"
      className={cn(
        "border-b border-border-faint transition-colors hover:bg-accent/50 has-aria-expanded:bg-accent/50 data-[state=selected]:bg-muted",
        "stacked:grid stacked:grid-cols-1 stacked:gap-x-6 stacked:gap-y-1.5 stacked:px-3.5 stacked:py-3 sm:stacked:grid-cols-2",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      role="columnheader"
      className={cn(
        "h-10 px-3.5 text-left align-middle font-semibold whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

/** `label`: the column's name, shown in front of the value where a stacked table has no header row to say it. */
function TableCell({ className, label, children, ...props }: React.ComponentProps<"td"> & { label?: string }) {
  return (
    <td
      data-slot="table-cell"
      role="cell"
      className={cn(
        "px-3.5 py-2.5 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        "stacked:p-0 stacked:wrap-anywhere stacked:whitespace-normal",
        label ? "stacked:flex stacked:gap-3" : "stacked:col-span-full stacked:block",
        className,
      )}
      {...props}
    >
      {label ? (
        <>
          {/* Hidden from screen readers, which get the column's name from the header row. */}
          <span aria-hidden="true" className="hidden w-24 shrink-0 text-muted-foreground stacked:block">
            {label}
          </span>
          <div className="contents stacked:block stacked:min-w-0 stacked:flex-1">{children}</div>
        </>
      ) : (
        children
      )}
    </td>
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-4 text-13 text-muted-foreground", className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
