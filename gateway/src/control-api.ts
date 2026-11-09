// Control API for the web app (127.0.0.1:CONTROL_PORT, bearer token). JSON in and out; errors are
// `{ error, message }`. Routes and shapes: docs/ARCHITECTURE.md, "Gateway control API".
import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { users, type PortalDb } from "@portal/db";
import type { Config } from "./config.ts";
import { SESSION_DISCONNECTED, type ConnectionRegistry } from "./connections.ts";
import { readHostStats } from "./host-stats.ts";
import { HttpError, readJsonBody, sendError, sendJson, splitTarget } from "./http-util.ts";
import type { LlmQueue } from "./llm-queue.ts";
import type { Logger } from "./log.ts";
import type { SessionCache } from "./session-cache.ts";
import { CapacityError, StartError, type WorkspaceManager } from "./workspaces.ts";

export interface ControlDeps {
  config: Config;
  db: PortalDb;
  manager: WorkspaceManager;
  llm: LlmQueue;
  sessions: SessionCache;
  connections: ConnectionRegistry;
  log: Logger;
}

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REASON_LENGTH = 64;

type Handler = (deps: ControlDeps, req: IncomingMessage, params: string[]) => Promise<unknown> | unknown;

interface Route {
  method: "GET" | "POST" | "DELETE";
  pattern: RegExp;
  handler: Handler;
}

const ROUTES: Route[] = [
  { method: "GET", pattern: /^\/control\/health$/, handler: () => ({ ok: true }) },
  { method: "GET", pattern: /^\/control\/stats$/, handler: (deps) => readHostStats(deps.config, deps.manager, deps.llm) },
  { method: "GET", pattern: /^\/control\/workspaces$/, handler: (deps) => ({ workspaces: deps.manager.list() }) },
  { method: "GET", pattern: /^\/control\/workspaces\/([^/]+)$/, handler: (deps, _req, [id]) => deps.manager.info(userIdParam(id)) },
  {
    method: "POST",
    pattern: /^\/control\/workspaces\/([^/]+)\/start$/,
    handler: async (deps, _req, [id]) => {
      const userId = userIdParam(id);
      requireUser(deps.db, userId, "userId");
      try {
        return await deps.manager.start(userId);
      } catch (error) {
        if (error instanceof CapacityError) throw new HttpError(409, "capacity", error.message);
        if (error instanceof StartError) throw new HttpError(500, "start_failed", error.message);
        throw error;
      }
    },
  },
  {
    method: "POST",
    pattern: /^\/control\/workspaces\/([^/]+)\/stop$/,
    handler: async (deps, req, [id]) => {
      const userId = userIdParam(id);
      const { reason, actorUserId } = stopBody(await readJsonBody(req, MAX_BODY_BYTES));
      if (actorUserId !== null) requireUser(deps.db, actorUserId, "actorUserId");
      deps.sessions.invalidateUser(userId);
      return deps.manager.stop(userId, reason, actorUserId);
    },
  },
  {
    method: "POST",
    pattern: /^\/control\/workspaces\/([^/]+)\/release$/,
    handler: (deps, _req, [id]) => {
      const userId = userIdParam(id);
      deps.sessions.invalidateUser(userId);
      return deps.manager.release(userId);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/control\/workspaces\/([^/]+)\/data$/,
    handler: async (deps, _req, [id]) => {
      const userId = userIdParam(id);
      deps.sessions.invalidateUser(userId);
      await deps.manager.deleteData(userId);
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: /^\/control\/sessions\/([^/]+)\/disconnect$/,
    handler: (deps, _req, [id]) => {
      const sessionId = decodeParam(id);
      deps.sessions.invalidateSession(sessionId);
      return { closed: deps.connections.closeSession(sessionId, SESSION_DISCONNECTED, "session disconnected") };
    },
  },
];

export function createControlServer(deps: ControlDeps): http.Server {
  const expected = digest(`Bearer ${deps.config.controlSecret}`);
  return http.createServer((req, res) => {
    handle(deps, expected, req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return sendError(res, error.status, error.code, error.message);
      deps.log.error("control request failed", { method: req.method, path: splitTarget(req.url ?? "").pathname, error });
      sendError(res, 500, "internal", "Internal error.");
    });
  });
}

async function handle(deps: ControlDeps, expected: Buffer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!crypto.timingSafeEqual(digest(req.headers.authorization ?? ""), expected)) {
    return sendError(res, 401, "unauthorized", "Missing or wrong control token.", { "www-authenticate": "Bearer" });
  }
  const { pathname } = splitTarget(req.url ?? "");
  const matches = ROUTES.map((route) => ({ route, match: route.pattern.exec(pathname) })).filter((m) => m.match !== null);
  if (matches.length === 0) return sendError(res, 404, "not_found", "Unknown route.");
  const found = matches.find((m) => m.route.method === req.method);
  if (!found) {
    const allow = matches.map((m) => m.route.method).join(", ");
    return sendError(res, 405, "method_not_allowed", `Use ${allow}.`, { allow });
  }
  sendJson(res, 200, await found.route.handler(deps, req, found.match!.slice(1)));
}

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

function decodeParam(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    throw new HttpError(400, "bad_request", "Malformed path parameter.");
  }
}

function userIdParam(value: string | undefined): number {
  const text = decodeParam(value);
  const userId = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new HttpError(400, "invalid_user_id", "userId must be a positive integer.");
  }
  return userId;
}

/** A path user must exist (404); a user named in the body must exist too (400). */
function requireUser(db: PortalDb, userId: number, field: "userId" | "actorUserId"): void {
  if (db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get()) return;
  if (field === "userId") throw new HttpError(404, "user_not_found", `There is no user ${userId}.`);
  throw new HttpError(400, "invalid_actor", `actorUserId ${userId} is not a user.`);
}

/** `{ reason?: string, actorUserId?: number }`; the reason defaults to "admin". */
function stopBody(body: unknown): { reason: string; actorUserId: number | null } {
  if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body))) {
    throw new HttpError(400, "bad_request", "The body must be a JSON object.");
  }
  const { reason, actorUserId } = (body ?? {}) as { reason?: unknown; actorUserId?: unknown };
  if (reason !== undefined && (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_REASON_LENGTH)) {
    throw new HttpError(400, "invalid_reason", `reason must be a non-empty string of at most ${MAX_REASON_LENGTH} characters.`);
  }
  if (actorUserId !== undefined && actorUserId !== null && !(Number.isSafeInteger(actorUserId) && (actorUserId as number) > 0)) {
    throw new HttpError(400, "invalid_actor", "actorUserId must be a positive integer.");
  }
  return { reason: reason === undefined ? "admin" : reason.trim(), actorUserId: (actorUserId as number | null | undefined) ?? null };
}
