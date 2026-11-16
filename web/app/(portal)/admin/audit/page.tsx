import type { Metadata } from "next";
import { count, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { auditLog, displayName, users } from "@portal/db";
import { auditActionLabel, auditActorFallback, auditDetailsSubject, formatAuditDetails } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { clampPage, pageSlice, parsePage, parsePageSize } from "@/lib/pagination";
import { requireAdmin } from "@/lib/session";
import { cn } from "@/lib/utils";
import { DataTable, DataTableEmpty, DataTableHead, DataTableUrlPagination } from "@/components/common/data-table";
import { PageHeading } from "@/components/layout/page-heading";
import { PageMain } from "@/components/layout/page-main";
import { LocalTime } from "@/components/local-time";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Audit log" };

const COLUMNS = ["Time", "Actor", "Action", "Target", "Details"];

/** Every audit entry, newest first, paged on the server (?page=2&size=50): the log grows without bound. */
export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  await requireAdmin();
  const params = await searchParams;
  const pageSize = parsePageSize(params.size);
  const db = getDb();
  const total = db.select({ n: count() }).from(auditLog).get()?.n ?? 0;
  // A page past the end (entries deleted with their user, an old link) shows the last one.
  const page = clampPage(parsePage(params.page), total, pageSize);
  const { start } = pageSlice(page, pageSize, total);

  const actor = alias(users, "actor");
  const target = alias(users, "target");
  const entries = db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      action: auditLog.action,
      details: auditLog.details,
      actor: { firstName: actor.firstName, middleName: actor.middleName, lastName: actor.lastName },
      target: { firstName: target.firstName, middleName: target.middleName, lastName: target.lastName },
    })
    .from(auditLog)
    .leftJoin(actor, eq(actor.id, auditLog.actorUserId))
    .leftJoin(target, eq(target.id, auditLog.targetUserId))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(pageSize)
    .offset(start)
    .all();

  return (
    <PageMain width="lg">
      <PageHeading title="Audit log" />
      <DataTable
        footer={<DataTableUrlPagination page={page} pageSize={pageSize} total={total} label="Audit log pages" />}
        tableProps={{ "aria-label": "Audit log" }}
      >
        <TableHeader>
          <TableRow>
            {COLUMNS.map((heading) => (
              <DataTableHead key={heading}>{heading}</DataTableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.length === 0 ? <DataTableEmpty colSpan={COLUMNS.length}>Nothing has been recorded yet.</DataTableEmpty> : null}
          {entries.map((entry) => {
            const subject = entry.target ? displayName(entry.target) : auditDetailsSubject(entry.details);
            return (
              <TableRow key={entry.id}>
                <TableCell className="align-top text-muted-foreground tabular-nums">
                  <LocalTime at={entry.at} />
                </TableCell>
                <TableCell className="max-w-56 truncate align-top">
                  {entry.actor ? (
                    displayName(entry.actor)
                  ) : (
                    <span className="text-muted-foreground">{auditActorFallback(entry.action)}</span>
                  )}
                </TableCell>
                <TableCell className="align-top font-medium">{auditActionLabel(entry.action, entry.actor !== null, entry.details)}</TableCell>
                <TableCell className="max-w-56 truncate align-top">
                  {subject ? (
                    <span className={cn(!entry.target && "text-muted-foreground")}>{subject}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                {/* The one column that wraps, at a readable width: details can be long (an error message). */}
                <TableCell className="min-w-72 align-top whitespace-normal wrap-anywhere text-muted-foreground">
                  {formatAuditDetails(entry.details)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </DataTable>
    </PageMain>
  );
}
