import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { auditLog, displayName, users } from "@portal/db";
import { auditActionLabel, auditActorFallback, auditDetailsSubject, formatAuditDetails } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { cn } from "@/lib/utils";
import { PageHeading } from "@/components/layout/page-heading";
import { LocalTime } from "@/components/local-time";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Audit log" };

const LIMIT = 200;

export default async function AuditPage() {
  await requireAdmin();
  const actor = alias(users, "actor");
  const target = alias(users, "target");
  const entries = getDb()
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
    .limit(LIMIT)
    .all();

  return (
    <>
      <PageHeading title="Audit log">The latest {LIMIT} entries, newest first.</PageHeading>
      {/* The table scrolls sideways inside its card on narrow screens; the page itself never does. */}
      <Card className="gap-0 py-0">
        <Table className="[&_tr>*:first-child]:pl-4 [&_tr>*:last-child]:pr-4">
          <TableHeader>
            <TableRow>
              {["Time", "Actor", "Action", "Target", "Details"].map((heading) => (
                <TableHead key={heading} scope="col" className="h-9 text-12 text-muted-foreground">
                  {heading}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  Nothing has been recorded yet.
                </TableCell>
              </TableRow>
            ) : null}
            {entries.map((entry) => {
              const subject = entry.target ? displayName(entry.target) : auditDetailsSubject(entry.details);
              const details = formatAuditDetails(entry.details);
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
                  <TableCell className="min-w-72 align-top whitespace-normal wrap-anywhere text-muted-foreground">{details}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
