import "server-only";
import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { users, writeAudit, type User } from "@portal/core";
import { getDb } from "./db";
import { gateway, toApiError } from "./gateway";
import { harnessSchema, type ActionResult } from "./validation";
import { restartKind } from "./workspace-stop";

// A user's harness (users.agent): Home for one's own, a user's page for an administrator's change of anyone's, and
// from there the restart that starts it.

/**
 * Saves the harness whose workspace `user`'s next Start launches, checked against the agents this install enables.
 * Audited as `agent_preference_changed` by `actorUserId` with the stored values (from null: never chosen), and with
 * the user as its target when the actor is someone else. The workspace that runs is not touched: the choice counts
 * from the next Start.
 */
export async function saveHarnessOf(user: Pick<User, "id" | "agent">, agent: string, actorUserId: number): Promise<ActionResult> {
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
      writeAudit(db, {
        action: "agent_preference_changed",
        actorUserId,
        targetUserId: actorUserId === user.id ? null : user.id,
        details: { from: user.agent, to: chosen },
      });
    });
    refresh();
  }
  return { ok: true };
}

/**
 * "Restart now" on a user's page: stops `userId`'s running workspace and starts the one of the same kind (Private or
 * Online) that the harness now saved has. One that stopped since the page rendered stays stopped, with
 * `stoppedMessage`: its owner starts one from Home, choosing its kind there.
 */
export async function restartWorkspaceOf(userId: number, actorUserId: number, stoppedMessage: string): Promise<ActionResult> {
  try {
    const kind = restartKind(await gateway.getWorkspace(userId));
    if (!kind) return { ok: false, message: stoppedMessage };
    await gateway.stop(userId, "admin", actorUserId);
    await gateway.start(userId, kind);
  } catch (error) {
    return { ok: false, message: toApiError(error).message };
  } finally {
    refresh();
  }
  return { ok: true };
}
