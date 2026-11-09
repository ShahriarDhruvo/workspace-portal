import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import {
  SESSION_COOKIE_NAME,
  generateSessionToken,
  hashSessionToken,
  loadSessionContext,
  sessions,
  type SessionContext,
} from "@portal/db";
import { config } from "./config";
import { getDb } from "./db";

/** Sliding expiry: the session row and the cookie are renewed at most this often. */
const RENEW_INTERVAL_MS = 10 * 60_000;

async function writeSessionCookie(token: string, maxAge: number): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
    secure: config.cookieSecure,
  });
}

/** The current session (null when signed out, expired or deactivated). Read-only; cached per request. */
export const getSession = cache(async (): Promise<SessionContext | null> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return loadSessionContext(getDb(), hashSessionToken(token));
});

/**
 * For pages and actions: redirects to /login when signed out, and to /change-password while the
 * account still has a temporary password (unless this is the change-password flow itself).
 */
export async function requireUser(options: { allowPasswordChange?: boolean } = {}): Promise<SessionContext> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.user.mustChangePassword && !options.allowPasswordChange) redirect("/change-password");
  return session;
}

export async function requireAdmin(): Promise<SessionContext> {
  const session = await requireUser();
  if (session.user.role !== "admin") redirect("/workspace");
  return session;
}

/** Creates a session row for the user and sets the cookie. Server Actions only. */
export async function startSession(userId: number): Promise<void> {
  const token = generateSessionToken();
  const now = Date.now();
  const userAgent = (await headers()).get("user-agent")?.slice(0, 512) ?? null;
  getDb()
    .insert(sessions)
    .values({
      id: hashSessionToken(token),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + config.sessionTtlSeconds * 1000,
      userAgent,
    })
    .run();
  await writeSessionCookie(token, config.sessionTtlSeconds);
}

/**
 * Sliding expiry. Page renders cannot set cookies, so this runs in the polling Route Handlers
 * (/api/workspace/status every 2–10 s on the workspace page, /api/admin/overview every 5 s on the
 * dashboard). That keeps `expires_at` and the cookie's Max-Age moving together.
 */
export async function renewSession(session: SessionContext): Promise<void> {
  const now = Date.now();
  if (now - session.session.lastSeenAt < RENEW_INTERVAL_MS) return;
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return;
  getDb()
    .update(sessions)
    .set({ lastSeenAt: now, expiresAt: now + config.sessionTtlSeconds * 1000 })
    .where(eq(sessions.id, session.session.id))
    .run();
  await writeSessionCookie(token, config.sessionTtlSeconds);
}

export async function clearSessionCookie(): Promise<void> {
  await writeSessionCookie("", 0);
}

/** The session id (token hash) this browser's cookie names, valid or not; null without a cookie. */
export async function cookieSessionId(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  return token ? hashSessionToken(token) : null;
}
