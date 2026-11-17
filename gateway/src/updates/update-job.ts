// What the two updaters (agent-updater.ts, engine-updater.ts) do alike to their job record, an UpdateJob of
// @portal/core: add to its log, and end it with an audit entry. Each keeps its own phases, its own order through them
// and its own way to cancel. A job runs while its `finishedAt` is null.
import { writeAudit, type AuditAction, type PortalDb, type UpdateJob } from "@portal/core";
import type { Logger } from "../lib/log.ts";

/** Adds lines to a running job's log, which keeps its last `cap` lines. A finished job's log stays as it is. */
export function appendLog(job: UpdateJob<string>, lines: readonly string[], cap: number): void {
  if (job.finishedAt !== null) return;
  job.log.push(...lines.slice(-cap));
  if (job.log.length > cap) job.log.splice(0, job.log.length - cap);
}

/**
 * Ends a job at `at` (`error` null: it succeeded) and records the end with `details`: in the audit log for the admin
 * who asked, as `agent_updated` or `agent_update_failed`, and in the gateway's log, as "agent updated", "agent update
 * failed" or "agent update cancelled" (the engine's alike).
 */
export function finishJob<Phase extends string>(
  db: PortalDb,
  log: Logger,
  subject: "agent" | "engine",
  job: UpdateJob<Phase>,
  at: number,
  end: { phase: Phase; error: string | null; step: string | null },
  details: Record<string, unknown>,
): void {
  Object.assign(job, end, { finishedAt: at });
  audit(db, log, `${subject}_${end.error === null ? "updated" : "update_failed"}`, job.actorUserId, details);
  if (end.error === null) log.info(`${subject} updated`, { ...details, seconds: Math.round((at - job.startedAt) / 1000) });
  else log.warn(`${subject} update ${end.phase}`, details);
}

function audit(db: PortalDb, log: Logger, action: AuditAction, actorUserId: number | null, details: unknown): void {
  try {
    writeAudit(db, { action, actorUserId, details });
    return;
  } catch (error) {
    // The admin may have been deleted while the job ran (the actor is a foreign key): keep the entry.
    if (actorUserId === null) return void log.error("could not write audit entry", { action, error });
  }
  audit(db, log, action, null, details);
}
