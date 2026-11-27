// Control API for the web app (127.0.0.1:CONTROL_PORT, bearer token). JSON in and out; errors are
// `{ error, message }`. Routes and shapes: docs/ARCHITECTURE.md, "Gateway control API". The same port answers the
// LLM API the web app passes on (/llm/api, service/llm-api.ts), which is opened by a user's API key instead.
import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { AGENT_KINDS, STOP_REASONS, users, WORKSPACE_KINDS, type AgentInfo, type AgentKind, type PortalDb, type StopReason, type WorkspaceKind } from "@portal/core";
import type { AgentUpdater, UpdateRequest } from "./updates/agent-updater.ts";
import type { AgentVersions } from "./updates/agent-versions.ts";
import { driverFor, modelCatalog } from "@portal/harnesses";
import type { Config } from "./config.ts";
import { SESSION_DISCONNECTED, type ConnectionRegistry } from "./proxy/connections.ts";
import { invalidVersion, type EngineUpdater } from "./updates/engine-updater.ts";
import type { AppUpdater } from "./updates/app-updater.ts";
import { readHostStats } from "./monitor/host-stats.ts";
import { HttpError, readJsonBody, sendError, sendJson, splitTarget } from "./lib/http-util.ts";
import type { LiveHub } from "./monitor/live.ts";
import type { EnergyPrices } from "./monitor/energy-prices.ts";
import type { LlmRequests } from "./monitor/llm-requests.ts";
import { isLlmApi, serveLlmApi } from "./service/llm-api.ts";
import type { VideoJobs } from "./service/video-jobs.ts";
import type { LlmQueue } from "./service/llm-queue.ts";
import type { Logger } from "./lib/log.ts";
import type { SessionCache } from "./proxy/session-cache.ts";
import type { WorkspaceManager } from "./workspaces/manager.ts";

interface ControlDeps {
  config: Config;
  db: PortalDb;
  manager: WorkspaceManager;
  versions: AgentVersions;
  updater: AgentUpdater;
  engine: EngineUpdater;
  apps: AppUpdater;
  llm: LlmQueue;
  requests: LlmRequests;
  videoJobs: VideoJobs;
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
      deps.live.serve(res);
      return RESPONDED;
    },
  },
  { method: "GET", pattern: /^\/control\/agents$/, handler: (deps) => ({ agents: agentList(deps.config, deps.versions) }) },
  {
    // The admin's models (the same for both kinds of workspace), the default first: what the API page says to ask for.
    method: "GET",
    pattern: /^\/control\/models$/,
    handler: (deps) => {
      const { models, defaultModel } = modelCatalog(deps.config);
      return { models: [defaultModel, ...models.map((model) => model.id).filter((id) => id !== defaultModel)] };
    },
  },
  { method: "GET", pattern: /^\/control\/energy-prices$/, handler: (deps) => deps.prices.status() },
  // Answers once both sources are done (one downloaded in the last 10 minutes is not asked again).
  { method: "POST", pattern: /^\/control\/energy-prices\/refresh$/, handler: (deps) => deps.prices.refresh() },
  {
    // For deploy/install.sh, update-image.sh and models.sh: answers at once (no registry or hostd call). A video job
    // is no update, but a gateway restart loses its hold on the AI server.
    method: "GET",
    pattern: /^\/control\/updates\/running$/,
    handler: (deps) => {
      const agent = deps.updater.job()?.finishedAt === null;
      const engine = deps.engine.running;
      const apps = deps.apps.running;
      return { running: agent || engine || apps, agent, engine, apps, video: deps.videoJobs.running > 0 };
    },
  },
  { method: "GET", pattern: /^\/control\/agents\/versions$/, handler: (deps, req) => deps.updater.overview({ refresh: query(req).get("refresh") === "1" }) },
  { method: "POST", pattern: /^\/control\/agents\/update\/cancel$/, handler: (deps) => ({ cancelled: deps.updater.cancel() }) },
  {
    method: "POST",
    pattern: /^\/control\/agents\/([^/]+)\/update$/,
    handler: async (deps, req, [agent]) => {
      const body = updateBody(agentOf(decodeParam(agent)), await jsonBody(req));
      if (body.actorUserId !== null) requireUser(deps.db, body.actorUserId, "actorUserId");
      return deps.updater.startUpdate(body);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/control\/agents\/([^/]+)\/images\/([^/]+)$/,
    handler: async (deps, _req, [agent, version]) => {
      await deps.updater.removeImage(agentOf(decodeParam(agent)), decodeParam(version));
      return { ok: true };
    },
  },
  { method: "GET", pattern: /^\/control\/engine$/, handler: (deps, req) => deps.engine.overview({ refresh: query(req).get("refresh") === "1" }) },
  {
    method: "POST",
    pattern: /^\/control\/engine\/update$/,
    handler: async (deps, req) => {
      const { version, actorUserId } = await jsonBody(req);
      if (typeof version !== "string" || version.length > 64) throw invalidVersion();
      const actor = actorParam(actorUserId);
      if (actor !== null) requireUser(deps.db, actor, "actorUserId");
      return deps.engine.startUpdate({ version, actorUserId: actor });
    },
  },
  { method: "POST", pattern: /^\/control\/engine\/cancel$/, handler: async (deps) => ({ cancelled: await deps.engine.cancel() }) },
  { method: "POST", pattern: /^\/control\/engine\/restart-now$/, handler: (deps) => ({ ok: deps.engine.restartNow() }) },
  {
    method: "DELETE",
    pattern: /^\/control\/engine\/images\/([^/]+)$/,
    handler: async (deps, _req, [digest]) => {
      await deps.engine.removeImage(decodeParam(digest));
      return { ok: true };
    },
  },
  { method: "GET", pattern: /^\/control\/apps$/, handler: (deps, req) => deps.apps.overview({ refresh: query(req).get("refresh") === "1" }) },
  { method: "POST", pattern: /^\/control\/apps\/cancel$/, handler: async (deps) => ({ cancelled: await deps.apps.cancel() }) },
  { method: "POST", pattern: /^\/control\/apps\/restart-now$/, handler: (deps) => ({ ok: deps.apps.restartNow() }) },
  {
    method: "POST",
    pattern: /^\/control\/apps\/([^/]+)\/update$/,
    handler: async (deps, req, [app]) => {
      const { version, actorUserId } = await jsonBody(req);
      if (typeof version !== "string" || version.length > 64) throw new HttpError(400, "invalid_version", "version is required.");
      const actor = actorParam(actorUserId);
      if (actor !== null) requireUser(deps.db, actor, "actorUserId");
      return deps.apps.startUpdate({ app: decodeParam(app), version, actorUserId: actor });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/control\/apps\/([^/]+)\/versions\/([^/]+)$/,
    handler: async (deps, _req, [app, version]) => {
      await deps.apps.removeVersion(decodeParam(app), decodeParam(version));
      return { ok: true };
    },
  },
  { method: "GET", pattern: /^\/control\/workspaces$/, handler: (deps) => ({ workspaces: deps.manager.list() }) },
  { method: "GET", pattern: /^\/control\/workspaces\/([^/]+)$/, handler: (deps, _req, [id]) => deps.manager.info(userIdParam(id)) },
  { method: "GET", pattern: /^\/control\/workspaces\/([^/]+)\/servers$/, handler: (deps, _req, [id]) => deps.manager.servers(userIdParam(id)) },
  {
    method: "POST",
    pattern: /^\/control\/workspaces\/([^/]+)\/start$/,
    handler: async (deps, req, [id]) => {
      const userId = userIdParam(id);
      const { agent, kind } = await jsonBody(req);
      // Without an agent the user's own (chosen on Home) starts, without a kind Private; while one of the user's
      // workspaces runs, what is left out is that one's (WorkspaceManager.requestStart). null counts as absent.
      const options = { agent: agent == null ? undefined : agentOf(agent), kind: kind == null ? undefined : kindOf(kind) };
      requireUser(deps.db, userId, "userId");
      return deps.manager.start(userId, options);
    },
  },
  {
    method: "POST",
    pattern: /^\/control\/workspaces\/([^/]+)\/stop$/,
    handler: async (deps, req, [id]) => {
      const userId = userIdParam(id);
      const { reason, actorUserId } = await jsonBody(req);
      const why: StopReason = reason === undefined ? "admin" : oneOf("reason", "invalid_reason", STOP_REASONS, reason);
      const actor = actorParam(actorUserId);
      if (actor !== null) requireUser(deps.db, actor, "actorUserId");
      deps.sessions.invalidateUser(userId);
      return deps.manager.stop(userId, why, actor);
    },
  },
  { method: "POST", pattern: /^\/control\/workspaces\/([^/]+)\/attach$/, handler: (deps, _req, [id]) => deps.manager.attach(userIdParam(id)) },
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
    // Admin's "Erase files…": one workspace's home and workspace folders, left empty.
    method: "DELETE",
    pattern: /^\/control\/workspaces\/([^/]+)\/files$/,
    handler: async (deps, req, [id]) => {
      const userId = userIdParam(id);
      const params = query(req);
      const kind = kindOf(params.get("kind"));
      const agent = agentOf(params.get("agent"));
      const actor = actorParam((await jsonBody(req)).actorUserId);
      requireUser(deps.db, userId, "userId");
      if (actor !== null) requireUser(deps.db, actor, "actorUserId");
      await deps.manager.eraseFiles(userId, { agent, kind }, actor);
      return { ok: true };
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
  // No request timeout, as in createStreamingServer: an API key's request waits for its turn with its body unread,
  // for longer than Node's five minutes.
  return http.createServer({ requestTimeout: 0, headersTimeout: 60_000 }, (req, res) => {
    const served = isLlmApi(splitTarget(req.url ?? "").pathname) ? serveLlmApi(deps, req, res) : handle(deps, expected, req, res);
    served.catch((error: unknown) => {
      if (res.headersSent) return void res.destroy();
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

const query = (req: IncomingMessage): URLSearchParams => new URLSearchParams(splitTarget(req.url ?? "").search);

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

/** `value` when it is one of `values`; else a 400 with `code`. */
function oneOf<T extends string>(field: string, code: string, values: readonly T[], value: unknown): T {
  if (!values.includes(value as T)) throw new HttpError(400, code, `${field} must be one of ${values.map((known) => `"${known}"`).join(", ")}.`);
  return value as T;
}
const agentOf = (value: unknown): AgentKind => oneOf("agent", "unknown_agent", AGENT_KINDS, value);
const kindOf = (value: unknown): WorkspaceKind => oneOf("kind", "unknown_kind", WORKSPACE_KINDS, value);

/** The request's JSON object; no body is an empty one. */
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "bad_request", "The body must be a JSON object.");
  return body as Record<string, unknown>;
}

/** An AgentUpdateRequest, checked. */
function updateBody(agent: AgentKind, { version, rebuild, actorUserId }: Record<string, unknown>): UpdateRequest {
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
