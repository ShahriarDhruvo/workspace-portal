"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, useState, useTransition, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, clampPage, pageCount, pageSlice, pageSummary, pageWindow } from "@/lib/pagination";
import { cn } from "@/lib/utils";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import { Label } from "@/components/ui/label";
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink } from "@/components/ui/pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";

// Every table in the portal is built from these: the same frame, header cells, empty row and pager. A table paged
// on the server (the audit log) uses DataTableUrlPagination, which keeps ?page= and ?size=.

interface DataTableProps {
  children: ReactNode;
  /** Under the table, inside the frame: the pager. */
  footer?: ReactNode;
  /**
   * framed (default): its own rounded, bordered card. flush: no frame, for a table that fills a Card's body edge
   * to edge under the card's header.
   */
  variant?: "framed" | "flush";
  className?: string;
  /** For the <table>: e.g. a caption's id. */
  tableProps?: Omit<ComponentProps<typeof Table>, "children">;
}

/** A table in its frame; it scrolls sideways inside the frame on narrow screens (the page itself never does). */
export function DataTable({ children, footer, variant = "framed", className, tableProps }: DataTableProps) {
  return (
    <div
      data-slot="data-table"
      className={cn(
        "@container/data-table",
        variant === "framed" && "overflow-hidden rounded-xl border bg-card text-card-foreground",
        className,
      )}
    >
      <Table {...tableProps} className={cn("[&_tr>*:first-child]:pl-4 [&_tr>*:last-child]:pr-4", tableProps?.className)}>
        {children}
      </Table>
      {footer}
    </div>
  );
}

/** A column heading. `align="right"` for numbers. */
export function DataTableHead({ align, className, ...props }: ComponentProps<typeof TableHead> & { align?: "right" }) {
  return (
    <TableHead
      scope="col"
      className={cn("h-9 text-12 font-medium text-muted-foreground", align === "right" && "text-right", className)}
      {...props}
    />
  );
}

/**
 * The one row of a table with nothing in it. Its text stays centred in the part of the table on screen: on a phone
 * the columns are wider than the frame, which scrolls sideways, and the row spans all of them.
 */
export function DataTableEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="p-0! whitespace-normal">
        <div className="sticky left-0 w-[100cqw] px-4 py-10 text-center text-muted-foreground">{children}</div>
      </TableCell>
    </TableRow>
  );
}

export interface DataTablePaginationProps {
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Not needed by a table with one page size. */
  onPageSizeChange?: (pageSize: number) => void;
  /** The page sizes on offer (PAGE_SIZES); with one, the table has a fixed size and no picker. */
  pageSizes?: readonly number[];
  /** The address of a page, for its link (opening it in a new tab); without it the links only call onPageChange. */
  hrefFor?: (page: number) => string;
  /** A page change is on its way (a server-paged table): the pager is dimmed meanwhile. */
  pending?: boolean;
  /** Names the pager's navigation landmark, so a page with several tables tells them apart ("Users pages"). */
  label?: string;
  className?: string;
}

/**
 * The pager under a table; nothing when the table is empty. The rows summary is not a live region (live tables
 * change their totals all the time): a screen reader hears it once after the user pages or picks a page size.
 */
export function DataTablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizes = PAGE_SIZES,
  hrefFor,
  pending = false,
  label = "Pages",
  className,
}: DataTablePaginationProps) {
  const sizeId = useId();
  // The page the user asked for, until it shows; then its summary is announced.
  const [asked, setAsked] = useState<{ page: number; pageSize: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const current = clampPage(page, total, pageSize);
  const summary = pageSummary(current, pageSize, total);
  if (asked && !pending && asked.page === current && asked.pageSize === pageSize) {
    setAsked(null);
    setAnnouncement(summary);
  }
  if (total <= 0) return null;
  const count = pageCount(total, pageSize);
  const go = (target: number) => (event: MouseEvent<HTMLAnchorElement>) => {
    // A plain click pages here; ctrl/cmd/middle click opens the page's own address (when it has one).
    if (hrefFor && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return;
    event.preventDefault();
    if (target === current || target < 1 || target > count) return;
    setAsked({ page: target, pageSize });
    onPageChange(target);
  };
  const href = (target: number) => (hrefFor ? hrefFor(target) : "#");

  return (
    <div
      data-slot="data-table-pagination"
      aria-busy={pending || undefined}
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t px-4 py-2.5 transition-opacity",
        pending && "opacity-60",
        className,
      )}
    >
      <p className="text-13 text-muted-foreground tabular-nums">{summary}</p>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className="flex items-center gap-4 sm:gap-6">
        {pageSizes.length > 1 ? (
          <div className="flex items-center gap-2">
            <Label htmlFor={sizeId} className="text-13 font-normal text-muted-foreground max-sm:sr-only">
              Rows per page
            </Label>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setAsked({ page: 1, pageSize: Number(value) });
                onPageSizeChange?.(Number(value));
              }}
            >
              <SelectTrigger id={sizeId} size="sm" className="min-w-16 tabular-nums">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {pageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)} className="tabular-nums">
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <Pagination aria-label={label} className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationLink
                href={href(current - 1)}
                onClick={go(current - 1)}
                aria-label="Go to previous page"
                aria-disabled={current <= 1 || undefined}
                tabIndex={current <= 1 ? -1 : undefined}
                className={cn(current <= 1 && "pointer-events-none opacity-50")}
              >
                <ChevronLeftIcon />
              </PaginationLink>
            </PaginationItem>
            {pageWindow(current, count).map((entry, index) =>
              entry === "ellipsis" ? (
                <PaginationItem key={`gap-${index}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={entry}>
                  <PaginationLink
                    href={href(entry)}
                    onClick={go(entry)}
                    isActive={entry === current}
                    aria-label={`Page ${entry}`}
                    className="tabular-nums"
                  >
                    {entry}
                  </PaginationLink>
                </PaginationItem>
              ),
            )}
            <PaginationItem>
              <PaginationLink
                href={href(current + 1)}
                onClick={go(current + 1)}
                aria-label="Go to next page"
                aria-disabled={current >= count || undefined}
                tabIndex={current >= count ? -1 : undefined}
                className={cn(current >= count && "pointer-events-none opacity-50")}
              >
                <ChevronRightIcon />
              </PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}

/**
 * Paging of rows the browser already has: the current page's rows and the pager's props. The page stays in range
 * when the rows change (a live table that shrinks); a new page size starts again from page 1, and so does a new
 * `resetKey` (other rows altogether: another month's days), keeping the page size.
 */
export function usePagination<T>(
  items: readonly T[],
  resetKey?: string,
): { rows: T[]; pagination: Omit<DataTablePaginationProps, "className" | "label"> } {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [pagedKey, setPagedKey] = useState(resetKey);
  if (pagedKey !== resetKey) {
    setPagedKey(resetKey);
    setPage(1);
  }
  const total = items.length;
  const current = clampPage(page, total, pageSize);
  const rows = useMemo(() => {
    const { start, end } = pageSlice(current, pageSize, total);
    return items.slice(start, end);
  }, [items, current, pageSize, total]);
  return {
    rows,
    pagination: {
      page: current,
      pageSize,
      total,
      onPageChange: setPage,
      onPageSizeChange: (size) => {
        setPageSize(size);
        setPage(1);
      },
    },
  };
}

/**
 * The pager of a table paged on the server: the page and its size live in the URL (?page=2&size=50), so a page can
 * be linked to and survives a reload. Paging keeps the current rows on screen until the next arrive; the pager is
 * dimmed meanwhile.
 */
export function DataTableUrlPagination({
  page,
  pageSize,
  total,
  label,
}: {
  page: number;
  pageSize: number;
  total: number;
  label?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const hrefFor = (target: number, size: number = pageSize): string => {
    const params = new URLSearchParams(searchParams.toString());
    if (target > 1) params.set("page", String(target));
    else params.delete("page");
    if (size !== DEFAULT_PAGE_SIZE) params.set("size", String(size));
    else params.delete("size");
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
  const navigate = (href: string) => startTransition(() => router.push(href, { scroll: false }));
  return (
    <DataTablePagination
      page={page}
      pageSize={pageSize}
      total={total}
      pending={pending}
      label={label}
      hrefFor={(target) => hrefFor(target)}
      onPageChange={(target) => navigate(hrefFor(target))}
      onPageSizeChange={(size) => navigate(hrefFor(1, size))}
    />
  );
}
