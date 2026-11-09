import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { auditLog, displayName, users } from "@portal/db";
import { auditActionLabel, auditActorFallback, auditDetailsSubject, formatAuditDetails } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { LocalTime } from "@/components/local-time";
import { PageHeading } from "@/components/ui/card";
import { TABLE_CLASS, TABLE_SHELL_CLASS, TD_CLASS, TH_CLASS, TR_CLASS } from "@/components/ui/table";

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

  const cell = `${TD_CLASS} align-top`;
  return (
    <>
      <PageHeading title="Audit log">The latest {LIMIT} entries, newest first.</PageHeading>
      <div className={TABLE_SHELL_CLASS}>
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              {["Time", "Actor", "Action", "Target", "Details"].map((heading) => (
                <th key={heading} scope="col" className={TH_CLASS}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3.5 py-10 text-center text-fg-muted">
                  Nothing has been recorded yet.
                </td>
              </tr>
            ) : null}
            {entries.map((entry) => {
              const subject = entry.target ? displayName(entry.target) : auditDetailsSubject(entry.details);
              return (
                <tr key={entry.id} className={TR_CLASS}>
                  <td className={`${cell} whitespace-nowrap text-fg-muted tabular-nums`}>
                    <LocalTime at={entry.at} />
                  </td>
                  <td className={`${cell} whitespace-nowrap`}>
                    {entry.actor ? displayName(entry.actor) : <span className="text-fg-muted">{auditActorFallback(entry.action)}</span>}
                  </td>
                  <td className={`${cell} whitespace-nowrap font-medium`}>{auditActionLabel(entry.action, entry.actor !== null)}</td>
                  <td className={`${cell} whitespace-nowrap`}>
                    {subject ? (
                      <span className={entry.target ? "" : "text-fg-muted"}>{subject}</span>
                    ) : (
                      <span className="text-fg-muted">—</span>
                    )}
                  </td>
                  <td className={`${cell} text-fg-muted`}>{formatAuditDetails(entry.details)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
