"use server";

import { eq } from "drizzle-orm";
import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { displayName, sessions, users, writeAudit, type SessionContext, type User } from "@portal/db";
import { getDb } from "../db";
import { describeError, endSessionsInBackground, gateway, openWorkspaceInBackground, releaseInBackground, toApiError } from "../gateway";
import { clearLoginFailures } from "../login-throttle";
import { generateTemporaryPassword } from "../password-generator";
import { hashPassword } from "../passwords";
import { requireAdmin } from "../session";
import { deleteSessions } from "../session-store";
import { fieldErrors, formText, newUserSchema, profileSchema, userIdSchema, type FieldErrors } from "../validation";

// Every action re-checks the admin role (requireAdmin), validates its input with zod, and is audited.

/** Result of the confirm-dialog actions (stop, reset password, activate/deactivate, delete). */
export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "done"; temporaryPassword?: string };

type Target = { user: User } | { error: string };

/** Loads the user an action is about. Accounts other than the admin's own unless `allowSelf`. */
function loadTarget(formData: FormData, session: SessionContext, options: { allowSelf?: boolean } = {}): Target {
  const id = userIdSchema.safeParse(formData.get("userId"));
  if (!id.success) return { error: "Unknown user." };
  const user = getDb().select().from(users).where(eq(users.id, id.data)).get();
  if (!user) return { error: "This user no longer exists." };
  if (!options.allowSelf && (user.id === session.user.id || user.role === "admin")) {
    return { error: "This action is not available for the administrator account." };
  }
  return { user };
}

const NEW_USER_FIELDS = ["firstName", "middleName", "lastName", "username", "password"] as const;
type NewUserValues = Record<(typeof NEW_USER_FIELDS)[number], string>;

export type CreateUserState =
  | { status: "idle" }
  | { status: "invalid"; fieldErrors: FieldErrors; values: NewUserValues }
  | { status: "created"; user: { id: number; name: string; username: string }; temporaryPassword: string };

export async function createUser(_previous: CreateUserState, formData: FormData): Promise<CreateUserState> {
  const session = await requireAdmin();
  const values = formText(formData, NEW_USER_FIELDS);
  const parsed = newUserSchema.safeParse(values);
  if (!parsed.success) return { status: "invalid", fieldErrors: fieldErrors(parsed.error), values };

  const { username, password, firstName, middleName, lastName } = parsed.data;
  const db = getDb();
  const taken = { status: "invalid", fieldErrors: { username: "That username is already taken." }, values } as const;
  if (db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()) return taken;

  const passwordHash = await hashPassword(password);
  const now = Date.now();
  let created: User;
  try {
    created = db.transaction(() => {
      const user = db
        .insert(users)
        .values({
          username,
          firstName,
          middleName,
          lastName,
          passwordHash,
          role: "user",
          mustChangePassword: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      clearLoginFailures(db, username);
      writeAudit(db, { action: "user_created", actorUserId: session.user.id, targetUserId: user.id, details: { username } });
      return user;
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("users.username")) return taken;
    throw error;
  }
  return {
    status: "created",
    user: { id: created.id, name: displayName(created), username },
    temporaryPassword: password,
  };
}

const PROFILE_FIELDS = ["firstName", "middleName", "lastName"] as const;
type ProfileValues = Record<(typeof PROFILE_FIELDS)[number], string>;

export type ProfileState =
  | { status: "idle" }
  | { status: "invalid"; fieldErrors: FieldErrors; values: ProfileValues }
  | { status: "error"; message: string }
  | { status: "saved"; at: number };

export async function updateProfile(_previous: ProfileState, formData: FormData): Promise<ProfileState> {
  const session = await requireAdmin();
  const target = loadTarget(formData, session, { allowSelf: true });
  if ("error" in target) return { status: "error", message: target.error };
  const values = formText(formData, PROFILE_FIELDS);
  const parsed = profileSchema.safeParse(values);
  if (!parsed.success) return { status: "invalid", fieldErrors: fieldErrors(parsed.error), values };

  const changes: Record<string, { from: string | null; to: string | null }> = {};
  for (const key of PROFILE_FIELDS) {
    if ((target.user[key] ?? null) !== parsed.data[key]) changes[key] = { from: target.user[key] ?? null, to: parsed.data[key] };
  }
  if (Object.keys(changes).length > 0) {
    const db = getDb();
    db.transaction(() => {
      db.update(users)
        .set({ ...parsed.data, updatedAt: Date.now() })
        .where(eq(users.id, target.user.id))
        .run();
      writeAudit(db, { action: "user_updated", actorUserId: session.user.id, targetUserId: target.user.id, details: changes });
    });
    refresh();
  }
  return { status: "saved", at: Date.now() };
}

export async function resetPassword(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const target = loadTarget(formData, session);
  if ("error" in target) return { status: "error", message: target.error };

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const db = getDb();
  const deleted = db.transaction(() => {
    db.update(users)
      .set({ passwordHash, mustChangePassword: true, updatedAt: Date.now() })
      .where(eq(users.id, target.user.id))
      .run();
    clearLoginFailures(db, target.user.username);
    writeAudit(db, { action: "password_reset", actorUserId: session.user.id, targetUserId: target.user.id });
    return deleteSessions(db, eq(sessions.userId, target.user.id));
  });
  endSessionsInBackground(deleted);
  refresh();
  return { status: "done", temporaryPassword };
}

export async function setUserActive(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const target = loadTarget(formData, session);
  if ("error" in target) return { status: "error", message: target.error };
  const active = formData.get("active") === "true";
  const db = getDb();

  if (target.user.active !== active) {
    const deleted = db.transaction(() => {
      db.update(users).set({ active, updatedAt: Date.now() }).where(eq(users.id, target.user.id)).run();
      writeAudit(db, {
        action: active ? "user_activated" : "user_deactivated",
        actorUserId: session.user.id,
        targetUserId: target.user.id,
      });
      return active ? null : deleteSessions(db, eq(sessions.userId, target.user.id));
    });
    // The stop below closes the workspace's connections too; this also covers a stop that fails.
    if (deleted) endSessionsInBackground(deleted);
    refresh();
  }
  if (!active) {
    try {
      await gateway.stop(target.user.id, "deactivated", session.user.id);
    } catch (error) {
      return {
        status: "error",
        message: `The account is deactivated, but its workspace could not be stopped: ${toApiError(error).message}`,
      };
    }
  }
  return { status: "done" };
}

export async function stopWorkspace(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const target = loadTarget(formData, session, { allowSelf: true });
  if ("error" in target) return { status: "error", message: target.error };
  try {
    await gateway.stop(target.user.id, "admin", session.user.id);
  } catch (error) {
    return { status: "error", message: toApiError(error).message };
  }
  refresh();
  return { status: "done" };
}

export async function deleteUser(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const target = loadTarget(formData, session);
  if ("error" in target) return { status: "error", message: target.error };
  const { user } = target;
  const confirmation = String(formData.get("confirmUsername") ?? "").trim().toLowerCase();
  if (confirmation !== user.username) return { status: "error", message: "Type the username exactly to confirm." };

  const db = getDb();
  // Sign the user out first so nothing restarts the workspace while its data is being removed. The data
  // deletion stops the workspace; the release after the response matters only if that fails.
  const deleted = db.transaction(() => {
    db.update(users).set({ active: false, updatedAt: Date.now() }).where(eq(users.id, user.id)).run();
    return deleteSessions(db, eq(sessions.userId, user.id));
  });
  endSessionsInBackground(deleted);
  try {
    await gateway.deleteData(user.id);
  } catch (error) {
    if (user.active) {
      writeAudit(db, {
        action: "user_deactivated",
        actorUserId: session.user.id,
        targetUserId: user.id,
        details: { reason: "deletion_failed" },
      });
    }
    refresh();
    return {
      status: "error",
      message: `The workspace data could not be deleted, so the account was kept (now deactivated): ${toApiError(error).message}`,
    };
  }
  db.transaction(() => {
    writeAudit(db, {
      action: "user_deleted",
      actorUserId: session.user.id,
      targetUserId: user.id,
      details: { username: user.username, name: displayName(user) },
    });
    clearLoginFailures(db, user.username);
    db.delete(users).where(eq(users.id, user.id)).run();
  });
  // An admin session viewing this user falls back to its own workspace.
  revalidateSessionViews();
  redirect("/admin");
}

async function disconnectSession(sessionId: string): Promise<void> {
  try {
    await gateway.disconnect(sessionId);
  } catch (error) {
    console.error(`[gateway] disconnect session failed: ${describeError(error)}`);
  }
}

/**
 * The session's target is shown in layouts (the admin console's "viewing" banner), which client
 * navigation otherwise reuses; revalidate the views that show it so the redirect renders the new state.
 * Not "/": that would also invalidate the prerendered routes (/icon.svg, /_not-found), and the next
 * request would try to write them back into the image's read-only .next directory.
 */
function revalidateSessionViews(): void {
  revalidatePath("/admin", "layout");
  revalidatePath("/workspace");
}

/**
 * Points the session back at the admin's own workspace, when it is viewing someone else's: clears
 * acting-as and audits it, disconnects the session (its open connections lead to the viewed workspace)
 * and releases that workspace. Every way back to the admin's own workspace goes through here.
 */
async function leaveViewedWorkspace(session: SessionContext): Promise<void> {
  if (!session.actingAs) return;
  const viewed = session.target.id;
  const db = getDb();
  db.transaction(() => {
    db.update(sessions).set({ actingAsUserId: null }).where(eq(sessions.id, session.session.id)).run();
    writeAudit(db, { action: "admin_exited_workspace", actorUserId: session.user.id, targetUserId: viewed });
  });
  await disconnectSession(session.session.id);
  releaseInBackground([viewed]);
  revalidateSessionViews();
}

/** "My workspace": the admin's own workspace, after leaving any other the session is viewing. */
export async function openMyWorkspace(): Promise<void> {
  const session = await requireAdmin();
  await leaveViewedWorkspace(session);
  redirect("/workspace");
}

/** Points the admin's session at a user's workspace (the gateway routes the iframe by session target). */
export async function openWorkspace(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const id = userIdSchema.safeParse(formData.get("userId"));
  if (!id.success) redirect("/admin");
  if (id.data === session.user.id) {
    // /workspace would still show the viewed workspace until the session leaves it.
    await leaveViewedWorkspace(session);
    redirect("/workspace");
  }
  const db = getDb();
  const user = db.select({ id: users.id }).from(users).where(eq(users.id, id.data)).get();
  if (!user) redirect("/admin");

  if (session.session.actingAsUserId !== user.id) {
    const previous = session.target.id;
    db.transaction(() => {
      // Going straight from one user's workspace to another's leaves the first one too.
      if (session.actingAs) {
        writeAudit(db, {
          action: "admin_exited_workspace",
          actorUserId: session.user.id,
          targetUserId: previous,
          details: { reason: "switched" },
        });
      }
      db.update(sessions).set({ actingAsUserId: user.id }).where(eq(sessions.id, session.session.id)).run();
      writeAudit(db, { action: "admin_opened_workspace", actorUserId: session.user.id, targetUserId: user.id });
    });
    // Before redirecting: this session's open connections still lead to the previous workspace.
    await disconnectSession(session.session.id);
    releaseInBackground([previous]);
    revalidateSessionViews();
  }
  // A stopped workspace with more than one agent enabled waits for the admin's choice on the viewing page.
  openWorkspaceInBackground(user.id);
  redirect(`/admin/users/${user.id}/workspace`);
}

export async function exitWorkspace(): Promise<void> {
  const session = await requireAdmin();
  await leaveViewedWorkspace(session);
  redirect("/admin");
}
