// In-process stand-ins for Docker (containers and images), the agents' web servers (Qwen Code's
// `qwen serve`, DeepSeek Harness's `dsh web`), the LLM server and the npm registry.
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { AgentKind, EngineJob, EngineStatus, ReleaseNotes, WorkspaceKind } from "@portal/core";
import { driverFor } from "../src/agents/index.ts";
import type { SettingsObject } from "../src/agents/qwen-settings.ts";
import type { WorkspaceStartOptions } from "../src/docker/container-spec.ts";
import {
  BuildError,
  imageInUse,
  imageNotFound,
  VerifyError,
  type BuildObserver,
  type BuildSpec,
  type ImageBuilder,
  type SweepResult,
  type WorkspaceImageSummary,
} from "../src/docker/image-builder.ts";
import type { NotesClient, RegistryClient } from "../src/updates/engine-releases.ts";
import type { EngineHost } from "../src/updates/engine-updater.ts";
import { HostdError } from "../src/monitor/hostd.ts";
import { parseWorkspaceImage, STAGING_REPOSITORY, workspaceImage } from "../src/docker/image-names.ts";
import { registryError, type NpmPackage, type NpmRegistry } from "../src/updates/npm-registry.ts";
import { userPaths } from "../src/workspaces/paths.ts";
import type { ContainerRuntime, ContainerSample, ContainerState, ContainerSummary, StartedContainer } from "../src/docker/runtime.ts";
import type { Logger } from "../src/lib/log.ts";

export const quiet: Logger = { info() {}, warn() {}, error() {} };

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
  const fake: FakeQwen = {
    host: options.host,
    port: 0,
    token,
    health: { activePrompts: 0, pendingPermissions: 0, activeWork: false, connectedClients: 0, idleSinceMs: null, channelAlive: true },
    healthChecks: 0,
    healthFails: false,
    onHealth: null,
    requests: [],
    uploads: [],
    sockets: [],
    async close() {
      for (const client of wss.clients) client.terminate();
      await closeServer(server);
    },
  };

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const status = refuse(req, token);
    if (url === "/health?deep=1" && status === null) {
      fake.healthChecks++;
      fake.onHealth?.();
      if (fake.healthFails) return json(res, 503, { error: "Service Unavailable" });
      const { health } = fake;
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
    if (url === "/daemon/status" && status === null) {
      // The first start of the agent process: under way, then done for good, whatever happens to the process later.
      return json(res, 200, { v: 1, status: "ok", daemon: { startup: { preheat: { status: Date.now() >= readyAt ? "succeeded" : "running" } } } });
    }
    const record = { method, url, headers: req.headers, status: status ?? 200 };
    fake.requests.push(record);
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
      fake.uploads.push(upload);
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
      fake.sockets.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      ws.send(`hello from qwen ${pathname}`);
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
      const ping = setInterval(() => ws.ping(), options.pingIntervalMs);
      ws.on("close", () => clearInterval(ping));
    });
  });

  fake.port = await listenLocal(server, 0, options.host);
  return fake;
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
  const fake: FakeDsh = {
    host: options.host,
    port: 0,
    secret,
    sessions: [],
    jobs: [],
    listCalls: 0,
    jobCalls: 0,
    apiFails: false,
    requests: [],
    sockets: [],
    async close() {
      for (const client of wss.clients) client.terminate();
      await closeServer(server);
    },
  };

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
      if (fake.apiFails) return json(res, 503, { error: "unavailable" });
      const answer = (value: unknown) => json(res, 200, { type: "server-response", rpcId: call.rpcId, result: value === undefined ? { ok: false, error: { code: "gateway/input-invalid" } } : { ok: true, value } });
      const args = call.payload?.args;
      if (call.method !== pathname.slice("/api/".length)) return answer(undefined);
      if (call.method === "session/state") {
        const session = fake.sessions.find((s) => s.id === args?.request?.sessionId);
        return answer(session && { running: session.running, active: true, pendingInput: session.pendingInput ?? [], queue: [] });
      }
      if (typeof args?._request !== "object") return answer(undefined);
      fake.listCalls++;
      return answer({ items: fake.sessions.map((s, index) => ({ sessionId: s.id, running: s.running, updatedAt: 1_000 + index, title: s.id })) });
    }
    const record = { method, url, headers: req.headers, status: status ?? 200 };
    fake.requests.push(record);
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
      fake.sockets.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, probe });
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
        if (fake.apiFails || typeof sessionId !== "string") {
          return void ws.send(JSON.stringify({ type: "error", streamId: frame.streamId, error: { code: "gateway/input-invalid" } }));
        }
        fake.jobCalls++;
        const jobs = fake.jobs.filter((job) => job.owner === sessionId).map((job, index) => ({ id: `bash-${index}`, kind: "bash", owner: job.owner, status: job.status }));
        ws.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: { type: "rows", jobs } }));
      });
      const ping = setInterval(() => ws.ping(), options.pingIntervalMs);
      ws.on("close", () => clearInterval(ping));
    });
  });

  fake.port = await listenLocal(server, 0, options.host);
  return fake;
}

// ------------------------------------------------------------------ container runtime

interface FakeContainer {
  id: string;
  userId: number | null;
  /** The agent label. */
  agent: AgentKind;
  /** The kind label (none: Private); null for a label the gateway doesn't know. */
  kind: WorkspaceKind | null;
  /** The image it was created from. */
  image: string;
  /** The version label (container-spec.ts VERSION_LABEL); null for a container from before it. */
  version: string | null;
  /** Address on its kind's "network" (Private 127.0.0.N, Online 127.0.1.N); null for orphans nobody serves. */
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
  addOrphan(userId: number | null, kind: WorkspaceKind | null = "private"): string {
    const id = `orphan-${++this.#seq}`;
    const image = workspaceImage("qwen", "0.27.0");
    this.containers.set(id, { id, userId, agent: "qwen", kind, image, version: "0.27.0", ip: null, running: true, exitCode: null, credential: null, server: null });
    return id;
  }

  /**
   * The lowest address no running container of the kind has, as Docker's IPAM would pick on that kind's network.
   * The kinds' "subnets" differ, like the real ones (the config refuses overlapping ones).
   */
  #freeIp(kind: WorkspaceKind): string {
    const prefix = kind === "online" ? "127.0.1." : "127.0.0.";
    const taken = new Set([...this.containers.values()].filter((c) => c.running).map((c) => c.ip));
    for (let n = 2; n < 255; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
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
    const paths = userPaths(this.#dataDir, userId, options.kind);
    const read = (file: string): string => {
      if (!fs.existsSync(file)) throw new Error(`the gateway did not render ${file} before starting the container`);
      return fs.readFileSync(file, "utf8");
    };
    const settingsDir = paths.agentSettings(options.agent);
    if (!fs.existsSync(settingsDir)) throw new Error(`the gateway did not render ${settingsDir} before starting the container`);
    const files = Object.fromEntries(fs.readdirSync(settingsDir).map((name) => [name, read(path.join(settingsDir, name))]));
    read(paths.passwd);
    read(paths.group);

    const ip = this.#freeIp(options.kind);
    const serverOptions = { readyAfterMs: this.readyAfterMs, pingIntervalMs: this.pingIntervalMs, host: ip };
    const server =
      options.agent === "qwen" ? await startFakeQwen(options.credential, serverOptions) : await startFakeDsh(options.credential, serverOptions);
    const id = `fake-${++this.#seq}`;
    const version = parseWorkspaceImage(options.image)?.version ?? null;
    this.containers.set(id, {
      id,
      userId,
      agent: options.agent,
      kind: options.kind,
      image: options.image,
      version,
      ip,
      running: true,
      exitCode: null,
      credential: options.credential,
      server,
    });
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
      kind: c.kind,
      running: c.running,
      ip: c.ip,
      port: c.server?.port ?? 1,
      version: c.version,
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

  /** Whether any container (running or not) was created from this image, as Docker would refuse to remove it. */
  usesImage(image: string): boolean {
    return [...this.containers.values()].some((c) => c.image === image);
  }
}

// ------------------------------------------------------------------ image builds

interface FakeImage {
  id: string;
  sizeBytes: number;
  createdAt: number;
}

/** A promise that resolves once `open()` is called: for the fakes' gates (buildGate, verifyGate, …). */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** Waits for `gate` unless `signal` aborts first (then rejects with its reason, like a real build). */
function untilOpenOrAborted(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    gate.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Images by tag, and builds that report progress like BuildKit and tag what they built. Removal is
 * refused for images a FakeRuntime container uses, as Docker refuses it.
 */
export class FakeImageBuilder implements ImageBuilder {
  readonly images = new Map<string, FakeImage>();
  readonly builds: Array<BuildSpec & { outcome: "running" | "built" | "failed" | "aborted" }> = [];
  /** Images whose version was asked for. */
  readonly verified: string[] = [];
  /** While set, builds wait for it (or for their cancellation) after the first steps. */
  buildGate: Promise<void> | null = null;
  /** While set, version checks wait for it (or for their cancellation). */
  verifyGate: Promise<void> | null = null;
  /** While set, discards (`docker rmi` of a staging tag) wait for it. */
  discardGate: Promise<void> | null = null;
  /** Image ids removeUntagged removed: builds a rebuild replaced. */
  readonly removedIds: string[] = [];
  /** How often sweep ran. */
  sweeps = 0;
  /** The next build fails with this engine message. */
  failNextBuild: string | null = null;
  /** What the image's CLI reports; by default the version its build was for. */
  reportVersion: ((image: string) => string | null) | null = null;
  readonly #runtime: FakeRuntime;
  readonly #builtVersions = new Map<string, string>();
  #seq = 0;

  constructor(runtime: FakeRuntime) {
    this.#runtime = runtime;
  }

  /** An image that exists already (built by deploy/install.sh). */
  install(kind: AgentKind, version: string): string {
    const image = workspaceImage(kind, version);
    this.images.set(image, { id: `sha256:installed-${++this.#seq}`, sizeBytes: 2_000_000_000, createdAt: 1_700_000_000_000 });
    this.#builtVersions.set(image, version);
    return image;
  }

  async build(spec: BuildSpec, observer: BuildObserver, signal: AbortSignal): Promise<void> {
    const record = { ...spec, outcome: "running" as "running" | "built" | "failed" | "aborted" };
    this.builds.push(record);
    const { packageName } = driverFor(spec.kind).release;
    const step = `[${spec.kind} 1/2] RUN npm install -g --no-fund --no-audit "${packageName}@${spec.version}"`;
    observer.onStep("[internal] load remote build context");
    observer.onLog(["#1 [internal] load remote build context", "#1 DONE 0.0s"]);
    observer.onStep(step);
    observer.onLog([`#2 ${step}`]);
    try {
      if (this.buildGate) await untilOpenOrAborted(this.buildGate, signal);
      signal.throwIfAborted();
    } catch (error) {
      record.outcome = "aborted";
      throw error;
    }
    if (this.failNextBuild !== null) {
      const message = this.failNextBuild;
      this.failNextBuild = null;
      record.outcome = "failed";
      observer.onLog([`#2 npm error notarget No matching version found for ${packageName}@${spec.version}.`, `#2 ERROR: ${message}`]);
      throw new BuildError(message);
    }
    observer.onLog(["#2 added 14 packages in 7s", "#2 DONE 7.5s"]);
    this.images.set(spec.image, { id: `sha256:built-${++this.#seq}`, sizeBytes: 2_100_000_000, createdAt: Date.now() });
    this.#builtVersions.set(spec.image, spec.version);
    record.outcome = "built";
  }

  async cliVersion(image: string, _cli: string, signal: AbortSignal): Promise<string | null> {
    this.verified.push(image);
    if (!this.images.has(image)) throw new VerifyError(`no such image ${image}`);
    if (this.verifyGate) await untilOpenOrAborted(this.verifyGate, signal);
    return this.reportVersion ? this.reportVersion(image) : (this.#builtVersions.get(image) ?? null);
  }

  async promote(staging: string, image: string): Promise<string | null> {
    const built = this.images.get(staging);
    if (!built) throw new Error(`no such image ${staging}`);
    const before = this.images.get(image);
    this.images.set(image, built);
    this.#builtVersions.set(image, this.#builtVersions.get(staging)!);
    await this.discard(staging);
    return before !== undefined && before.id !== built.id ? before.id : null;
  }

  /** The fake keeps no untagged images: an id no tag names counts as removed. */
  async removeUntagged(id: string): Promise<void> {
    if ([...this.images.values()].some((info) => info.id === id)) return;
    this.removedIds.push(id);
  }

  async discard(staging: string): Promise<void> {
    if (this.discardGate) await this.discardGate;
    this.images.delete(staging);
    this.#builtVersions.delete(staging);
  }

  async exists(image: string): Promise<boolean> {
    return this.images.has(image);
  }

  /** Removes staging tags no container uses (the fake has no version-check containers or untagged images). */
  async sweep(): Promise<SweepResult> {
    this.sweeps++;
    const images = [...this.images.keys()].filter((image) => image.startsWith(`${STAGING_REPOSITORY}:`) && !this.#runtime.usesImage(image));
    for (const image of images) {
      this.images.delete(image);
      this.#builtVersions.delete(image);
    }
    return { containers: [], images };
  }

  async list(): Promise<WorkspaceImageSummary[]> {
    return [...this.images].flatMap(([image, info]) => {
      const parsed = parseWorkspaceImage(image);
      return parsed ? [{ image, ...parsed, ...info }] : [];
    });
  }

  async remove(image: string): Promise<void> {
    if (!this.images.has(image)) throw imageNotFound(image);
    if (this.#runtime.usesImage(image)) throw imageInUse(image);
    this.images.delete(image);
  }
}

// ------------------------------------------------------------------ npm registry

/** The registry as the agents' packages look on it, with switches for outages and slow answers. */
export class FakeRegistry implements NpmRegistry {
  tags: Record<string, Record<string, string>> = {
    "@qwen-code/qwen-code": {
      jobbench: "0.20.2-jobbench-no-todo-write.0",
      preview: "0.27.2-preview.0",
      latest: "0.27.4",
      nightly: "0.27.2-nightly.20261113.6f754be654",
    },
    "@deepseek-ai/dsh": { alpha: "0.2.2-alpha.3", latest: "0.2.2-rc.1", next: "0.2.2-rc.3" },
  };
  /** Published versions besides the ones a dist-tag names. */
  readonly published = new Set(["@qwen-code/qwen-code@0.27.0", "@qwen-code/qwen-code@0.26.0", "@deepseek-ai/dsh@0.2.1"]);
  down = false;
  /** While set, answers wait for it. */
  gate: Promise<void> | null = null;
  readonly calls: string[] = [];

  /** The package's dist-tags and versions (no publish times, no repository); never a 304. */
  async packument(packageName: string): Promise<{ etag: string | null; package: NpmPackage }> {
    this.calls.push(`packument ${packageName}`);
    await this.gate;
    if (this.down) throw registryError("The npm registry is unreachable (fetch failed).");
    const tags = this.tags[packageName] ?? {};
    const others = [...this.published].filter((entry) => entry.startsWith(`${packageName}@`)).map((entry) => entry.slice(packageName.length + 1));
    const versions = [...new Set([...Object.values(tags), ...others])].map((version) => ({ version, publishedAt: null, deprecated: false }));
    return { etag: null, package: { distTags: { ...tags }, versions, githubRepo: null } };
  }

  async hasVersion(packageName: string, version: string): Promise<boolean> {
    this.calls.push(`version ${packageName}@${version}`);
    await this.gate;
    if (this.down) throw registryError("The npm registry is unreachable (fetch failed).");
    return this.published.has(`${packageName}@${version}`) || Object.values(this.tags[packageName] ?? {}).includes(version);
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
  const fake: FakeUpstream = { port: 0, requests: [], abandoned: 0, close: () => closeServer(server) };
  const server = http.createServer(async (req, res) => {
    fake.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
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
      if (!res.writableFinished) fake.abandoned++;
    });
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 11, completion_tokens: 22 } }));
      return;
    }
    // Like llama.cpp's server: an empty role delta at once, a token per event, timings at the end.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}],"usage":null}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"he"}}],"usage":null}\n\n');
    if (body.hold) return; // keeps generating until the client hangs up
    await delay(150);
    res.write('data: {"choices":[{"delta":{"content":"llo"}}],"usage":null}\n\n');
    await delay(20);
    res.write('data: {"choices":[],"usage":{"prompt_tok');
    await delay(20);
    res.write(
      'ens":12,"completion_tokens":34},"timings":{"cache_n":2,"prompt_n":10,"prompt_ms":20,"predicted_n":34,"predicted_ms":170}}\n\ndata: [DONE]\n\n',
    );
    res.end();
  });
  fake.port = await listenLocal(server);
  return fake;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------ LLM engine (portal-hostd)

export const ENGINE_REPOSITORY = "ghcr.io/gufo-org/toolboxes/gufo-runtime";

/** A digest for a version: sha256 of its name. */
export function engineDigest(version: string): string {
  return `sha256:${createHash("sha256").update(version).digest("hex")}`;
}

/**
 * The LLM server's portal-hostd as the engine updater sees it: a quadlet image, local images, and one
 * job at a time that ends after `jobPolls` status calls. `failApply` makes the next apply fail (and
 * roll back, like hostd).
 */
export class FakeEngineHost implements EngineHost {
  version: string;
  previous: string | null = null;
  local = new Set<string>();
  jobPolls = 1;
  failPull: string | null = null;
  failApply: string | null = null;
  offline = false;
  readonly calls: string[] = [];
  #job: EngineJob | null = null;
  #pollsLeft = 0;
  #finishJob: (() => void) | null = null;
  #nextId = 1;

  constructor(version = "0.31.0") {
    this.version = version;
    this.local.add(version);
  }

  async status(): Promise<EngineStatus> {
    if (this.offline) throw new HostdError(null, "unreachable", "http://llm:9180: connect ECONNREFUSED");
    if (this.#job?.phase === "running" && --this.#pollsLeft <= 0) this.#finishJob?.();
    const image = (version: string): string => `${ENGINE_REPOSITORY}@${engineDigest(version)}`;
    return {
      unit: "gufo.service",
      quadlet: "/home/llm/.config/containers/systemd/gufo.container",
      repository: ENGINE_REPOSITORY,
      image: image(this.version),
      digest: engineDigest(this.version),
      version: this.version,
      revision: null,
      state: "active",
      subState: "running",
      ready: true,
      buildInfo: `${this.version} (abc1234)`,
      previous: this.previous === null ? null : { image: image(this.previous), digest: engineDigest(this.previous), version: this.previous },
      images: [...this.local].map((version) => ({
        id: version,
        digest: engineDigest(version),
        version,
        revision: null,
        createdAt: null,
        sizeBytes: 1e9,
        current: version === this.version,
        previous: version === this.previous,
      })),
      job: this.#job && { ...this.#job, log: [...this.#job.log] },
    };
  }

  async pull(image: string): Promise<EngineJob> {
    this.calls.push(`pull ${image}`);
    const version = this.#versionOf(image);
    return this.#start("pull", image, null, () => {
      if (this.failPull !== null) return this.failPull;
      this.local.add(version);
      return null;
    });
  }

  async apply(image: string, version: string | null): Promise<EngineJob> {
    this.calls.push(`apply ${image} ${version}`);
    const target = this.#versionOf(image);
    if (!this.local.has(target)) throw new HostdError(409, "not_pulled", "The image is not on this server.");
    return this.#start("apply", image, version, () => {
      if (this.failApply !== null) {
        const error = this.failApply;
        this.failApply = null;
        this.#job!.rolledBack = true;
        return error;
      }
      this.previous = this.version;
      this.version = target;
      return null;
    });
  }

  async cancel(): Promise<boolean> {
    this.calls.push("cancel");
    if (this.#job?.phase !== "running" || this.#job.kind !== "pull") return false;
    this.#job.phase = "cancelled";
    this.#job.finishedAt = Date.now();
    return true;
  }

  async removeImage(digest: string): Promise<void> {
    this.calls.push(`rmi ${digest}`);
    const version = [...this.local].find((v) => engineDigest(v) === digest);
    if (version === undefined) throw new HostdError(404, "not_found", "No such image.");
    if (version === this.version) throw new HostdError(409, "image_current", "The engine runs this image.");
    this.local.delete(version);
  }

  #versionOf(image: string): string {
    const digest = image.split("@")[1];
    return ["0.30.0", "0.31.0", "0.32.0", "0.33.0", "0.34.0", "0.35.0"].find((v) => engineDigest(v) === digest) ?? "unknown";
  }

  #start(kind: EngineJob["kind"], image: string | null, version: string | null, finish: () => string | null): EngineJob {
    if (this.#job?.phase === "running") throw new HostdError(409, "job_running", "A job is running.");
    const job: EngineJob = { id: String(this.#nextId++), kind, image, version, phase: "running", step: `${kind}ing`, log: [`${kind} started`], startedAt: Date.now(), finishedAt: null, error: null, rolledBack: false };
    this.#job = job;
    this.#pollsLeft = this.jobPolls;
    this.#finishJob = () => {
      const error = finish();
      job.phase = error === null ? "succeeded" : "failed";
      job.error = error;
      job.log.push(error === null ? `${kind} done` : `${kind} failed: ${error}`);
      job.finishedAt = Date.now();
    };
    return { ...job, log: [...job.log] };
  }
}

/** A registry with the given versions (and latest = the newest). */
export class FakeEngineRegistry implements RegistryClient {
  versions = ["0.30.0", "0.31.0", "0.32.0", "0.33.0", "0.34.0"];
  failing = false;
  calls = 0;

  async tags(): Promise<string[]> {
    this.calls++;
    if (this.failing) throw new Error("ghcr.io answered 503");
    return [...this.versions, "latest", "edge", "sha-abc1234"];
  }

  async digest(_repository: string, tag: string): Promise<string | null> {
    if (this.failing) throw new Error("ghcr.io answered 503");
    if (tag === "latest") return engineDigest(this.versions.at(-1)!);
    return this.versions.includes(tag) ? engineDigest(tag) : null;
  }
}

export class FakeNotes implements NotesClient {
  calls = 0;
  async notes(): Promise<Map<string, ReleaseNotes>> {
    this.calls++;
    return new Map([
      ["0.34.0", { title: "v0.34.0", url: "https://github.com/gufo-org/gufo/releases/tag/v0.34.0", publishedAt: 0, body: "### ⚠ BREAKING CHANGES\n\n* audio", breaking: true }],
      ["0.33.0", { title: "v0.33.0", url: "https://github.com/gufo-org/gufo/releases/tag/v0.33.0", publishedAt: 0, body: "### Features", breaking: false }],
    ]);
  }
}
