"use server";

import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";
import { countSessionsUsingWorkspace, sessions, users, writeAudit, type PortalDb, type SessionContext } from "@portal/db";
import { getDb } from "../db";
import { endSessionsInBackground, gateway, openWorkspaceInBackground } from "../gateway";
import { clearLoginFailures, lockRemaining, lockoutMessage, pruneLoginAttempts, reserveLoginAttempt } from "../login-throttle";
import { hashPassword, verifyPassword } from "../passwords";
import { clearSessionCookie, cookieSessionId, getSession, requireUser, startSession } from "../session";
import { deleteSessions, pruneExpiredSessions } from "../session-store";
import { changePasswordSchema, fieldErrors, formText, loginSchema, type FieldErrors } from "../validation";

export interface LoginState {
  error: string | null;
  username: string;
}

const INCORRECT = "Incorrect username or password.";

/**
 * Ends the session this browser's cookie names, valid or not: deletes the row, records an admin's open
 * view of someone's workspace as left, and after the response closes the session's agent connections and
 * releases the workspace it used. Returns the session it was, or null if it was no longer valid.
 */
async function endBrowserSession(db: PortalDb): Promise<SessionContext | null> {
  const sessionId = await cookieSessionId();
  if (!sessionId) return null;
  const session = await getSession();
  const deleted = db.transaction(() => {
    if (session?.actingAs) {
      writeAudit(db, {
        action: "admin_exited_workspace",
        actorUserId: session.user.id,
        targetUserId: session.target.id,
        details: { reason: "signed_out" },
      });
    }
    return deleteSessions(db, eq(sessions.id, sessionId));
  });
  endSessionsInBackground(deleted);
  return session;
}

export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const input = formText(formData, ["username", "password"]);
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter your username and password.", username: input.username };

  const { username, password } = parsed.data;
  const db = getDb();
  const now = Date.now();

  // Housekeeping where both tables grow: stale attempt records, and sessions past their expiry.
  pruneLoginAttempts(db, now);
  endSessionsInBackground(pruneExpiredSessions(db, now));

  // Counted as a failure before the (slow) verification, so parallel attempts can't outrun the lock.
  const attempt = reserveLoginAttempt(db, username, now);
  if (!attempt.allowed) return { error: lockoutMessage(attempt.lockedForMs), username };

  const user = db.select().from(users).where(eq(users.username, username)).get();
  // Always runs a full argon2 verification, also for unknown usernames.
  const valid = await verifyPassword(user?.passwordHash ?? null, password);
  if (!user || !valid) {
    writeAudit(db, {
      action: "login_failed",
      targetUserId: user?.id ?? null,
      details: { username, reason: user ? "wrong_password" : "unknown_user" },
    });
    const lock = lockRemaining(attempt.state, now);
    return { error: lock > 0 ? lockoutMessage(lock) : INCORRECT, username };
  }
  // The right password: the attempt reserved above was no failed guess.
  clearLoginFailures(db, username);
  if (!user.active) {
    // Only reachable with the right password, so this reveals nothing to someone guessing.
    writeAudit(db, { action: "login_failed", targetUserId: user.id, details: { username, reason: "deactivated" } });
    return { error: "This account is deactivated. Contact your administrator.", username };
  }

  // Signing in replaces whatever session this browser still had (another account's, or an expired one).
  await endBrowserSession(db);
  await startSession(user.id);
  db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id)).run();
  writeAudit(db, { action: "login", actorUserId: user.id });
  // Picks up a workspace still running (another device, a task finishing after sign-out); a stopped one
  // starts here only if there is no agent to choose.
  openWorkspaceInBackground(user.id);
  redirect(user.mustChangePassword ? "/change-password" : "/workspace");
}

export async function signOut(): Promise<void> {
  const db = getDb();
  const session = await endBrowserSession(db);
  let stillWorking = false;
  if (session) {
    writeAudit(db, { action: "logout", actorUserId: session.user.id });
    // The last session out of a workspace whose agent is mid-task: the gateway lets the task finish
    // and stops the workspace afterwards. Say so on the sign-in page.
    if (countSessionsUsingWorkspace(db, session.target.id, Date.now()) === 0) {
      stillWorking = await gateway
        .getWorkspace(session.target.id, SIGN_OUT_STATUS_TIMEOUT_MS)
        .then((info) => info.busy)
        .catch(() => false);
    }
  }
  await clearSessionCookie();
  redirect(stillWorking ? "/login?working=1" : "/login");
}

/** Sign-out never waits long on the gateway just to word the next page. */
const SIGN_OUT_STATUS_TIMEOUT_MS = 1_500;

export interface ChangePasswordState {
  fieldErrors: FieldErrors;
}

export async function changePassword(_previous: ChangePasswordState, formData: FormData): Promise<ChangePasswordState> {
  const session = await requireUser({ allowPasswordChange: true });
  const parsed = changePasswordSchema.safeParse(formText(formData, ["currentPassword", "newPassword", "confirmPassword"]));
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const { currentPassword, newPassword } = parsed.data;
  if (!(await verifyPassword(session.user.passwordHash, currentPassword))) {
    return { fieldErrors: { currentPassword: "That isn't your current password." } };
  }

  const db = getDb();
  const passwordHash = await hashPassword(newPassword);
  // Every other session of this account is signed out; this one carries on.
  const deleted = db.transaction(() => {
    db.update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: Date.now() })
      .where(eq(users.id, session.user.id))
      .run();
    writeAudit(db, { action: "password_changed", actorUserId: session.user.id });
    return deleteSessions(db, and(eq(sessions.userId, session.user.id), ne(sessions.id, session.session.id)));
  });
  endSessionsInBackground(deleted);
  redirect("/workspace");
}
