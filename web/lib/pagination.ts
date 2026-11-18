// Paging for every table in the portal (components/common/data-table.tsx): the page sizes on offer, the default,
// the pages a pager shows, and reading ?page= and ?size= for tables paged on the server (the audit log).

export const PAGE_SIZES: readonly number[] = [10, 20, 30, 50, 100];
export const DEFAULT_PAGE_SIZE = 30;
/** Rows per page of Admin > Usage's sessions table. */
export const SESSION_PAGE_SIZE = 6;

/** How many pages `total` rows fill (at least one, so an empty table is on page 1 of 1). */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/** `page` moved into 1..pageCount. */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, Math.trunc(page) || 1), pageCount(total, pageSize));
}

/** The 0-based index range [start, end) of a page's rows. */
export function pageSlice(page: number, pageSize: number, total: number): { start: number; end: number } {
  const start = Math.min((clampPage(page, total, pageSize) - 1) * pageSize, Math.max(0, total));
  return { start, end: Math.min(start + pageSize, Math.max(0, total)) };
}

/** "1–30 of 74" (en dash); "0 of 0" for an empty table. */
export function pageSummary(page: number, pageSize: number, total: number): string {
  if (total <= 0) return "0 of 0";
  const { start, end } = pageSlice(page, pageSize, total);
  return `${(start + 1).toLocaleString("en-US")}–${end.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
}

/**
 * The page buttons a pager shows: every page up to 7 of them, else the first, the last, the current one and its
 * neighbours, with "ellipsis" for each gap (1 … 4 5 6 … 12). Always 7 entries past 7 pages, so the pager keeps
 * its width while paging.
 */
export function pageWindow(page: number, count: number): Array<number | "ellipsis"> {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, "ellipsis", count];
  if (page >= count - 3) return [1, "ellipsis", count - 4, count - 3, count - 2, count - 1, count];
  return [1, "ellipsis", page - 1, page, page + 1, "ellipsis", count];
}

/** A page size from the URL: one of PAGE_SIZES, else the default. */
export function parsePageSize(value: string | string[] | undefined): number {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return PAGE_SIZES.includes(n) ? n : DEFAULT_PAGE_SIZE;
}

/** A 1-based page number from the URL (not yet clamped to the rows there are: see clampPage). */
export function parsePage(value: string | string[] | undefined): number {
  const n = Math.trunc(Number(Array.isArray(value) ? value[0] : value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
