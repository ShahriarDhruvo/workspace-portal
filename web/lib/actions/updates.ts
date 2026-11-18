"use server";

import { writeAudit } from "@portal/core";
import { agentActionError } from "../agent-versions";
import { getDb } from "../db";
import { engineActionError, engineImageSchema, engineVersionSchema } from "../engine-updates";
import { attempt, gateway } from "../gateway";
import { requireAdmin } from "../session";
import { agentImageSchema, agentUpdateSchema, fieldErrors, type ActionResult } from "../validation";

// The Updates page's actions, for the agents and the LLM engine. Each re-checks the admin role and validates its
// input; the gateway refuses what it can't do (one job at a time, an image in use) and audits updates itself,
// attributed to actorUserId. Image removals are audited here. The page polls for a job's progress.

/** An admin's request to the running job; `tooLate` when the gateway answers that it no longer applies. */
async function ask(request: () => Promise<boolean>, words: Parameters<typeof attempt>[1], tooLate: string): Promise<ActionResult> {
  await requireAdmin();
  let accepted = false;
  const result = await attempt(async () => void (accepted = await request()), words);
  return result.ok && !accepted ? { ok: false, message: tooLate } : result;
}

/** Starts the job that makes `version` of `agent` current: the exact version the dialog showed. */
export async function updateAgent(agent: string, version: string, rebuild: boolean): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = agentUpdateSchema.safeParse({ agent, version, rebuild });
  if (!parsed.success) return { ok: false, message: Object.values(fieldErrors(parsed.error))[0] ?? "Unknown version." };
  const { agent: kind, ...request } = parsed.data;
  return attempt(
    () => gateway.updateAgent(kind, { ...request, actorUserId: session.user.id }),
    (error) => agentActionError("update", error),
  );
}

/** Cancels the running job; the current version stays as it was. */
export async function cancelAgentUpdate(): Promise<ActionResult> {
  return ask(
    async () => (await gateway.cancelAgentUpdate()).cancelled,
    (error) => agentActionError("cancel", error),
    "Too late to cancel: the update has finished, or is making the new version current.",
  );
}

/** Removes one of an agent's images (not the current one, and none a workspace uses). */
export async function removeAgentImage(agent: string, version: string): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = agentImageSchema.safeParse({ agent, version });
  if (!parsed.success) return { ok: false, message: Object.values(fieldErrors(parsed.error))[0] ?? "Unknown image." };
  const result = await attempt(
    () => gateway.removeAgentImage(parsed.data.agent, parsed.data.version),
    (error) => agentActionError("remove", error),
  );
  if (result.ok) writeAudit(getDb(), { action: "agent_image_removed", actorUserId: session.user.id, details: parsed.data });
  return result;
}

/** Starts switching the engine to `version`, an exact release (never "latest": the one on screen is confirmed). */
export async function updateEngine(version: string): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = engineVersionSchema.safeParse(version);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Unknown version." };
  return attempt(
    () => gateway.updateEngine(parsed.data, session.user.id),
    (error) => engineActionError("update", error),
  );
}

/** Cancels the job while it downloads or drains; nothing changes. */
export async function cancelEngineUpdate(): Promise<ActionResult> {
  return ask(
    async () => (await gateway.cancelEngineUpdate()).cancelled,
    (error) => engineActionError("cancel", error),
    "Too late to cancel: the engine is restarting, or the job has finished.",
  );
}

/** Ends the drain: the engine restarts now, cutting off the requests still running. */
export async function restartEngineNow(): Promise<ActionResult> {
  return ask(
    async () => (await gateway.restartEngineNow()).ok,
    (error) => engineActionError("restart", error),
    "The job is no longer waiting for requests: it is restarting, or has finished.",
  );
}

/** Removes an engine image from the LLM server (not the one that runs). */
export async function removeEngineImage(digest: string, version: string | null): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = engineImageSchema.safeParse({ digest, version });
  if (!parsed.success) return { ok: false, message: "Unknown image." };
  const result = await attempt(
    () => gateway.removeEngineImage(parsed.data.digest),
    (error) => engineActionError("remove", error),
  );
  if (result.ok) {
    writeAudit(getDb(), { action: "engine_image_removed", actorUserId: session.user.id, details: { version: parsed.data.version, digest: parsed.data.digest } });
  }
  return result;
}
