"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { users, writeAudit } from "@portal/core";
import { getDb } from "../db";
import { gateway, toApiError } from "../gateway";
import { requireUser } from "../session";
import { fieldErrors, formText, harnessSchema, profileSchema, type ActionResult } from "../validation";
import { restartKind } from "../workspace-stop";
import type { ProfileState } from "./admin";

// The signed-in user's own settings (/settings). They are about the user's own account and workspace, also for
// an administrator whose session is viewing someone else's.

const NAME_FIELDS = ["firstName", "middleName", "lastName"] as const;

/**
 * Saves the user's own name (the Account card), checked as the admin's Profile form checks it. Audited as
 * `user_updated` on the user's own account, with the fields that changed; an unchanged name stores nothing.
 */
export async function saveName(_previous: ProfileState, formData: FormData): Promise<ProfileState> {
  const { user } = await requireUser();
  const values = formText(formData, NAME_FIELDS);
  const parsed = profileSchema.safeParse(values);
  if (!parsed.success) return { status: "invalid", fieldErrors: fieldErrors(parsed.error), values };
  const changes: Record<string, { from: string | null; to: string | null }> = {};
  for (const key of NAME_FIELDS) {
    if ((user[key] ?? null) !== parsed.data[key]) changes[key] = { from: user[key] ?? null, to: parsed.data[key] };
  }
  if (Object.keys(changes).length > 0) {
    const db = getDb();
    db.transaction(() => {
      db.update(users)
        .set({ ...parsed.data, updatedAt: Date.now() })
        .where(eq(users.id, user.id))
        .run();
      writeAudit(db, { action: "user_updated", actorUserId: user.id, targetUserId: user.id, details: changes });
    });
    refresh();
  }
  return { status: "saved", at: Date.now() };
}

/**
 * Saves the harness the user's workspace starts with (users.agent), checked against the agents this install
 * enables. Audited as `agent_preference_changed` with the stored values (from null: never chosen). A running
 * workspace keeps its agent until it starts again.
 */
export async function saveHarness(agent: string): Promise<ActionResult> {
  const { user } = await requireUser();
  const parsed = harnessSchema.safeParse({ agent });
  if (!parsed.success) return { ok: false, message: "There is no such harness." };
  const enabled = await gateway.agents().catch((error: unknown) => toApiError(error));
  if (!Array.isArray(enabled)) return { ok: false, message: `The harnesses can't be checked right now: ${enabled.message}` };
  const chosen = parsed.data.agent;
  if (!enabled.some((offered) => offered.id === chosen)) return { ok: false, message: "That harness isn't available here." };
  if (user.agent !== chosen) {
    const db = getDb();
    db.transaction(() => {
      db.update(users).set({ agent: chosen, updatedAt: Date.now() }).where(eq(users.id, user.id)).run();
      writeAudit(db, { action: "agent_preference_changed", actorUserId: user.id, details: { from: user.agent, to: chosen } });
    });
    refresh();
  }
  return { ok: true };
}

/**
 * "Restart now": stops the user's running workspace and starts the same kind (Private or Online) again, with the
 * harness now saved. The page warns first when the agent is working or the workspace is open elsewhere. One that
 * stopped since the page rendered stays stopped: the user starts it from Home, choosing its kind there.
 */
export async function restartWorkspace(): Promise<ActionResult> {
  const { user } = await requireUser();
  try {
    const kind = restartKind(await gateway.getWorkspace(user.id));
    if (!kind) return { ok: false, message: "Your workspace has stopped. Start it from Home." };
    await gateway.stop(user.id, "user", user.id);
    await gateway.start(user.id, kind);
  } catch (error) {
    return { ok: false, message: toApiError(error).message };
  } finally {
    refresh();
  }
  return { ok: true };
}
