"use server";

import { writeAudit } from "@portal/db";
import { getDb } from "../db";
import { engineActionError, engineImageSchema, engineVersionSchema, type EngineAction } from "../engine-updates";
import { gateway, toApiError } from "../gateway";
import { requireAdmin } from "../session";

// The Updates page's LLM engine actions: update to a release, roll back, cancel, restart now (ending the drain),
// remove an old image. Each re-checks the admin role and validates its input; the gateway refuses what it can't do
// (one job at a time, the running image) and audits updates and rollbacks itself, attributed to the admin passed as
// actorUserId; an image removal is audited here, as for agent images. The page polls for the job's progress, so the
// actions only report whether the gateway accepted.

export type EngineActionResult = { ok: true } | { ok: false; message: string };

async function run(action: EngineAction, work: () => Promise<unknown>): Promise<EngineActionResult> {
  try {
    await work();
  } catch (error) {
    return { ok: false, message: engineActionError(action, toApiError(error)) };
  }
  return { ok: true };
}

/** Starts updating the engine to `version`, an exact release (never "latest": the one on screen is confirmed). */
export async function updateEngine(version: string): Promise<EngineActionResult> {
  const session = await requireAdmin();
  const parsed = engineVersionSchema.safeParse(version);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Unknown version." };
  return run("update", () => gateway.updateEngine(parsed.data, session.user.id));
}

/** Starts going back to the version that ran before the last change. */
export async function rollbackEngine(): Promise<EngineActionResult> {
  const session = await requireAdmin();
  return run("rollback", () => gateway.rollbackEngine(session.user.id));
}

/** Cancels the job while it downloads or drains; nothing changes. */
export async function cancelEngineUpdate(): Promise<EngineActionResult> {
  await requireAdmin();
  let cancelled = false;
  const result = await run("cancel", async () => {
    ({ cancelled } = await gateway.cancelEngineUpdate());
  });
  if (result.ok && !cancelled) return { ok: false, message: "Too late to cancel: the engine is restarting, or the job has finished." };
  return result;
}

/** Ends the drain: the engine restarts now, cutting off the requests still running. */
export async function restartEngineNow(): Promise<EngineActionResult> {
  await requireAdmin();
  let restarting = false;
  const result = await run("restart", async () => {
    ({ ok: restarting } = await gateway.restartEngineNow());
  });
  if (result.ok && !restarting)
    return { ok: false, message: "The job is no longer waiting for requests: it is restarting, or has finished." };
  return result;
}

/** Removes an engine image from the LLM server (not the one that runs). Audited as engine_image_removed. */
export async function removeEngineImage(digest: string, version: string | null): Promise<EngineActionResult> {
  const session = await requireAdmin();
  const parsed = engineImageSchema.safeParse({ digest, version });
  if (!parsed.success) return { ok: false, message: "Unknown image." };
  const result = await run("remove", () => gateway.removeEngineImage(parsed.data.digest));
  if (result.ok) {
    writeAudit(getDb(), {
      action: "engine_image_removed",
      actorUserId: session.user.id,
      details: { version: parsed.data.version, digest: parsed.data.digest },
    });
  }
  return result;
}
