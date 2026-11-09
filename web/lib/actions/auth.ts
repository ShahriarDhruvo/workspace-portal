"use server";

import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";
import { countSessionsUsingWorkspace, sessions, users, writeAudit } from "@portal/db";
import { getDb } from "../db";
import { afterResponse, gateway, releaseInBackground, startInBackground } from "../gateway";
import { clearLoginFailures, lockRemaining, lockoutMessage, loginLockRemaining, recordLoginFailure } from "../login-throttle";
import { hashPassword, verifyPassword } from "../passwords";
import { clearSessionCookie, deleteSessions, getSession, requireUser, startSession } from "../session";
import { changePasswordSchema, fieldErrors, formText, loginSchema, type FieldErrors } from "../validation";

export interface LoginState {
  error: string | null;
  username: string;
}

const INCORRECT = "Incorrect username or password.";

export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const input = formText(formData, ["username", "password"]);
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter your username and password.", username: input.username };

  const { username, password } = parsed.data;
  const db = getDb();
  const now = Date.now();

  const locked = loginLockRemaining(db, username, now);
  if (locked > 0) return { error: lockoutMessage(locked), username };

  const user = db.select().from(users).where(eq(users.username, username)).get();
  // Always runs a full argon2 verification, also for unknown usernames.
  const valid = await verifyPassword(user?.passwordHash ?? null, password);
  if (!user || !valid) {
    const state = recordLoginFailure(db, username, now);
    writeAudit(db, {
      action: "login_failed",
      targetUserId: user?.id ?? null,
      details: { username, reason: user ? "wrong_password" : "unknown_user" },
    });
    const lock = lockRemaining(state, now);
    return { error: lock > 0 ? lockoutMessage(lock) : INCORRECT, username };
  }
  if (!user.active) {
    // Only reachable with the right password, so this reveals nothing to someone guessing.
    writeAudit(db, { action: "login_failed", targetUserId: user.id, details: { username, reason: "deactivated" } });
    return { error: "This account is deactivated. Contact your administrator.", username };
  }

  clearLoginFailures(db, username);
  await startSession(user.id);
  db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id)).run();
  writeAudit(db, { action: "login", actorUserId: user.id });
  startInBackground(user.id);
  redirect(user.mustChangePassword ? "/change-password" : "/workspace");
}

export async function signOut(): Promise<void> {
  const session = await getSession();
  let stillWorking = false;
  if (session) {
    const db = getDb();
    const released = deleteSessions(db, eq(sessions.id, session.session.id));
    writeAudit(db, { action: "logout", actorUserId: session.user.id });
    const sessionId = session.session.id;
    afterResponse("disconnect signed-out session", () => gateway.disconnect(sessionId));
    releaseInBackground(released);
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
  const released = db.transaction(() => {
    db.update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: Date.now() })
      .where(eq(users.id, session.user.id))
      .run();
    writeAudit(db, { action: "password_changed", actorUserId: session.user.id });
    return deleteSessions(db, and(eq(sessions.userId, session.user.id), ne(sessions.id, session.session.id)));
  });
  releaseInBackground(released.filter((userId) => userId !== session.target.id));
  redirect("/workspace");
}
