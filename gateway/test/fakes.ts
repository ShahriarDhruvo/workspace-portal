// In-process stand-ins for Docker, the agents' web servers (Qwen Code's `qwen serve`, DeepSeek
// Harness's `dsh web`) and the LLM server.
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { AgentKind } from "@portal/db";
import type { SettingsObject } from "../src/agents/qwen-settings.ts";
import type { WorkspaceStartOptions } from "../src/container-spec.ts";
import { userPaths } from "../src/paths.ts";
import type { ContainerRuntime, ContainerSample, ContainerState, ContainerSummary, StartedContainer } from "../src/runtime.ts";

export async function listenLocal(server: http.Server, port = 0, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

export async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

// ------------------------------------------------------------------ qwen serve

/** What `GET /health?deep=1` reports; tests change it to simulate the agent working. */
export interface FakeHealth {
  activePrompts: number;
  pendingPermissions: number;
  activeWork: boolean;
  connectedClients: number;
  /** Time since the agent last started or finished something; null before the first session. */
  idleSinceMs: number | null;
  channelAlive: boolean;
}

export interface FakeQwen {
  /** The container's address: each fake workspace listens on its own loopback address. */
  host: string;
  port: number;
  /** The bearer token it was started with (QWEN_SERVER_TOKEN). */
  token: string;
  health: FakeHealth;
  healthChecks: number;
  /** While true, health checks get a 503 (a broken or overloaded `qwen serve`). */
  healthFails: boolean;
  /** Runs when a health check arrives, before it is answered. */
  onHealth: (() => void) | null;
  /** Every request other than health checks, with the status the fake answered. */
  requests: Array<RecordedRequest & { status: number }>;
  /** Bytes received by each upload request, and whether it arrived whole. */
  uploads: Array<{ bytes: number; complete: boolean }>;
  /** Accepted WebSocket handshakes. */
  sockets: RecordedRequest[];
  close(): Promise<void>;
}

/** The Web Shell itself is served without a token; everything else needs it. */
function isPublic(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/assets/") || pathname === "/manifest.webmanifest" || pathname === "/sw.js";
}

/** Why `qwen serve` would refuse this request (status), or null. */
function refuse(req: IncomingMessage, token: string): number | null {
  const { origin, host } = req.headers;
  if (origin !== undefined && origin !== `http://${host}`) return 403;
  if (isPublic(new URL(req.url ?? "/", "http://x").pathname)) return null;
  return req.headers.authorization === `Bearer ${token}` ? null : 401;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

export async function startFakeQwen(token: string, options: { readyAfterMs: number; pingIntervalMs: number; host: string }): Promise<FakeQwen> {
  const readyAt = Date.now() + options.readyAfterMs;
  const state = {
    health: { activePrompts: 0, pendingPermissions: 0, activeWork: false, connectedClients: 0, idleSinceMs: null, channelAlive: true } as FakeHealth,
    healthChecks: 0,
    healthFails: false,
    onHealth: null as (() => void) | null,
  };
  const requests: FakeQwen["requests"] = [];
  const uploads: FakeQwen["uploads"] = [];
  const sockets: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const status = refuse(req, token);
    if (url === "/health?deep=1" && status === null) {
      state.healthChecks++;
      state.onHealth?.();
      if (state.healthFails) return json(res, 503, { error: "Service Unavailable" });
      const { health } = state;
      return json(res, 200, {
        status: "ok",
        workspaceCount: 1,
        sessions: 1,
        pendingPermissions: health.pendingPermissions,
        activePrompts: health.activePrompts,
        activeWork: health.activeWork,
        activeWorkReporting: true,
        activeWorkStaleMs: 0,
        connectedClients: health.connectedClients,
        channelAlive: health.channelAlive && Date.now() >= readyAt,
        lastActivityAt: null,
        idleSinceMs: health.idleSinceMs,
      });
    }
    const record = { method, url, headers: req.headers, status: status ?? 200 };
    requests.push(record);
    if (status !== null) {
      if (status === 401) return json(res, 401, { error: "Unauthorized" });
      return json(res, status, { error: "Forbidden" });
    }
    const { pathname } = new URL(url, "http://x");
    if (method === "GET" && pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": ["qwen-session=1; HttpOnly", "other=2"],
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      });
      res.end("<!doctype html><title>Qwen Code</title>");
    } else if (method === "GET" && pathname === "/assets/app.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=31536000, immutable" }).end("console.log(1)");
    } else if (method === "GET" && pathname === "/api/sessions") {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "tracking=1" }).end('{"sessions":[]}');
    } else if (method === "GET" && /^\/session\/[^/]+\/events$/.test(pathname)) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("event: ready\ndata: 1\n\n");
    } else if (method === "POST" && /^\/session\/[^/]+\/heartbeat$/.test(pathname)) {
      res.writeHead(204).end();
    } else if (method === "POST" && pathname === "/api/echo") {
      res.writeHead(200, { "content-type": req.headers["content-type"] ?? "application/octet-stream" });
      req.pipe(res);
    } else if (method === "POST" && pathname === "/api/upload") {
      const upload = { bytes: 0, complete: false };
      uploads.push(upload);
      req.on("data", (chunk: Buffer) => (upload.bytes += chunk.length));
      req.on("end", () => {
        upload.complete = true;
        json(res, 200, { bytes: upload.bytes });
      });
    } else if (pathname === "/web-shell/pairing" || pathname.startsWith("/web-shell/pairing/")) {
      // What the portal must never let a browser reach: it would hand out the real token.
      json(res, 200, { token });
    } else {
      record.status = 404;
      res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => (offered.has("qwen-ws") ? "qwen-ws" : false),
  });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://x");
    const status = ["/terminal", "/acp", "/live/web"].includes(pathname) ? refuse(req, token) : 404;
    if (status !== null) {
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      ws.send(`hello from qwen ${pathname}`);
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
      const ping = setInterval(() => ws.ping(), options.pingIntervalMs);
      ws.on("close", () => clearInterval(ping));
    });
  });

  const port = await listenLocal(server, 0, options.host);
  return {
    host: options.host,
    port,
    token,
    get health() {
      return state.health;
    },
    set health(value: FakeHealth) {
      state.health = value;
    },
    get healthChecks() {
      return state.healthChecks;
    },
    get healthFails() {
      return state.healthFails;
    },
    set healthFails(value: boolean) {
      state.healthFails = value;
    },
    get onHealth() {
      return state.onHealth;
    },
    set onHealth(value: (() => void) | null) {
      state.onHealth = value;
    },
    requests,
    uploads,
    sockets,
    async close() {
      for (const client of wss.clients) client.terminate();
      await closeServer(server);
    },
  };
}

// ------------------------------------------------------------------ dsh web

export interface FakeDsh {
  host: string;
  port: number;
  /** The browser-session secret it was started with (DSH_COOKIE_SECRET). */
  secret: string;
  /** What `session/list` reports, and `session/state`'s pendingInput; tests change it to simulate the agent working. */
  sessions: Array<{ id: string; running: boolean; pendingInput?: string[] }>;
  /** Background jobs (`job/list` over the mux socket), by owning session. */
  jobs: Array<{ owner: string; status: "running" | "exited" }>;
  /** session/list calls that were answered. */
  listCalls: number;
  /** job/list streams that were answered. */
  jobCalls: number;
  /** While true, the session API answers 503 and job/list streams fail. */
  apiFails: boolean;
  /** Every request other than session/list, with the status the fake answered. */
  requests: Array<RecordedRequest & { status: number }>;
  /** Socket handshakes; `probe` for the gateway's own job checks (no Origin), the rest relayed browsers. */
  sockets: Array<RecordedRequest & { probe: boolean }>;
  close(): Promise<void>;
}

const DSH_AUTHORITY = "localhost:3080";
const dshCookieName = `dsh-auth-${createHash("sha256").update(DSH_AUTHORITY).digest("base64url")}`;

/** Like dsh: a valid, unexpired `v1.<body>.<signature>` cookie for this authority, signed with `secret`. */
function validDshCookie(cookieHeader: string | undefined, secret: string): boolean {
  const pair = (cookieHeader ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${dshCookieName}=`));
  const [version, body, signature] = (pair?.slice(dshCookieName.length + 1) ?? "").split(".");
  if (version !== "v1" || !body || !signature) return false;
  const expected = createHmac("sha256", Buffer.from(secret, "base64url")).update(body).digest("base64url");
  if (signature !== expected) return false;
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { authority?: string; issuedAt?: number; expiresAt?: number };
  const now = Date.now();
  return claims.authority === DSH_AUTHORITY && (claims.issuedAt ?? Infinity) <= now && (claims.expiresAt ?? 0) > now;
}

/** Why dsh would refuse this request (status), or null: loopback Host only, Origin = Host, no cross-site, a valid cookie. */
function refuseDsh(req: IncomingMessage, secret: string): number | null {
  const { host, origin } = req.headers;
  if (host !== DSH_AUTHORITY) return 421;
  if (origin !== undefined && origin !== `http://${host}`) return 403;
  if (req.headers["sec-fetch-site"] === "cross-site") return 403;
  return validDshCookie(req.headers.cookie, secret) ? null : 401;
}

export async function startFakeDsh(secret: string, options: { readyAfterMs: number; pingIntervalMs: number; host: string }): Promise<FakeDsh> {
  const readyAt = Date.now() + options.readyAfterMs;
  const state = { sessions: [] as FakeDsh["sessions"], jobs: [] as FakeDsh["jobs"], listCalls: 0, jobCalls: 0, apiFails: false };
  const requests: FakeDsh["requests"] = [];
  const sockets: FakeDsh["sockets"] = [];

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const { pathname } = new URL(url, "http://x");
    // Like dsh: the port answers 404 everywhere for a moment before its routes exist.
    if (Date.now() < readyAt) return void res.writeHead(404).end();
    const status = refuseDsh(req, secret);
    if ((pathname === "/api/session/list" || pathname === "/api/session/state") && method === "POST" && status === null) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      type Args = { _request?: unknown; request?: { sessionId?: string } };
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { rpcId?: string; method?: string; payload?: { args?: Args } };
      if (state.apiFails) return json(res, 503, { error: "unavailable" });
      const answer = (value: unknown) => json(res, 200, { type: "server-response", rpcId: call.rpcId, result: value === undefined ? { ok: false, error: { code: "gateway/input-invalid" } } : { ok: true, value } });
      const args = call.payload?.args;
      if (call.method !== pathname.slice("/api/".length)) return answer(undefined);
      if (call.method === "session/state") {
        const session = state.sessions.find((s) => s.id === args?.request?.sessionId);
        return answer(session && { running: session.running, active: true, pendingInput: session.pendingInput ?? [], queue: [] });
      }
      if (typeof args?._request !== "object") return answer(undefined);
      state.listCalls++;
      return answer({ items: state.sessions.map((s, index) => ({ sessionId: s.id, running: s.running, updatedAt: 1_000 + index, title: s.id })) });
    }
    const record = { method, url, headers: req.headers, status: status ?? 200 };
    requests.push(record);
    if (status !== null) return json(res, status, { error: http.STATUS_CODES[status] });
    if (method === "GET" && pathname === "/") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": `${dshCookieName}=refreshed; HttpOnly` }).end("<!doctype html><title>DeepSeek Harness</title>");
    } else if (method === "POST" && pathname === "/api/session/create") {
      json(res, 200, { type: "client-response", payload: { id: "s1" } });
    } else if (pathname === "/connect" || pathname.startsWith("/oauth/") || pathname.startsWith("/open-in-app/")) {
      // What the portal must never let a browser reach.
      json(res, 200, { pairing: "would grant access" });
    } else {
      record.status = 404;
      res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://x");
    const status = pathname === "/api/remote.mux" ? refuseDsh(req, secret) : 404;
    if (status !== null) {
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const probe = req.headers.origin === undefined;
      sockets.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, probe });
      if (!probe) ws.send("hello from dsh");
      // The mux protocol for job/list (one `open` per stream, rows as the first item); anything else is echoed.
      ws.on("message", (data, isBinary) => {
        const frame = (() => {
          try {
            return JSON.parse(data.toString()) as { type?: string; streamId?: string; endpoint?: string; payload?: { args?: { request?: { sessionId?: string } } } };
          } catch {
            return null;
          }
        })();
        if (frame?.type === "cancel") return;
        if (frame?.type !== "open" || frame.endpoint !== "job/list") return void ws.send(data, { binary: isBinary });
        const sessionId = frame.payload?.args?.request?.sessionId;
        if (state.apiFails || typeof sessionId !== "string") {
          return void ws.send(JSON.stringify({ type: "error", streamId: frame.streamId, error: { code: "gateway/input-invalid" } }));
        }
        state.jobCalls++;
        const jobs = state.jobs.filter((job) => job.owner === sessionId).map((job, index) => ({ id: `bash-${index}`, kind: "bash", owner: job.owner, status: job.status }));
        ws.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: { type: "rows", jobs } }));
      });
      const ping = setInterval(() => ws.ping(), options.pingIntervalMs);
      ws.on("close", () => clearInterval(ping));
    });
  });

  const port = await listenLocal(server, 0, options.host);
  return {
    host: options.host,
    port,
    secret,
    get sessions() {
      return state.sessions;
    },
    set sessions(value) {
      state.sessions = value;
    },
    get jobs() {
      return state.jobs;
    },
    set jobs(value) {
      state.jobs = value;
    },
    get listCalls() {
      return state.listCalls;
    },
    get jobCalls() {
      return state.jobCalls;
    },
    get apiFails() {
      return state.apiFails;
    },
    set apiFails(value: boolean) {
      state.apiFails = value;
    },
    requests,
    sockets,
    async close() {
      for (const client of wss.clients) client.terminate();
      await closeServer(server);
    },
  };
}

// ------------------------------------------------------------------ container runtime

interface FakeContainer {
  id: string;
  userId: number | null;
  /** The agent label. */
  agent: AgentKind;
  /** Address on the "workspace network"; null for orphans nobody serves. */
  ip: string | null;
  running: boolean;
  exitCode: number | null;
  /** The agent's credential from the container's environment; null when it has none. */
  credential: string | null;
  server: FakeAgentServer | null;
}

/** What every fake agent server has. */
interface FakeAgentServer {
  port: number;
  close(): Promise<void>;
}

/** One startWorkspace call, with the files the gateway had rendered for it by then. */
export interface StartRecord {
  userId: number;
  containerId: string;
  options: WorkspaceStartOptions;
  /** The agent's settings directory (file name → content). */
  files: Record<string, string>;
  /** Qwen Code's two settings files, parsed; null for other agents. */
  settings: SettingsObject | null;
  systemDefaults: SettingsObject | null;
}

/**
 * "Starts" a workspace by launching the fake agent server it asks for, with the credential the
 * gateway chose. Like Docker, it gives each running container its own address (127.0.0.2,
 * 127.0.0.3, …) and hands a freed address to the next container.
 */
export class FakeRuntime implements ContainerRuntime {
  readonly containers = new Map<string, FakeContainer>();
  readonly starts: StartRecord[] = [];
  readyAfterMs = 0;
  pingIntervalMs = 50;
  memoryBytes = 256 * 1024 * 1024;
  /** Cumulative CPU seconds per user, as docker stats reports them (default 0). */
  readonly cpuSeconds = new Map<number, number>();
  failNextStart: Error | null = null;
  /** While set, stopping a container fails with this error (and the container keeps running). */
  failStops: Error | null = null;
  /** While set, stops wait for it: catches the gateway in the middle of a stop. */
  stopGate: Promise<void> | null = null;
  #seq = 0;
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  containerFor(userId: number): FakeContainer {
    const container = [...this.containers.values()].find((c) => c.userId === userId && c.running);
    if (!container) throw new Error(`no running fake workspace for user ${userId}`);
    return container;
  }

  qwenFor(userId: number): FakeQwen {
    const { agent, server } = this.containerFor(userId);
    if (agent !== "qwen" || !server) throw new Error(`the workspace of user ${userId} has no fake qwen serve`);
    return server as FakeQwen;
  }

  dshFor(userId: number): FakeDsh {
    const { agent, server } = this.containerFor(userId);
    if (agent !== "dsh" || !server) throw new Error(`the workspace of user ${userId} has no fake dsh`);
    return server as FakeDsh;
  }

  startsFor(userId: number): StartRecord[] {
    return this.starts.filter((start) => start.userId === userId);
  }

  runningUsers(): number[] {
    return [...this.containers.values()]
      .filter((c) => c.running)
      .map((c) => c.userId!)
      .sort((a, b) => a - b);
  }

  /** A container the gateway does not know about (as if left behind by someone else). */
  addOrphan(userId: number | null): string {
    const id = `orphan-${++this.#seq}`;
    this.containers.set(id, { id, userId, agent: "qwen", ip: null, running: true, exitCode: null, credential: null, server: null });
    return id;
  }

  /** The lowest address no running container has, as Docker's IPAM would pick. */
  #freeIp(): string {
    const taken = new Set([...this.containers.values()].filter((c) => c.running).map((c) => c.ip));
    for (let n = 2; n < 255; n++) if (!taken.has(`127.0.0.${n}`)) return `127.0.0.${n}`;
    throw new Error("no free fake container address");
  }

  async crash(userId: number, exitCode = 1): Promise<void> {
    const container = this.containerFor(userId);
    container.running = false;
    container.exitCode = exitCode;
    await container.server?.close();
  }

  async startWorkspace(userId: number, options: WorkspaceStartOptions): Promise<StartedContainer> {
    for (const container of [...this.containers.values()]) {
      if (container.userId === userId) await this.removeContainer(container.id);
    }
    if (this.failNextStart) {
      const error = this.failNextStart;
      this.failNextStart = null;
      throw error;
    }
    // Docker would bind-mount these; the gateway must have rendered them before the start.
    const paths = userPaths(this.#dataDir, userId);
    const read = (file: string): string => {
      if (!fs.existsSync(file)) throw new Error(`the gateway did not render ${file} before starting the container`);
      return fs.readFileSync(file, "utf8");
    };
    const settingsDir = paths.agentSettings(options.agent);
    if (!fs.existsSync(settingsDir)) throw new Error(`the gateway did not render ${settingsDir} before starting the container`);
    const files = Object.fromEntries(fs.readdirSync(settingsDir).map((name) => [name, read(path.join(settingsDir, name))]));
    read(paths.passwd);
    read(paths.group);

    const ip = this.#freeIp();
    const serverOptions = { readyAfterMs: this.readyAfterMs, pingIntervalMs: this.pingIntervalMs, host: ip };
    const server =
      options.agent === "qwen" ? await startFakeQwen(options.credential, serverOptions) : await startFakeDsh(options.credential, serverOptions);
    const id = `fake-${++this.#seq}`;
    this.containers.set(id, { id, userId, agent: options.agent, ip, running: true, exitCode: null, credential: options.credential, server });
    const parsed = (name: string): SettingsObject | null => (options.agent === "qwen" ? (JSON.parse(files[name]!) as SettingsObject) : null);
    this.starts.push({ userId, containerId: id, options: { ...options }, files, settings: parsed("settings.json"), systemDefaults: parsed("system-defaults.json") });
    return { id, ip, port: server.port };
  }

  /** Like docker inspect: the credential from the agent's env var, also for a stopped container. */
  async credential(id: string, agent: AgentKind): Promise<string | null> {
    const container = this.containers.get(id);
    return container?.agent === agent ? container.credential : null;
  }

  /** Simulates a container started without a credential the gateway can read back. */
  forgetCredential(id: string): void {
    const container = this.containers.get(id);
    if (container) container.credential = null;
  }

  async stopContainer(id: string): Promise<void> {
    await this.stopGate;
    if (this.failStops) throw this.failStops;
    await this.removeContainer(id);
  }

  async removeContainer(id: string): Promise<void> {
    const container = this.containers.get(id);
    this.containers.delete(id);
    await container?.server?.close();
  }

  async state(id: string): Promise<ContainerState> {
    const container = this.containers.get(id);
    if (container?.running) return { running: true };
    return { running: false, exitCode: container?.exitCode ?? null, oomKilled: false };
  }

  async list(): Promise<ContainerSummary[]> {
    return [...this.containers.values()].map((c) => ({
      id: c.id,
      userId: c.userId,
      agent: c.agent,
      running: c.running,
      ip: c.ip,
      port: c.server?.port ?? 1,
    }));
  }

  async logsTail(id: string): Promise<string> {
    return `fake ${this.containers.get(id)?.agent ?? "agent"}: last log line\n`;
  }

  async sample(id: string): Promise<ContainerSample> {
    const container = this.containers.get(id);
    if (!container?.running) return { running: false };
    return { running: true, memoryBytes: this.memoryBytes, cpuSeconds: this.cpuSeconds.get(container.userId ?? 0) ?? 0 };
  }
}

// ------------------------------------------------------------------ LLM server

export interface FakeUpstream {
  port: number;
  requests: RecordedRequest[];
  /** Requests whose client went away before the response finished. */
  abandoned: number;
  close(): Promise<void>;
}

export const LLM_KEY = "test-llm-key";

/** OpenAI-compatible server: JSON and SSE chat completions with usage, and a model list. */
export async function startFakeLlm(): Promise<FakeUpstream> {
  const state = { requests: [] as RecordedRequest[], abandoned: 0 };
  const server = http.createServer(async (req, res) => {
    state.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    if (req.headers.authorization !== `Bearer ${LLM_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"bad key"}}');
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "qwen3.8-flash-next" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { stream?: boolean; hold?: boolean };
    res.on("close", () => {
      if (!res.writableFinished) state.abandoned++;
    });
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 11, completion_tokens: 22 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"he"}}],"usage":null}\n\n');
    if (body.hold) return; // keeps generating until the client hangs up
    await delay(150);
    res.write('data: {"choices":[{"delta":{"content":"llo"}}],"usage":null}\n\n');
    await delay(20);
    res.write('data: {"choices":[],"usage":{"prompt_tok');
    await delay(20);
    res.write('ens":12,"completion_tokens":34}}\n\ndata: [DONE]\n\n');
    res.end();
  });
  const port = await listenLocal(server);
  return {
    port,
    get requests() {
      return state.requests;
    },
    get abandoned() {
      return state.abandoned;
    },
    close: () => closeServer(server),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
