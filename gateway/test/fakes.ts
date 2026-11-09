// In-process stand-ins for Docker, Qwen Code's `qwen serve` (the Web Shell) and the LLM server.
import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { WorkspaceStartOptions } from "../src/container-spec.ts";
import { userPaths } from "../src/paths.ts";
import type { SettingsObject } from "../src/qwen.ts";
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

// ------------------------------------------------------------------ container runtime

interface FakeContainer {
  id: string;
  userId: number | null;
  /** Address on the "workspace network"; null for orphans nobody serves. */
  ip: string | null;
  running: boolean;
  exitCode: number | null;
  /** QWEN_SERVER_TOKEN from the container's environment; null when it has none. */
  token: string | null;
  qwen: FakeQwen | null;
}

/** One startWorkspace call, with the files the gateway had rendered for it by then. */
export interface StartRecord {
  userId: number;
  containerId: string;
  options: WorkspaceStartOptions;
  settings: SettingsObject;
  systemDefaults: SettingsObject;
}

/**
 * "Starts" a workspace by launching a fake `qwen serve` with the token the gateway chose. Like Docker,
 * it gives each running container its own address (127.0.0.2, 127.0.0.3, …) and hands a freed address
 * to the next container.
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
    const { qwen } = this.containerFor(userId);
    if (!qwen) throw new Error(`the workspace of user ${userId} has no fake qwen serve`);
    return qwen;
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
    this.containers.set(id, { id, userId, ip: null, running: true, exitCode: null, token: null, qwen: null });
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
    await container.qwen?.close();
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
    const settings = JSON.parse(read(path.join(paths.qwenSettings, "settings.json"))) as SettingsObject;
    const systemDefaults = JSON.parse(read(path.join(paths.qwenSettings, "system-defaults.json"))) as SettingsObject;
    read(paths.passwd);
    read(paths.group);

    const ip = this.#freeIp();
    const qwen = await startFakeQwen(options.token, { readyAfterMs: this.readyAfterMs, pingIntervalMs: this.pingIntervalMs, host: ip });
    const id = `fake-${++this.#seq}`;
    this.containers.set(id, { id, userId, ip, running: true, exitCode: null, token: options.token, qwen });
    this.starts.push({ userId, containerId: id, options: { ...options }, settings, systemDefaults });
    return { id, ip, port: qwen.port };
  }

  /** Like docker inspect: the token from the environment, also for a stopped container. */
  async serverToken(id: string): Promise<string | null> {
    return this.containers.get(id)?.token ?? null;
  }

  /** Simulates a container started without a token the gateway can read back. */
  forgetToken(id: string): void {
    const container = this.containers.get(id);
    if (container) container.token = null;
  }

  async stopContainer(id: string): Promise<void> {
    await this.stopGate;
    if (this.failStops) throw this.failStops;
    await this.removeContainer(id);
  }

  async removeContainer(id: string): Promise<void> {
    const container = this.containers.get(id);
    this.containers.delete(id);
    await container?.qwen?.close();
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
      running: c.running,
      ip: c.ip,
      port: c.qwen?.port ?? 1,
    }));
  }

  async logsTail(): Promise<string> {
    return "fake qwen: last log line\n";
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
