// Control API for the web app (127.0.0.1:CONTROL_PORT, bearer token). JSON in and out; errors are
// `{ error, message }`. Routes and shapes: docs/ARCHITECTURE.md, "Gateway control API".
import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import {
  AGENT_KINDS,
  isAgentKind,
  isWorkspaceKind,
  STOP_REASONS,
  users,
  WORKSPACE_KINDS,
  type AgentInfo,
  type AgentKind,
  type PortalDb,
  type StopReason,
  type WorkspaceKind,
} from "@portal/core";
import {
  ImageCurrentError,
  InvalidVersionError,
  UpdateRunningError,
  VersionNotFoundError,
  type AgentUpdater,
  type UpdateRequest,
} from "./updates/agent-updater.ts";
import type { AgentVersions } from "./updates/agent-versions.ts";
import { driverFor } from "./agents/index.ts";
import type { Config } from "./config.ts";
import { SESSION_DISCONNECTED, type ConnectionRegistry } from "./proxy/connections.ts";
import {
  EngineJobRunningError,
  EngineRequestError,
  EngineUnavailableError,
  type EngineUpdater,
} from "./updates/engine-updater.ts";
import { readHostStats } from "./monitor/host-stats.ts";
import { HostdError } from "./monitor/hostd.ts";
import { HttpError, readJsonBody, sendError, sendJson, splitTarget } from "./lib/http-util.ts";
import { ImageInUseError, ImageNotFoundError } from "./docker/image-builder.ts";
import { TooManyViewersError, type LiveHub } from "./monitor/live.ts";
import type { EnergyPrices } from "./monitor/energy-prices.ts";
import type { LlmQueue } from "./service/llm-queue.ts";
import type { Logger } from "./lib/log.ts";
import { RegistryError } from "./updates/npm-registry.ts";
import type { SessionCache } from "./proxy/session-cache.ts";
import {
  AgentMismatchError,
  AgentUnavailableError,
  CapacityError,
  DeletingError,
  KindMismatchError,
  NoWorkspacePortError,
  OnlineDisabledError,
  OnlineNotAllowedError,
  StartError,
  StopError,
  WorkspaceRunningError,
  type WorkspaceManager,
} from "./workspaces/manager.ts";

export interface ControlDeps {
  config: Config;
  db: PortalDb;
  manager: WorkspaceManager;
  versions: AgentVersions;
  updater: AgentUpdater;
  engine: EngineUpdater;
  llm: LlmQueue;
  live: LiveHub;
  prices: EnergyPrices;
  sessions: SessionCache;
  connections: ConnectionRegistry;
  log: Logger;
}

const MAX_BODY_BYTES = 16 * 1024;

/** A handler that wrote the response itself (an event stream) returns this. */
const RESPONDED = Symbol("responded");

type Handler = (deps: ControlDeps, req: IncomingMessage, params: string[], res: ServerResponse) => Promise<unknown> | unknown;

interface Route {
  method: "GET" | "POST" | "DELETE";
  pattern: RegExp;
  handler: Handler;
}

const ROUTES: Route[] = [
  { method: "GET", pattern: /^\/control\/health$/, handler: () => ({ ok: true }) },
  { method: "GET", pattern: /^\/control\/stats$/, handler: (deps) => readHostStats(deps.config, deps.manager, deps.llm) },
  {
    method: "GET",
    pattern: /^\/control\/live$/,
    handler: (deps, _req, _params, res) => {
      try {
        deps.live.serve(res);
      } catch (error) {
        if (error instanceof TooManyViewersError) throw new HttpError(429, "too_many_viewers", error.message);
        throw error;
      }
      return RESPONDED;
    },
  },
  { method: "GET", pattern: /^\/control\/agents$/, handler: (deps) => ({ agents: agentList(deps.config, deps.versions) }) },
  // Admin > Energy's electricity prices (energy-prices.ts): the downloads' state, and a download now when the admin
  // picks a place (a source downloaded in the last 10 minutes is not asked again). Answers once both are done.
  { method: "GET", pattern: /^\/control\/energy-prices$/, handler: (deps) => deps.prices.status() },
  { method: "POST", pattern: /^\/control\/energy-prices\/refresh$/, handler: (deps) => deps.prices.refresh() },
  {
    // For deploy/install.sh and update-image.sh: answers at once (no registry or hostd call).
    method: "GET",
    pattern: /^\/control\/updates\/running$/,
    handler: (deps) => {
      const agent = deps.updater.job()?.finishedAt === null;
      const engine = deps.engine.snapshot()?.finishedAt === null;
      return { running: agent || engine, agent, engine };
    },
  },
  {
    method: "GET",
    pattern: /^\/control\/agents\/versions$/,
    handler: (deps, req) => deps.updater.overview({ refresh: new URLSearchParams(splitTarget(req.url ?? "").search).get("refresh") === "1" }),
  },
  {
    method: "POST",
    pattern: /^\/control\/agents\/update\/cancel$/,
    handler: (deps) => ({ cancelled: deps.updater.cancel() }),
  },
  {
    method: "POST",
    pattern: /^\/control\/agents\/([^/]+)\/update$/,
    handler: async (deps, req, [agent]) => {
      const kind = agentParam(agent);
      const body = updateBody(kind, await readJsonBody(req, MAX_BODY_BYTES));
      if (body.actorUserId !== null) requireUser(deps.db, body.actorUserId, "actorUserId");
      try {
        return await deps.updater.startUpdate(body);
      } catch (error) {
        if (error instanceof AgentUnavailableError) throw new HttpError(400, "agent_unavailable", error.message);
        if (error instanceof InvalidVersionError) throw new HttpError(400, "invalid_version", error.message);
        if (error instanceof VersionNotFoundError) throw new HttpError(404, "version_not_found", error.message);
        if (error instanceof UpdateRunningError) throw new HttpError(409, "update_running", error.message);
        if (error instanceof RegistryError) throw new HttpError(502, "registry_unreachable", error.message);
        throw error;
      }
    },
  },
  {
    method: "DELETE",
    pattern: /^\/control\/agents\/([^/]+)\/images\/([^/]+)$/,
    handler: async (deps, _req, [agent, version]) => {
      const kind = agentParam(agent);
      try {
        await deps.updater.removeImage(kind, decodeParam(version));
      } catch (error) {
        if (error instanceof InvalidVersionError) throw new HttpError(400, "invalid_version", error.message);
        if (error instanceof ImageNotFoundError) throw new HttpError(404, "not_found", error.message);
        if (error instanceof ImageCurrentError) throw new HttpError(409, "image_current", error.message);
        if (error instanceof ImageInUseError) throw new HttpError(409, "image_in_use", error.message);
        if (error instanceof UpdateRunningError) throw new HttpError(409, "update_running", error.message);
        throw error;
      }
      return { ok: true };
    },
  },
  {
    method: "GET",
    pattern: /^\/control\/engine$/,
    handler: (deps, req) => deps.engine.overview({ refresh: new URLSearchParams(splitTarget(req.url ?? "").search).get("refresh") === "1" }),
  },
  {
    method: "POST",
    pattern: /^\/control\/engine\/update$/,
    handler: async (deps, req) => {
      const { version, actorUserId } = objectBody(await readJsonBody(req, MAX_BODY_BYTES));
      if (typeof version !== "string" || version.length > 64) throw new HttpError(400, "invalid_version", "version must be a release version, like 0.34.0.");
      const actor = actorParam(actorUserId);
      if (actor !== null) requireUser(deps.db, actor, "actorUserId");
      return engineCall(() => deps.engine.startUpdate({ version, actorUserId: actor }));
    },
  },
  { method: "POST", pattern: /^\/control\/engine\/cancel$/, handler: async (deps) => ({ cancelled: await deps.engine.cancel() }) },
  { method: "POST", pattern: /^\/control\/engine\/restart-now$/, handler: (deps) => ({ ok: deps.engine.restartNow() }) },
  {
    method: "DELETE",
    pattern: /^\/control\/engine\/images\/([^/]+)$/,
    handler: async (deps, _req, [digest]) => {
      await engineCall(() => deps.engine.removeImage(decodeParam(digest)));
      return { ok: true };
    },
  },
  { method: "GET", pattern: /^\/control\/workspaces$/, handler: (deps) => ({ workspaces: deps.manager.list() }) },
  { method: "GET", pattern: /^\/control\/workspaces\/([^/]+)$/, handler: (deps, _req, [id]) => deps.manager.info(userIdParam(id)) },
  {
    method: "POST",
    pattern: /^\/control\/workspaces\/([^/]+)\/start$/,
    handler: async (deps, req, [id]) => {
      const userId = userIdParam(id);
      const options = startBody(await readJsonBody(req, MAX_BODY_BYTES));
      requireUser(deps.db, userId, "userId");
      try {
        return await deps.manager.start(userId, options);
      } catch (error) {
        if (error instanceof AgentUnavailableError) throw new HttpError(400, "agent_unavailable", error.message);
        if (error instanceof AgentMismatchError) throw new HttpError(409, "agent_mismatch", error.message);
        if (error instanceof KindMismatchError) throw new HttpError(409, "kind_mismatch", error.message);
        if (error instanceof NoWorkspacePortError) throw new HttpError(409, "no_workspace_port", error.message);
        if (error instanceof OnlineDisabledError) throw new HttpError(409, "online_disabled", error.message);
        if (error instanceof OnlineNotAllowedError) throw new HttpError(403, "online_not_allowed", error.message);
        if (error instanceof CapacityError) throw new HttpError(409, "capacity", error.message);
        if (error instanceof DeletingError) throw new HttpError(409, "deleting", error.message);
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
    pattern: /^\/control\/workspaces\/([^/]+)\/attach$/,
    handler: (deps, _req, [id]) => deps.manager.attach(userIdParam(id)),
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
    // Admin's "Erase Private files…" / "Erase Online files…": that kind's home and workspace, left empty.
    method: "DELETE",
    pattern: /^\/control\/workspaces\/([^/]+)\/files$/,
    handler: async (deps, req, [id]) => {
      const userId = userIdParam(id);
      const kind = kindParam(new URLSearchParams(splitTarget(req.url ?? "").search).get("kind") ?? undefined);
      const actor = actorParam(objectBody(await readJsonBody(req, MAX_BODY_BYTES)).actorUserId);
      requireUser(deps.db, userId, "userId");
      if (actor !== null) requireUser(deps.db, actor, "actorUserId");
      try {
        await deps.manager.eraseFiles(userId, kind, actor);
      } catch (error) {
        if (error instanceof WorkspaceRunningError) throw new HttpError(409, "workspace_running", error.message);
        if (error instanceof DeletingError) throw new HttpError(409, "deleting", error.message);
        throw error;
      }
      return { ok: true };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/control\/workspaces\/([^/]+)\/data$/,
    handler: async (deps, _req, [id]) => {
      const userId = userIdParam(id);
      deps.sessions.invalidateUser(userId);
      try {
        await deps.manager.deleteData(userId);
      } catch (error) {
        if (error instanceof StopError) throw new HttpError(500, "stop_failed", error.message);
        throw error;
      }
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
  const body = await found.route.handler(deps, req, found.match!.slice(1), res);
  if (body !== RESPONDED) sendJson(res, 200, body);
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

/** The agents enabled on this install, in display order, with the version new workspaces start with. */
function agentList(config: Config, versions: AgentVersions): AgentInfo[] {
  return config.workspace.agents.map((id) => {
    const { name, description } = driverFor(id);
    return { id, name, description, version: versions.current(id) };
  });
}

function unknownAgent(): HttpError {
  return new HttpError(400, "unknown_agent", `agent must be one of ${AGENT_KINDS.map((kind) => `"${kind}"`).join(", ")}.`);
}

/** An agent kind in the path. */
function agentParam(value: string | undefined): AgentKind {
  const agent = decodeParam(value);
  if (!isAgentKind(agent)) throw unknownAgent();
  return agent;
}

/** An AgentUpdateRequest, checked. */
function updateBody(agent: AgentKind, body: unknown): UpdateRequest {
  const { version, rebuild, actorUserId } = objectBody(body);
  if (typeof version !== "string" || version.trim() === "" || version.length > 128) {
    throw new HttpError(400, "bad_request", "version must be a version, like 0.27.4.");
  }
  if (rebuild !== undefined && rebuild !== null && typeof rebuild !== "boolean") throw new HttpError(400, "bad_request", "rebuild must be true or false.");
  return { agent, version, rebuild: rebuild === true, actorUserId: actorParam(actorUserId) };
}

/** An optional acting user's id in a body: a positive integer, or none. */
function actorParam(actorUserId: unknown): number | null {
  if (actorUserId === undefined || actorUserId === null) return null;
  if (!(Number.isSafeInteger(actorUserId) && (actorUserId as number) > 0)) throw new HttpError(400, "invalid_actor", "actorUserId must be a positive integer.");
  return actorUserId as number;
}

/** Runs an engine action, turning its refusals into API errors. */
async function engineCall<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof EngineUnavailableError) throw new HttpError(503, "engine_unavailable", error.message);
    if (error instanceof EngineJobRunningError) throw new HttpError(409, "engine_job_running", error.message);
    if (error instanceof EngineRequestError) {
      const status = { invalid_version: 400, invalid_digest: 400, version_not_found: 404 }[error.code] ?? 409;
      throw new HttpError(status, error.code, error.message);
    }
    if (error instanceof HostdError) {
      // hostd's own refusals (the running image, a job it runs) are the admin's to see; the rest is a fault.
      if (error.status === 409 || error.status === 404) throw new HttpError(error.status, error.code, error.message);
      throw new HttpError(502, "hostd_failed", `portal-hostd on the LLM server: ${error.message}`);
    }
    throw error;
  }
}

/** A JSON object body, or none (an empty object). */
function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "bad_request", "The body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function unknownKind(): HttpError {
  return new HttpError(400, "unknown_kind", `kind must be one of ${WORKSPACE_KINDS.map((kind) => `"${kind}"`).join(", ")}.`);
}

/** A workspace kind (the `kind` query parameter); required. */
function kindParam(value: string | undefined): WorkspaceKind {
  if (!isWorkspaceKind(value)) throw unknownKind();
  return value;
}

/**
 * `{ agent?: AgentKind, kind?: WorkspaceKind }`. Without an agent the user's own (Settings) starts; without a kind the
 * start attaches to whichever kind runs, else starts Private (see WorkspaceManager.requestStart).
 */
function startBody(body: unknown): { agent?: AgentKind; kind?: WorkspaceKind } {
  const { agent, kind } = objectBody(body);
  if (agent !== undefined && agent !== null && !isAgentKind(agent)) throw unknownAgent();
  if (kind !== undefined && kind !== null && !isWorkspaceKind(kind)) throw unknownKind();
  return {
    ...(agent === undefined || agent === null ? {} : { agent }),
    ...(kind === undefined || kind === null ? {} : { kind }),
  };
}

/** `{ reason?: StopReason, actorUserId?: number }`; the reason defaults to "admin". */
function stopBody(body: unknown): { reason: StopReason; actorUserId: number | null } {
  const { reason, actorUserId } = objectBody(body);
  if (reason !== undefined && !STOP_REASONS.includes(reason as StopReason)) {
    throw new HttpError(400, "invalid_reason", `reason must be one of ${STOP_REASONS.map((r) => `"${r}"`).join(", ")}.`);
  }
  return { reason: (reason as StopReason | undefined) ?? "admin", actorUserId: actorParam(actorUserId) };
}
