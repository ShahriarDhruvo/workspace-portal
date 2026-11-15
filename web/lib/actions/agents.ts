"use server";

import { writeAudit } from "@portal/db";
import { agentActionError, type AgentAction } from "../agent-versions";
import { getDb } from "../db";
import { gateway, toApiError } from "../gateway";
import { requireAdmin } from "../session";
import { agentImageSchema, agentUpdateSchema, fieldErrors, formText, type FieldErrors } from "../validation";

// The Agents page's actions: start an update (or rollback, or rebuild), cancel it, remove an old image. Each
// re-checks the admin role and validates its input; the gateway refuses what it can't do (one job at a time, the
// current image, images in use) and audits updates itself, attributed to the admin passed as actorUserId. The
// page polls for the job's progress, so the actions only report whether the gateway accepted.

export type AgentActionState =
  | { status: "idle" }
  | { status: "invalid"; fieldErrors: FieldErrors }
  | { status: "error"; message: string }
  | { status: "done" };

function failure(action: AgentAction, error: unknown): AgentActionState {
  const { message, field } = agentActionError(action, toApiError(error));
  return field ? { status: "invalid", fieldErrors: { [field]: message } } : { status: "error", message };
}

/**
 * Starts the job that makes `version` of `agent` current: an exact version (the dialogs never send a channel). It
 * switches to an image on the server or builds one (updateWork in lib/agent-versions.ts), checked before it counts.
 */
export async function updateAgent(_previous: AgentActionState, formData: FormData): Promise<AgentActionState> {
  const session = await requireAdmin();
  const parsed = agentUpdateSchema.safeParse(formText(formData, ["agent", "version", "rebuild"]));
  if (!parsed.success) return { status: "invalid", fieldErrors: fieldErrors(parsed.error) };
  const { agent, version, rebuild } = parsed.data;
  try {
    await gateway.updateAgent(agent, { version, rebuild, actorUserId: session.user.id });
  } catch (error) {
    return failure("update", error);
  }
  return { status: "done" };
}

/** Cancels the running job; the current version stays as it was. */
export async function cancelAgentUpdate(_previous: AgentActionState): Promise<AgentActionState> {
  await requireAdmin();
  try {
    const { cancelled } = await gateway.cancelAgentUpdate();
    if (!cancelled) {
      return { status: "error", message: "Too late to cancel: the update has finished, or is making the new version current." };
    }
  } catch (error) {
    return failure("cancel", error);
  }
  return { status: "done" };
}

/** Removes one of an agent's images (not the current one, and none a workspace uses). */
export async function removeAgentImage(_previous: AgentActionState, formData: FormData): Promise<AgentActionState> {
  const session = await requireAdmin();
  const parsed = agentImageSchema.safeParse(formText(formData, ["agent", "version"]));
  if (!parsed.success) return { status: "error", message: Object.values(fieldErrors(parsed.error))[0] ?? "Unknown image." };
  const { agent, version } = parsed.data;
  try {
    await gateway.removeAgentImage(agent, version);
  } catch (error) {
    return failure("remove", error);
  }
  writeAudit(getDb(), { action: "agent_image_removed", actorUserId: session.user.id, details: { agent, version } });
  return { status: "done" };
}
