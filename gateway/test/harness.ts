// A whole gateway in one process for the integration tests: a real database, the real agent,
// control and service servers (one agent server per workspace port), a FakeRuntime whose
// "containers" are fake `qwen serve` processes, a fake LLM server, a stub search backend and an
// injectable clock.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import {
  agentBrowserToken,
  auditLog,
  generateSessionToken,
  hashSessionToken,
  loadSessionContext,
  openDatabase,
  sessions,
  users,
  workspaces,
  type PortalDb,
} from "@portal/db";
import type { AgentDeps } from "../src/agent-access.ts";
import { createAgentServerFactory } from "../src/agent-proxy.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { ConnectionRegistry } from "../src/connections.ts";
import { createControlServer, type ControlDeps } from "../src/control-api.ts";
import { BEARER_SUBPROTOCOL_PREFIX } from "../src/headers.ts";
import { LlmQueue } from "../src/llm-queue.ts";
import type { Logger } from "../src/log.ts";
import type { SearchBackend, SearchQuery } from "../src/search-mcp.ts";
import { createServiceServer, type ServiceDeps } from "../src/service-api.ts";
import { SessionCache } from "../src/session-cache.ts";
import { WorkspaceManager, type WorkspaceInfo } from "../src/workspaces.ts";
import { closeServer, FakeRuntime, listenLocal, LLM_KEY, startFakeLlm, type FakeUpstream } from "./fakes.ts";

export const MIN = 60_000;
export const CONTROL_SECRET = "control-secret-for-tests-0123456789";
/** Workspace ports base+1 … base+PORT_COUNT-1: users 1-9. */
const PORT_COUNT = 10;
const DAY = 24 * 60 * MIN;

export type UserName = "alice" | "bob" | "carol" | "dave" | "admin";
const USER_NAMES: readonly UserName[] = ["alice", "bob", "carol", "dave", "admin"];

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface RequestOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export function request(port: number, options: RequestOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path ?? "/", headers: options.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

export function json<T = unknown>(reply: Reply): T {
  return JSON.parse(reply.body) as T;
}

export async function waitFor<T>(probe: () => T | undefined | null | false, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const cookie = (token: string): string => `theme=dark; portal_session=${encodeURIComponent(token)}`;
export const bearerSubprotocol = (token: string): string => `${BEARER_SUBPROTOCOL_PREFIX}${Buffer.from(token).toString("base64url")}`;

export interface Message {
  data: Buffer;
  binary: boolean;
}

/** An open agent socket whose messages are queued from the start, so none can be missed. */
export interface AgentSocket {
  socket: WebSocket;
  next(): Promise<Message>;
}

export type WsOutcome = AgentSocket | { status: number };

export function closed(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(-1);
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

export interface SocketOptions {
  path?: string;
  /** Subprotocols to offer; default `qwen-ws` plus the session's bearer subprotocol. */
  protocols?: string[];
  headers?: Record<string, string>;
}

export interface GatewayOptions {
  env?: NodeJS.ProcessEnv;
  readyAfterMs?: number;
}

export interface Gateway {
  dataDir: string;
  config: Config;
  db: PortalDb;
  runtime: FakeRuntime;
  llmQueue: LlmQueue;
  connections: ConnectionRegistry;
  sessionCache: SessionCache;
  manager: WorkspaceManager;
  clock: { now: number };
  /** The user the service API attributes requests to (stands in for the source-address lookup). */
  caller: { userId: number | null };
  /** Queries the stub search backend received. */
  searches: SearchQuery[];
  ids: Record<UserName, number>;
  /** One portal session (cookie token) per user. */
  tokens: Record<UserName, string>;
  ports: { control: number; service: number };
  llm: FakeUpstream;
  logs: string[];
  log: Logger;
  createAgentServer: () => http.Server;

  agentPort(userId: number): number;
  agentOrigin(userId: number): string;
  /** The token the browser of this session must present to this workspace. */
  browserToken(sessionToken: string, userId: number): string;
  addSession(userId: number, actingAsUserId?: number | null): string;
  /** Points an admin session at another user's workspace (null: back to their own). */
  actAs(sessionToken: string, userId: number | null): void;
  /** Makes the agent, control and service servers use another manager (a "restarted" gateway). */
  useManager(manager: WorkspaceManager): void;

  navigate(token: string | null, userId: number, pathname?: string, headers?: Record<string, string>): Promise<Reply>;
  /**
   * fetch/XHR from the Web Shell. `bearer`: the browser token to send (default: this session's
   * token for this workspace); null sends no Authorization header.
   */
  xhr(token: string | null, userId: number, options?: RequestOptions & { bearer?: string | null }): Promise<Reply>;
  openSocket(token: string | null, userId: number, options?: SocketOptions): Promise<WsOutcome>;
  control(method: string, pathname: string, body?: unknown, secret?: string): Promise<Reply>;

  info(userId: number): WorkspaceInfo;
  waitReady(userId: number): Promise<WorkspaceInfo>;
  /** Starts a workspace through the manager and waits until it is ready. */
  startReady(userId: number): Promise<WorkspaceInfo>;
  auditActions(userId: number): Array<{ action: string; details: unknown; actorUserId: number | null }>;
  workspaceRow(userId: number): typeof workspaces.$inferSelect | undefined;
  errors(): string[];
  close(): Promise<void>;
}

export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-it-"));
  const llm = await startFakeLlm();
  const config = loadConfig({
    PORTAL_DATA_DIR: dataDir,
    GATEWAY_CONTROL_SECRET: CONTROL_SECRET,
    LLM_UPSTREAM_URL: `http://127.0.0.1:${llm.port}`,
    LLM_API_KEY: LLM_KEY,
    LLM_MAX_CONCURRENCY: "2",
    LLM_MAX_CONCURRENCY_PER_USER: "1",
    MAX_RUNNING_WORKSPACES: "2",
    IDLE_TIMEOUT_MINUTES: "30",
    UPLOAD_LIMIT_MB: "1",
    AGENT_PORT_BASE: String(randomBase()),
    AGENT_PORT_COUNT: String(PORT_COUNT),
    ...options.env,
  });
  const db = openDatabase(config.dbFile);
  const clock = { now: Date.now() };

  const addUser = (username: string, role: "admin" | "user"): number => {
    const now = Date.now();
    return db
      .insert(users)
      .values({ username, firstName: username, lastName: "Test", passwordHash: "x", role, createdAt: now, updatedAt: now })
      .returning()
      .get().id;
  };
  const addSession = (userId: number, actingAsUserId: number | null = null): string => {
    const token = generateSessionToken();
    const now = Date.now();
    // Long-lived, so that moving the test clock forward never expires a session by accident.
    db.insert(sessions)
      .values({ id: hashSessionToken(token), userId, actingAsUserId, createdAt: now, lastSeenAt: now, expiresAt: now + 365 * DAY })
      .run();
    return token;
  };
  const ids = {} as Record<UserName, number>;
  const tokens = {} as Record<UserName, string>;
  for (const name of USER_NAMES) ids[name] = addUser(name, name === "admin" ? "admin" : "user");
  for (const name of USER_NAMES) tokens[name] = addSession(ids[name]);
  if (Math.max(...Object.values(ids)) >= PORT_COUNT) throw new Error("more users than workspace ports");

  const logs: string[] = [];
  const log: Logger = {
    info: (msg, fields) => logs.push(JSON.stringify({ level: "info", msg, ...fields })),
    warn: (msg, fields) => logs.push(JSON.stringify({ level: "warn", msg, ...fields })),
    error: (msg, fields) => logs.push(JSON.stringify({ level: "error", msg, ...fields })),
  };
  const caller: Gateway["caller"] = { userId: null };
  const searches: SearchQuery[] = [];
  const search: SearchBackend = {
    async search(query) {
      searches.push(query);
      return `results for ${query.query}`;
    },
  };
  const runtime = new FakeRuntime(dataDir);
  runtime.readyAfterMs = options.readyAfterMs ?? 0;
  const llmQueue = new LlmQueue(config.llm.maxConcurrency, config.llm.maxConcurrencyPerUser);
  const connections = new ConnectionRegistry(() => clock.now);
  const sessionCache = new SessionCache((hash) => loadSessionContext(db, hash));
  let manager = new WorkspaceManager({ config, db, runtime, llm: llmQueue, connections, log, now: () => clock.now });
  await manager.init();

  const agentDeps: AgentDeps = { config, manager, sessions: sessionCache, connections, log };
  const controlDeps: ControlDeps = { config, db, manager, llm: llmQueue, sessions: sessionCache, connections, log };
  const serviceDeps: ServiceDeps = { config, db, manager, llm: llmQueue, log, search, resolveCaller: () => caller.userId };
  const createAgentServer = createAgentServerFactory(agentDeps);
  const control = createControlServer(controlDeps);
  const service = createServiceServer(serviceDeps);
  const servers: http.Server[] = [control, service];
  const [controlPort, servicePort] = await Promise.all([listenLocal(control), listenLocal(service)]);
  servers.push(...(await listenAgentPorts(config, createAgentServer)));

  const sockets: WebSocket[] = [];
  const agentPort = (userId: number): number => config.agentPortBase + userId;
  const agentOrigin = (userId: number): string => `http://127.0.0.1:${agentPort(userId)}`;
  const browserToken = (sessionToken: string, userId: number): string => agentBrowserToken(CONTROL_SECRET, hashSessionToken(sessionToken), userId);
  const info = (userId: number): WorkspaceInfo => manager.info(userId);
  const waitReady = (userId: number): Promise<WorkspaceInfo> =>
    waitFor(() => (info(userId).status === "running" && info(userId).ready ? info(userId) : null), `workspace ${userId} ready`);

  const g: Gateway = {
    dataDir,
    config,
    db,
    runtime,
    llmQueue,
    connections,
    sessionCache,
    get manager() {
      return manager;
    },
    clock,
    caller,
    searches,
    ids,
    tokens,
    ports: { control: controlPort!, service: servicePort! },
    llm,
    logs,
    log,
    createAgentServer,
    agentPort,
    agentOrigin,
    browserToken,
    addSession,
    actAs(sessionToken, userId) {
      const id = hashSessionToken(sessionToken);
      db.update(sessions).set({ actingAsUserId: userId }).where(eq(sessions.id, id)).run();
      sessionCache.invalidateSession(id);
    },
    useManager(next) {
      manager = next;
      agentDeps.manager = next;
      controlDeps.manager = next;
      serviceDeps.manager = next;
    },

    navigate(token, userId, pathname = "/", headers = {}) {
      const all: Record<string, string> = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site", accept: "text/html", ...headers };
      if (token) all.cookie = cookie(token);
      return request(agentPort(userId), { path: pathname, headers: all });
    },
    xhr(token, userId, options = {}) {
      const method = options.method ?? "GET";
      const headers: Record<string, string> = { "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", accept: "application/json" };
      if (method !== "GET" && method !== "HEAD") headers.origin = agentOrigin(userId);
      if (token) headers.cookie = cookie(token);
      const bearer = options.bearer === undefined ? (token ? browserToken(token, userId) : null) : options.bearer;
      if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
      return request(agentPort(userId), { ...options, method, headers: { ...headers, ...options.headers } });
    },
    openSocket(token, userId, socketOptions = {}) {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { origin: agentOrigin(userId), ...socketOptions.headers };
        if (token) headers.cookie = cookie(token);
        const protocols = socketOptions.protocols ?? ["qwen-ws", ...(token ? [bearerSubprotocol(browserToken(token, userId))] : [])];
        const socket = new WebSocket(`ws://127.0.0.1:${agentPort(userId)}${socketOptions.path ?? "/terminal"}`, protocols, { headers });
        const queued: Message[] = [];
        const waiting: Array<(message: Message) => void> = [];
        socket.on("message", (data, binary) => {
          const message = { data: data as Buffer, binary };
          const waiter = waiting.shift();
          if (waiter) waiter(message);
          else queued.push(message);
        });
        const next = (): Promise<Message> => {
          const message = queued.shift();
          return message ? Promise.resolve(message) : new Promise((resolveMessage) => waiting.push(resolveMessage));
        };
        socket.once("open", () => {
          sockets.push(socket);
          resolve({ socket, next });
        });
        socket.once("unexpected-response", (_req, res) => {
          res.resume();
          resolve({ status: res.statusCode! });
          socket.terminate();
        });
        socket.once("error", (error) => {
          if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) reject(error);
        });
      });
    },
    control(method, pathname, body, secret = CONTROL_SECRET) {
      const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      return request(controlPort!, { method, path: pathname, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    },

    info,
    waitReady,
    async startReady(userId) {
      await manager.start(userId);
      return waitReady(userId);
    },
    auditActions(userId) {
      return db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetUserId, userId))
        .all()
        .map((row) => ({ action: row.action, details: row.details ? JSON.parse(row.details) : null, actorUserId: row.actorUserId }));
    },
    workspaceRow(userId) {
      return db.select().from(workspaces).where(eq(workspaces.userId, userId)).get();
    },
    errors() {
      return logs.map((line) => JSON.parse(line) as { level: string; msg: string }).filter((entry) => entry.level === "error").map((entry) => entry.msg);
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      manager.shutdown();
      await Promise.all(Object.values(ids).map((userId) => manager.stop(userId, "test_end")));
      for (const id of [...runtime.containers.keys()]) await runtime.removeContainer(id);
      await Promise.all([...servers.map(closeServer), llm.close()]);
      db.$client.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return g;
}

/** Below Linux's ephemeral port range, so the servers on port 0 rarely get in the way. */
function randomBase(): number {
  return 20_000 + Math.floor(Math.random() * 10_000);
}

/** One agent server per workspace port, like main.ts; moves the range if a port is taken. */
async function listenAgentPorts(config: Config, create: () => http.Server): Promise<http.Server[]> {
  for (let attempt = 0; ; attempt++) {
    const servers: http.Server[] = [];
    try {
      for (let userId = 1; userId < config.agentPortCount; userId++) {
        const server = create();
        servers.push(server);
        await listenLocal(server, config.agentPortBase + userId);
      }
      return servers;
    } catch (error) {
      await Promise.all(servers.map(closeServer));
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 20) throw error;
      config.agentPortBase = randomBase();
    }
  }
}
