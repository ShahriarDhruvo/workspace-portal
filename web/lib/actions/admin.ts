"use server";

import { eq } from "drizzle-orm";
import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { displayName, sessions, users, WORKSPACE_KIND_NAMES, writeAudit, type SessionContext, type User } from "@portal/core";
import { getDb } from "../db";
import { attachWorkspaceInBackground, endSessionsInBackground, gateway, logFailure, releaseInBackground, toApiError } from "../gateway";
import { restartWorkspaceOf, saveHarnessOf } from "../harness";
import { clearLoginFailures } from "../login-throttle";
import { generateTemporaryPassword } from "../password-generator";
import { hashPassword } from "../passwords";
import { saveProfile, type ProfileState } from "../profile";
import { insertUser } from "../seed";
import { requireAdmin } from "../session";
import { deleteSessions } from "../session-store";
import {
  eraseFilesSchema,
  fieldErrors,
  formText,
  newUserFormSchema,
  onlineAccessSchema,
  userIdSchema,
  type ActionResult,
  type FieldErrors,
} from "../validation";

// Every action re-checks the admin role (requireAdmin), validates its input with zod, and is audited.

/** Result of the confirm-dialog actions (stop, reset password, activate/deactivate, delete, erase files, Online access). */
export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "done"; temporaryPassword?: string };

type Target = { session: SessionContext; user: User } | { error: string };

/** The admin's session and the user an action is about. Accounts other than the admin's own unless `allowSelf`. */
async function loadTarget(formData: FormData, options: { allowSelf?: boolean } = {}): Promise<Target> {
  const session = await requireAdmin();
  const id = userIdSchema.safeParse(formData.get("userId"));
  if (!id.success) return { error: "Unknown user." };
  return loadUserById(id.data, session, options);
}

/** loadTarget for an id parsed already (with the action's other fields). */
function loadUserById(id: number, session: SessionContext, options: { allowSelf?: boolean } = {}): Target {
  const user = getDb().select().from(users).where(eq(users.id, id)).get();
  if (!user) return { error: "This user no longer exists." };
  if (!options.allowSelf && (user.id === session.user.id || user.role === "admin")) {
    return { error: "This action is not available for the administrator account." };
  }
  return { session, user };
}

const NEW_USER_FIELDS = ["firstName", "middleName", "lastName", "username", "password", "onlineAllowed"] as const;
type NewUserValues = Record<(typeof NEW_USER_FIELDS)[number], string>;

export type CreateUserState =
  | { status: "idle" }
  | { status: "invalid"; fieldErrors: FieldErrors; values: NewUserValues }
  | { status: "created"; user: { id: number; name: string; username: string }; temporaryPassword: string };

export async function createUser(_previous: CreateUserState, formData: FormData): Promise<CreateUserState> {
  const session = await requireAdmin();
  const values = formText(formData, NEW_USER_FIELDS);
  const parsed = newUserFormSchema.safeParse(values);
  if (!parsed.success) return { status: "invalid", fieldErrors: fieldErrors(parsed.error), values };

  const { username, password, firstName, middleName, lastName, onlineAllowed } = parsed.data;
  const db = getDb();
  const taken = { status: "invalid", fieldErrors: { username: "That username is already taken." }, values } as const;
  if (db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()) return taken;

  const passwordHash = await hashPassword(password);
  let created: User;
  try {
    created = db.transaction(() => {
      clearLoginFailures(db, username);
      return insertUser(db, { username, firstName, middleName, lastName, passwordHash, role: "user", onlineAllowed }, { actorUserId: session.user.id, details: { username, onlineAllowed } });
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

export async function updateProfile(_previous: ProfileState, formData: FormData): Promise<ProfileState> {
  const target = await loadTarget(formData, { allowSelf: true });
  if ("error" in target) return { status: "error", message: target.error };
  return saveProfile(target.session.user.id, target.user, formData);
}

export async function resetPassword(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const target = await loadTarget(formData);
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
    writeAudit(db, { action: "password_reset", actorUserId: target.session.user.id, targetUserId: target.user.id });
    return deleteSessions(db, eq(sessions.userId, target.user.id));
  });
  endSessionsInBackground(deleted);
  refresh();
  return { status: "done", temporaryPassword };
}

export async function setUserActive(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const target = await loadTarget(formData);
  if ("error" in target) return { status: "error", message: target.error };
  const active = formData.get("active") === "true";
  const db = getDb();

  if (target.user.active !== active) {
    const deleted = db.transaction(() => {
      db.update(users).set({ active, updatedAt: Date.now() }).where(eq(users.id, target.user.id)).run();
      writeAudit(db, {
        action: active ? "user_activated" : "user_deactivated",
        actorUserId: target.session.user.id,
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
      await gateway.stop(target.user.id, "deactivated", target.session.user.id);
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
  const target = await loadTarget(formData, { allowSelf: true });
  if ("error" in target) return { status: "error", message: target.error };
  try {
    await gateway.stop(target.user.id, "admin", target.session.user.id);
  } catch (error) {
    return { status: "error", message: toApiError(error).message };
  }
  refresh();
  return { status: "done" };
}

/** The user a harness action is about, or why there is none. The administrator's own account included. */
async function loadHarnessTarget(userId: number): Promise<Target> {
  const session = await requireAdmin();
  const id = userIdSchema.safeParse(userId);
  if (!id.success) return { error: "Unknown user." };
  return loadUserById(id.data, session, { allowSelf: true });
}

/** Sets the harness a user's workspace starts with, as Home does for one's own (lib/harness.ts). */
export async function setUserHarness(userId: number, agent: string): Promise<ActionResult> {
  const target = await loadHarnessTarget(userId);
  if ("error" in target) return { ok: false, message: target.error };
  return saveHarnessOf(target.user, agent, target.session.user.id);
}

/**
 * "Restart now" on a user's page: their running workspace again, with the harness now saved. The page warns first
 * when their agent is working or they have it open. One that stopped since the page rendered stays stopped.
 */
export async function restartUserWorkspace(userId: number): Promise<ActionResult> {
  const target = await loadHarnessTarget(userId);
  if ("error" in target) return { ok: false, message: target.error };
  return restartWorkspaceOf(target.user.id, target.session.user.id, "The workspace has stopped since this page loaded.");
}

/** Switching it off also stops the user's Online workspace if it starts or runs (the confirmation says so). */
export async function setOnlineAccess(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const parsed = onlineAccessSchema.safeParse({ userId: formData.get("userId"), allowed: formData.get("allowed") });
  if (!parsed.success) return { status: "error", message: "Unknown user." };
  const target = loadUserById(parsed.data.userId, session, { allowSelf: true });
  if ("error" in target) return { status: "error", message: target.error };
  const { allowed } = parsed.data;

  if (target.user.onlineAllowed !== allowed) {
    const db = getDb();
    db.transaction(() => {
      db.update(users).set({ onlineAllowed: allowed, updatedAt: Date.now() }).where(eq(users.id, target.user.id)).run();
      writeAudit(db, {
        action: "user_online_access_changed",
        actorUserId: session.user.id,
        targetUserId: target.user.id,
        details: { allowed },
      });
    });
    refresh();
  }
  if (!allowed) {
    // After the write, so a start racing this one is refused by the gateway or stopped here.
    try {
      const workspace = await gateway.getWorkspace(target.user.id);
      if (workspace.kind === "online" && (workspace.status === "starting" || workspace.status === "running")) {
        await gateway.stop(target.user.id, "admin", session.user.id);
      }
    } catch (error) {
      return {
        status: "error",
        message: `Online access is off, but the Online workspace could not be stopped: ${toApiError(error).message}`,
      };
    }
  }
  return { status: "done" };
}

/**
 * Erases one kind's files: that workspace's home and workspace folders, left empty. The gateway refuses while that
 * kind is starting, running or stopping, and writes the `workspace_files_erased` audit entry.
 */
export async function eraseWorkspaceFiles(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const parsed = eraseFilesSchema.safeParse({ userId: formData.get("userId"), kind: formData.get("kind") });
  if (!parsed.success) return { status: "error", message: "Unknown user or workspace." };
  const target = loadUserById(parsed.data.userId, session, { allowSelf: true });
  if ("error" in target) return { status: "error", message: target.error };
  const { kind } = parsed.data;
  try {
    await gateway.eraseFiles(target.user.id, kind, session.user.id);
  } catch (error) {
    const problem = toApiError(error);
    return {
      status: "error",
      message:
        problem.error === "workspace_running"
          ? `The ${WORKSPACE_KIND_NAMES[kind]} workspace is running. Stop it first.`
          : problem.message,
    };
  }
  refresh();
  return { status: "done" };
}

export async function deleteUser(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const target = await loadTarget(formData);
  if ("error" in target) return { status: "error", message: target.error };
  const { session, user } = target;
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
  redirect("/admin/users");
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
  await logFailure("disconnect session", () => gateway.disconnect(session.session.id));
  releaseInBackground([viewed]);
  revalidateSessionViews();
}

/** "My workspace": Home, with the admin's own workspace, after leaving any other the session is viewing. */
export async function openMyWorkspace(): Promise<void> {
  const session = await requireAdmin();
  await leaveViewedWorkspace(session);
  redirect("/");
}

/** Points the admin's session at a user's workspace (the gateway routes the iframe by session target). */
export async function openWorkspace(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const id = userIdSchema.safeParse(formData.get("userId"));
  if (!id.success) redirect("/admin/users");
  if (id.data === session.user.id) {
    // Home would still show the viewed workspace until the session leaves it.
    await leaveViewedWorkspace(session);
    redirect("/");
  }
  const db = getDb();
  const user = db.select({ id: users.id }).from(users).where(eq(users.id, id.data)).get();
  if (!user) redirect("/admin/users");

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
    await logFailure("disconnect session", () => gateway.disconnect(session.session.id));
    releaseInBackground([previous]);
    revalidateSessionViews();
  }
  // A stopped workspace stays stopped: the viewing page offers Start, which launches the user's harness.
  attachWorkspaceInBackground(user.id);
  redirect(`/admin/users/${user.id}/workspace`);
}

export async function exitWorkspace(): Promise<void> {
  const session = await requireAdmin();
  await leaveViewedWorkspace(session);
  redirect("/admin/users");
}
