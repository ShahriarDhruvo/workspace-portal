// A whole gateway in one process for the integration tests: main.ts's own parts (compose.ts) over a real
// database, with a FakeRuntime whose "containers" are fake agent servers (`qwen serve`, `dsh web`), a fake
// image builder, npm registry, engine host and LLM server, a stub search backend and an injectable clock.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import {
  AGENT_KINDS,
  agentBrowserToken,
  auditLog,
  generateSessionToken,
  hashSessionToken,
  openDatabase,
  sessions,
  users,
  WORKSPACE_KINDS,
  workspaces,
  type AgentKind,
  type PortalDb,
  type WorkspaceInfo,
  type WorkspaceKind,
} from "@portal/core";
import { compose, type Seams } from "../src/compose.ts";
import { AgentVersions } from "../src/updates/agent-versions.ts";
import { loadConfig, PREVIEW_PORT_OFFSET, type Config } from "../src/config.ts";
import type { FenceState } from "../src/workspaces/fence.ts";
import { BEARER_SUBPROTOCOL_PREFIX } from "../src/proxy/headers.ts";
import type { FinishedLlmRequest } from "../src/monitor/llm-requests.ts";
import { createLogger, type Logger } from "../src/lib/log.ts";
import type { ReaderBackend } from "../src/service/reader.ts";
import type { SearchBackend, SearchQuery } from "../src/service/search-mcp.ts";
import type { FetchText } from "../src/monitor/energy-prices.ts";
import {
  closeServer,
  FakeEngineHost,
  FakeEngineRegistry,
  FakeImageBuilder,
  FakeNotes,
  FakeRegistry,
  FakeRuntime,
  listenLocal,
  LLM_KEY,
  startFakeLlm,
  type FakeUpstream,
} from "./fakes.ts";

export const MIN = 60_000;
export const CONTROL_SECRET = "control-secret-for-tests-0123456789";
/** Workspace ports base+1 … base+PORT_COUNT-1 of each kind: users 1-9. */
const PORT_COUNT = 10;
/** The admin's system-defaults.json every test gateway starts with: models come only from there. */
export const SYSTEM_DEFAULTS = { modelProviders: { openai: [{ id: "qwen3.8-flash-next", name: "Qwen3.8 Flash-Next" }] } };
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
  /** Source address, e.g. a fake workspace container's 127.0.0.N (Private) or 127.0.1.N (Online). */
  localAddress?: string;
}

/** Which of a user's workspaces a request goes to: its kind's port, token and origin (default Private). */
export interface KindOption {
  kind?: WorkspaceKind;
}

export function request(port: number, options: RequestOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: options.headers,
        localAddress: options.localAddress,
        agent: false,
      },
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

export const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site", accept: "text/html" };
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

export interface SocketOptions extends KindOption {
  path?: string;
  /** Subprotocols to offer; default `qwen-ws` plus the session's bearer subprotocol. */
  protocols?: string[];
  headers?: Record<string, string>;
}

/** The host firewall's fence as the manager sees it (fence.ts): what `state` says, "loaded" unless a test changes it. */
export interface FakeFence {
  state: FenceState;
  /** How often the manager asked. */
  checks: number;
  check: () => Promise<FenceState>;
}

export interface GatewayOptions {
  env?: NodeJS.ProcessEnv;
  /** The fence at gateway start; "loaded" by default. */
  fence?: FenceState;
  readyAfterMs?: number;
  /** Written to PORTAL_DATA_DIR/config/agent-versions.env before the gateway starts. */
  agentVersionsFile?: string;
  /** A page reader for the read_page tool (none by default, as without READER_URL). */
  reader?: ReaderBackend;
  /** The search backend; by default a stub that answers "results for <query>". */
  search?: SearchBackend;
  /** The LLM server's portal-hostd; null = not set up. By default a fake engine at 0.31.0 that ends each job at the next status call. */
  engineHost?: FakeEngineHost | null;
  /** What the electricity price sources answer (by URL); by default every download fails ("offline"). */
  priceSource?: FetchText;
}

type Parts = ReturnType<typeof compose>;

export interface Gateway {
  dataDir: string;
  config: Config;
  db: PortalDb;
  runtime: FakeRuntime;
  /** The current agent versions (what starts use). */
  versions: AgentVersions;
  builder: FakeImageBuilder;
  registry: FakeRegistry;
  updater: Parts["updater"];
  llmQueue: Parts["llm"];
  llmRequests: Parts["requests"];
  /** The requests that reached the LLM server and ended, newest first. */
  finishedRequests: FinishedLlmRequest[];
  sessionLog: Parts["sessionLog"];
  engineHost: FakeEngineHost | null;
  engine: Parts["engine"];
  live: Parts["live"];
  connections: Parts["connections"];
  sessionCache: Parts["sessions"];
  manager: Parts["manager"];
  fence: FakeFence;
  clock: { now: number };
  /** The user `ports.service` attributes requests to (stands in for the source-address lookup). */
  caller: { userId: number | null };
  /** Queries the stub search backend received. */
  searches: SearchQuery[];
  ids: Record<UserName, number>;
  /** One portal session (cookie token) per user. */
  tokens: Record<UserName, string>;
  /**
   * `service`: a Private service listener that takes `caller` for the caller. `services`: one listener per kind
   * that, like main.ts's, knows a caller only by the source address of a container of its own kind.
   */
  ports: { control: number; service: number; services: Record<WorkspaceKind, number> };
  llm: FakeUpstream;
  logs: string[];
  log: Logger;
  createAgentServer: () => http.Server;
  createServiceServer: Parts["createServiceServer"];

  agentPort(userId: number, kind?: WorkspaceKind): number;
  agentOrigin(userId: number, kind?: WorkspaceKind): string;
  /** The port the web apps of this workspace are previewed on (preview-proxy.ts). */
  previewPort(userId: number, kind?: WorkspaceKind): number;
  /** The token the browser of this session must present to this workspace. */
  browserToken(sessionToken: string, userId: number, kind?: WorkspaceKind): string;
  addSession(userId: number, actingAsUserId?: number | null): string;
  /** Points an admin session at another user's workspace (null: back to their own). */
  actAs(sessionToken: string, userId: number | null): void;
  /** A restarted gateway over the same database and containers (with `config`, when it changed): its manager. */
  restart(config?: Config): Promise<Parts["manager"]>;

  navigate(token: string | null, userId: number, pathname?: string, headers?: Record<string, string>, kind?: WorkspaceKind): Promise<Reply>;
  /**
   * fetch/XHR from the Web Shell. `bearer`: the browser token to send (default: this session's
   * token for this workspace); null sends no Authorization header.
   */
  xhr(token: string | null, userId: number, options?: RequestOptions & KindOption & { bearer?: string | null }): Promise<Reply>;
  openSocket(token: string | null, userId: number, options?: SocketOptions): Promise<WsOutcome>;
  control(method: string, pathname: string, body?: unknown, secret?: string): Promise<Reply>;

  info(userId: number): WorkspaceInfo;
  waitReady(userId: number): Promise<WorkspaceInfo>;
  /** Starts a workspace through the manager (default: the manager's choice of agent, Private) and waits until it is ready. */
  startReady(userId: number, agent?: AgentKind, kind?: WorkspaceKind): Promise<WorkspaceInfo>;
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
    // A Qwen-only install unless a test enables both (a start without a choice then starts Qwen Code).
    WORKSPACE_AGENTS: "qwen",
    ...options.env,
  });
  const db = openDatabase(config.dbFile);
  const clock = { now: Date.now() };
  fs.mkdirSync(config.qwenConfigDir, { recursive: true });
  fs.writeFileSync(path.join(config.qwenConfigDir, "system-defaults.json"), JSON.stringify(SYSTEM_DEFAULTS));

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
  const log = createLogger((line) => logs.push(line));
  const caller: Gateway["caller"] = { userId: null };
  const searches: SearchQuery[] = [];
  const search: SearchBackend = {
    async search(query, signal) {
      searches.push(query);
      return options.search ? options.search.search(query, signal) : `results for ${query.query}`;
    },
  };
  const runtime = new FakeRuntime(dataDir);
  runtime.readyAfterMs = options.readyAfterMs ?? 0;
  if (options.agentVersionsFile !== undefined) {
    fs.mkdirSync(path.dirname(config.agentVersionsFile), { recursive: true });
    fs.writeFileSync(config.agentVersionsFile, options.agentVersionsFile);
  }
  const builder = new FakeImageBuilder(runtime);
  const registry = new FakeRegistry();
  const finishedRequests: FinishedLlmRequest[] = [];
  const fence: FakeFence = {
    state: options.fence ?? "loaded",
    checks: 0,
    check: () => {
      fence.checks++;
      return Promise.resolve(fence.state);
    },
  };
  const engineHost = options.engineHost === undefined ? new FakeEngineHost() : options.engineHost;
  const engineRegistry = new FakeEngineRegistry();
  const seams: Seams = {
    now: () => clock.now,
    fence: fence.check,
    builder,
    registry,
    engineHost,
    engineRegistry,
    engineNotes: new FakeNotes(),
    enginePollMs: 5,
    search,
    reader: options.reader,
    // The tests that need prices give `priceSource` (offline otherwise).
    fetchText: options.priceSource ?? (() => Promise.reject(new Error("offline"))),
    onLlmFinished: (request) => finishedRequests.unshift(request),
  };
  let servers: http.Server[] = [];
  /** Starts a gateway as main.ts does, minus what it runs in the background; returns what a restart replaces in `Gateway`. */
  const boot = async (config: Config) => {
    const versions = AgentVersions.fromConfig(config, log);
    const { llm: llmQueue, requests: llmRequests, sessions: sessionCache, manager, sessionLog, updater, engine, live, connections, createAgentServer, ...parts } = compose(
      { config, db, runtime, versions, log },
      seams,
    );
    await manager.init();
    sessionLog.reconcile(manager.list());
    const services = [parts.createServiceServer({ kind: "private", resolveCaller: () => caller.userId }), ...WORKSPACE_KINDS.map((kind) => parts.createServiceServer({ kind }))];
    const [control, service, privateService, onlineService] = await Promise.all([parts.control, ...services].map((server) => listenLocal(server)));
    servers = [parts.control, ...services, ...(await listenAgentPorts(config, createAgentServer, parts.createPreviewServer))];
    const ports = { control: control!, service: service!, services: { private: privateService!, online: onlineService! } };
    return { config, versions, updater, llmQueue, llmRequests, sessionLog, engine, live, connections, sessionCache, manager, ports, createAgentServer, createServiceServer: parts.createServiceServer };
  };
  const started = await boot(config);
  // deploy/install.sh built the current version of each agent.
  for (const kind of AGENT_KINDS) builder.install(kind, started.versions.current(kind));

  const sockets: WebSocket[] = [];
  const agentPort = (userId: number, kind: WorkspaceKind = "private"): number => config.workspace.kinds[kind].agentPortBase + userId;
  const agentOrigin = (userId: number, kind: WorkspaceKind = "private"): string => `http://127.0.0.1:${agentPort(userId, kind)}`;
  const previewPort = (userId: number, kind: WorkspaceKind = "private"): number => agentPort(userId, kind) + PREVIEW_PORT_OFFSET;
  const browserToken = (sessionToken: string, userId: number, kind: WorkspaceKind = "private"): string =>
    agentBrowserToken(CONTROL_SECRET, hashSessionToken(sessionToken), userId, kind);
  const info = (userId: number): WorkspaceInfo => g.manager.info(userId);
  const waitReady = (userId: number): Promise<WorkspaceInfo> =>
    waitFor(() => (info(userId).status === "running" && info(userId).ready ? info(userId) : null), `workspace ${userId} ready`);

  const g: Gateway = {
    ...started,
    dataDir,
    db,
    runtime,
    builder,
    registry,
    finishedRequests,
    engineHost,
    fence,
    clock,
    caller,
    searches,
    ids,
    tokens,
    llm,
    logs,
    log,
    agentPort,
    agentOrigin,
    previewPort,
    browserToken,
    addSession,
    actAs(sessionToken, userId) {
      const id = hashSessionToken(sessionToken);
      db.update(sessions).set({ actingAsUserId: userId }).where(eq(sessions.id, id)).run();
      g.sessionCache.invalidateSession(id);
    },
    async restart(config = g.config) {
      g.manager.shutdown();
      await Promise.all(servers.map(closeServer));
      Object.assign(g, await boot(config));
      return g.manager;
    },

    navigate(token, userId, pathname = "/", headers = {}, kind = "private") {
      const all: Record<string, string> = { ...NAVIGATE, ...headers };
      if (token) all.cookie = cookie(token);
      return request(agentPort(userId, kind), { path: pathname, headers: all });
    },
    xhr(token, userId, options = {}) {
      const { kind = "private", bearer: given, ...rest } = options;
      const method = rest.method ?? "GET";
      const headers: Record<string, string> = { "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", accept: "application/json" };
      if (method !== "GET" && method !== "HEAD") headers.origin = agentOrigin(userId, kind);
      if (token) headers.cookie = cookie(token);
      const bearer = given === undefined ? (token ? browserToken(token, userId, kind) : null) : given;
      if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
      return request(agentPort(userId, kind), { ...rest, method, headers: { ...headers, ...rest.headers } });
    },
    openSocket(token, userId, socketOptions = {}) {
      return new Promise((resolve, reject) => {
        const kind = socketOptions.kind ?? "private";
        const headers: Record<string, string> = { origin: agentOrigin(userId, kind), ...socketOptions.headers };
        if (token) headers.cookie = cookie(token);
        const protocols = socketOptions.protocols ?? ["qwen-ws", ...(token ? [bearerSubprotocol(browserToken(token, userId, kind))] : [])];
        const socket = new WebSocket(`ws://127.0.0.1:${agentPort(userId, kind)}${socketOptions.path ?? "/terminal"}`, protocols, { headers });
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
      const payload = body === undefined ? undefined : JSON.stringify(body);
      // Node's client frames no body of a DELETE by itself; the web app's fetch sends the length.
      if (payload !== undefined) Object.assign(headers, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
      return request(g.ports.control, { method, path: pathname, headers, body: payload });
    },

    info,
    waitReady,
    async startReady(userId, agent, kind) {
      await g.manager.start(userId, { ...(agent ? { agent } : {}), ...(kind ? { kind } : {}) });
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
      g.updater.shutdown();
      await g.updater.settled();
      g.engine.shutdown();
      g.live.close();
      g.manager.shutdown();
      await Promise.all(Object.values(ids).map((userId) => g.manager.stop(userId, "test_end")));
      for (const id of [...runtime.containers.keys()]) await runtime.removeContainer(id);
      await Promise.all([...servers.map(closeServer), llm.close()]);
      db.$client.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return g;
}

/** Both agents enabled. */
export const BOTH = { env: { WORKSPACE_AGENTS: "qwen,dsh" } } satisfies GatewayOptions;

/** A gateway for `run`, closed after it. */
export async function withGateway(options: GatewayOptions, run: (gateway: Gateway) => Promise<void>): Promise<void> {
  const gateway = await startGateway(options);
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
}

/** One message, or a batch, to the web tools of the shared service listener. */
export const mcp = (gateway: Gateway, body: unknown): Promise<Reply> =>
  request(gateway.ports.service, { method: "POST", path: "/mcp/search", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });

export const logged = (gateway: Gateway, msg: string): boolean => gateway.logs.some((line) => (JSON.parse(line) as { msg: string }).msg === msg);

/** Below Linux's ephemeral port range, so the servers on port 0 rarely get in the way. */
function randomBase(): number {
  return 20_000 + Math.floor(Math.random() * 10_000);
}

/** One agent and one preview server per workspace of each kind, like main.ts; moves the ranges if a port is taken. */
async function listenAgentPorts(config: Config, create: () => http.Server, createPreview: () => http.Server): Promise<http.Server[]> {
  const { kinds } = config.workspace;
  for (let attempt = 0; ; attempt++) {
    const servers: http.Server[] = [];
    try {
      for (const kind of WORKSPACE_KINDS) {
        for (let userId = 1; userId < config.agentPortCount; userId++) {
          const server = create();
          servers.push(server);
          await listenLocal(server, kinds[kind].agentPortBase + userId);
          const preview = createPreview();
          servers.push(preview);
          await listenLocal(preview, kinds[kind].agentPortBase + userId + PREVIEW_PORT_OFFSET);
        }
      }
      return servers;
    } catch (error) {
      await Promise.all(servers.map(closeServer));
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 20) throw error;
      kinds.private.agentPortBase = randomBase();
      kinds.online.agentPortBase = kinds.private.agentPortBase + config.agentPortCount;
    }
  }
}
