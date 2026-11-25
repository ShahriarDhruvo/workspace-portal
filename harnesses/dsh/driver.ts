// The DeepSeek Harness driver: `dsh --profile web` in a workspace container (image/start.sh).
//   * Auth: dsh's web UI uses a browser-session cookie, `dsh-auth-<hash of the authority>`, signed with a secret dsh
//     keeps as a credentials record. The gateway generates that secret per start (DSH_COOKIE_SECRET; start.sh stores
//     it in a file under /tmp and drops it from the environment) and mints the cookie itself for every request it
//     forwards. The browser never holds a dsh cookie: the proxy's session, port and Origin checks are what authorise
//     it (browserAuth "session").
//   * dsh binds cookies to the Host they were issued for and checks Origin against Host, so the gateway always
//     presents Host localhost:3080 (a loopback name dsh trusts) and, when the browser sent an Origin (already checked
//     to be the workspace's own), the matching Origin.
//   * Its API: `POST /api/<ns>/<method>` RPCs, plus streams multiplexed over one WebSocket, /api/remote.mux, which is
//     also the only socket its UI opens.
//   * Readiness: `session/list` answers. Working: a session runs a turn (generating or running a tool) or a background
//     job (`job/list`, a stream) still runs. A turn that only waits for the person (an approval or a question,
//     `session/state`) is not work: dsh never times those out, and they must not keep a workspace nobody uses running.
//     dsh reports no time of last activity, so the gateway times the end of the work itself.
//   * Settings: portal.patch.yml (settings.ts), and the instructions file beside it.
import crypto from "node:crypto";
import WebSocket from "ws";
import { AGENT_NAMES, field, parseJson } from "@portal/core";
import type { AgentDriver, AgentEndpoint, AgentStatus } from "../harness.ts";
import { agentInstructions, INSTRUCTIONS_FILE } from "../instructions.ts";
import { modelCatalog } from "../models.ts";
import { AGENT_TIMEOUT_MS, agentJson, generateCredential, serviceBaseUrl } from "../shared.ts";
import { DSH_PATCH_FILE, fitDshModels, renderDshPatch } from "./settings.ts";

const DSH_PORT = 3080;
/** What the gateway presents as Host: dsh issues and checks its cookies for this authority. */
const DSH_AUTHORITY = `localhost:${DSH_PORT}`;
export const DSH_COOKIE_NAME = `dsh-auth-${crypto.createHash("sha256").update(DSH_AUTHORITY).digest("base64url")}`;
const DSH_MUX_PATH = "/api/remote.mux";
/** Minted cookies are short-lived: a new one goes with every request. */
const COOKIE_TTL_MS = 10 * 60_000;
/** Issued a little in the past, in case the container's clock is slightly behind. */
const CLOCK_SKEW_MS = 60_000;
/** A session list grows with the user's sessions (about 1 KB each); generous, but bounded. */
const MAX_API_BYTES = 4 * 1024 * 1024;
/**
 * Background jobs are checked in the most recently used sessions only. Jobs belong to the dsh process (a restart ends
 * them) and are started from a turn, so they sit in sessions used since the start.
 */
const MAX_JOB_SESSIONS = 32;

/**
 * POSTs the dsh UI sends without anyone acting: on page load (catalogs, lists, the draft session it creates) and when
 * a terminal opens. An idle tab sends nothing at all.
 */
const PASSIVE_API =
  /^\/api\/(?:session\/(?:list|create|modelCatalog|state)|workspace\/initializeDefault|terminal\/(?:environment|shells)|[^/]+\/(?:list|describe|catalog|inventory|syncInspectManifest|listProviders|listConfigurableProviders))$/;

/** A dsh browser-session cookie (`name=value`) for DSH_AUTHORITY, signed with the container's secret. */
export function mintDshCookie(secret: string, now = Date.now()): string {
  const issuedAt = now - CLOCK_SKEW_MS;
  const body = Buffer.from(JSON.stringify({ version: 1, authority: DSH_AUTHORITY, issuedAt, expiresAt: now + COOKIE_TTL_MS })).toString("base64url");
  const signature = crypto.createHmac("sha256", Buffer.from(secret, "base64url")).update(body).digest("base64url");
  return `${DSH_COOKIE_NAME}=v1.${body}.${signature}`;
}

export const dshDriver: AgentDriver = {
  kind: "dsh",
  name: AGENT_NAMES.dsh,
  description: "DeepSeek Harness (dsh): chat, files, terminal and a headless browser.",
  release: { packageName: "@deepseek-ai/dsh", versionKey: "DSH_VERSION", defaultVersion: "0.2.2-rc.1", cli: "dsh" },
  port: DSH_PORT,
  credentialEnv: "DSH_COOKIE_SECRET",
  settingsMount: "/etc/workspace-portal/dsh",
  browserAuth: "session",
  // /connect trades a launch token for a session cookie (pairing another browser). OAuth sign-ins (DeepSeek account)
  // and opening apps on the host belong to plugins the image's lockdown disables; refusing them here as well costs nothing.
  blockedPrefixes: ["/connect", "/open-in-app", "/oauth"],

  isSocketPath: (pathname) => pathname === DSH_MUX_PATH,

  // Prompts, approvals, model and settings changes. Terminal keystrokes come over the socket, where every message
  // counts (an idle tab sends none).
  isUserAction(method, pathname) {
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
    return !PASSIVE_API.test(pathname);
  },

  generateCredential,

  containerEnv(credential) {
    return [`DSH_COOKIE_SECRET=${credential}`];
  },

  renderSettings(config, workspace) {
    return {
      [DSH_PATCH_FILE]: renderDshPatch({ catalog: fitDshModels(modelCatalog(config)), serviceBaseUrl: serviceBaseUrl(config, workspace.kind), browser: config.workspace.browser }),
      // image/start.sh makes it the AGENTS.md dsh reads for every session.
      [INSTRUCTIONS_FILE]: agentInstructions(config, workspace),
    };
  },

  signRequest(headers, endpoint, { origin }) {
    headers.host = DSH_AUTHORITY;
    headers.cookie = mintDshCookie(endpoint.credential);
    if (origin) headers.origin = `http://${DSH_AUTHORITY}`;
  },

  async probeReady(endpoint) {
    // Not "any answer": dsh's port answers 404 everywhere for a moment before its routes exist.
    return (await listSessions(endpoint)) !== null;
  },

  async fetchStatus(endpoint) {
    const sessions = await listSessions(endpoint);
    if (sessions === null) return null;
    for (const session of sessions.filter((candidate) => candidate.running)) {
      if (session.id === null || !(await waitsForPerson(endpoint, session.id))) return dshStatus(true);
    }
    const ids = jobSessionIds(sessions);
    if (ids.length === 0) return dshStatus(false);
    const jobs = await runningJobs(endpoint, ids);
    return jobs === null ? null : dshStatus(jobs > 0);
  },
};

function dshStatus(working: boolean): AgentStatus {
  return { working, idleSinceMs: null };
}

/** The parts of a `session/list` item the gateway uses. */
export interface DshSession {
  id: string | null;
  /** A turn is in progress, including one waiting for an approval or an answer; not background jobs. */
  running: boolean;
  /** Last prompt, ms since the epoch (0 if unknown). */
  updatedAt: number;
}

/** An RPC's result value (`{type: "server-response", result: {ok: true, value}}`); undefined if it failed. */
export function rpcValue(body: unknown): unknown {
  const result = field(body, "result");
  return field(result, "ok") === true ? field(result, "value") : undefined;
}

/** Reads `session/list`'s value; null when it is not one. */
export function parseSessionList(value: unknown): DshSession[] | null {
  const items = field(value, "items");
  if (!Array.isArray(items)) return null;
  return items.map((item) => {
    const id = field(item, "sessionId");
    const updatedAt = field(item, "updatedAt");
    return {
      id: typeof id === "string" && id !== "" ? id : null,
      running: field(item, "running") === true,
      updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0,
    };
  });
}

/** The sessions whose background jobs are checked: the most recently used ones. */
export function jobSessionIds(sessions: readonly DshSession[]): string[] {
  return sessions
    .filter((session): session is DshSession & { id: string } => session.id !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_JOB_SESSIONS)
    .map((session) => session.id);
}

/** `session/list`, with a freshly minted cookie; null when dsh doesn't answer it properly. */
async function listSessions(endpoint: AgentEndpoint): Promise<DshSession[] | null> {
  const body = await rpc(endpoint, "session/list", { _request: {} });
  return body === null ? null : parseSessionList(rpcValue(body));
}

/**
 * The session's turn is paused on the person: an approval or a question (`session/state`'s `pendingInput`). False
 * when dsh doesn't say, so the turn counts as work.
 */
async function waitsForPerson(endpoint: AgentEndpoint, sessionId: string): Promise<boolean> {
  const body = await rpc(endpoint, "session/state", { request: { sessionId } });
  return body !== null && pendingInput(rpcValue(body)).length > 0;
}

/** What a `session/state` value says the turn waits for (`approval`, `question`, …). */
export function pendingInput(value: unknown): string[] {
  const pending = field(value, "pendingInput");
  return Array.isArray(pending) ? pending.filter((item): item is string => typeof item === "string") : [];
}

/** One dsh RPC: the response body, or null on any failure (refused, not JSON, too large, too slow). */
function rpc(endpoint: AgentEndpoint, method: string, args: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({ type: "client-request", rpcId: `portal-${crypto.randomUUID()}`, method, payload: { args } });
  const headers = {
    host: DSH_AUTHORITY,
    cookie: mintDshCookie(endpoint.credential),
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    accept: "application/json",
  };
  return agentJson({ host: endpoint.host, port: endpoint.port, method: "POST", path: `/api/${method}`, headers }, MAX_API_BYTES, body);
}

/**
 * Running background jobs (`job/list`) of the given sessions, or null when dsh doesn't answer within
 * AGENT_TIMEOUT_MS. A stream, so it goes over the mux socket: one `open` per session, the first `item` of each (the
 * current rows), then `cancel`.
 */
function runningJobs(endpoint: AgentEndpoint, sessionIds: readonly string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const pending = new Map(sessionIds.map((id, index) => [String(index + 1), id]));
    let running = 0;
    let settled = false;
    const socket = new WebSocket(`ws://${endpoint.host}:${endpoint.port}${DSH_MUX_PATH}`, {
      headers: { host: DSH_AUTHORITY, cookie: mintDshCookie(endpoint.credential) },
      handshakeTimeout: AGENT_TIMEOUT_MS,
      maxPayload: MAX_API_BYTES,
      perMessageDeflate: false,
    });
    const finish = (result: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      if (result === null) socket.terminate();
      else socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), AGENT_TIMEOUT_MS);
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("open", () => {
      for (const [streamId, sessionId] of pending) {
        socket.send(JSON.stringify({ type: "open", streamId, endpoint: "job/list", payload: { args: { request: { sessionId } } } }));
      }
    });
    socket.on("message", (data) => {
      const frame = parseJson(data.toString());
      const streamId = field(frame, "streamId");
      if (typeof streamId !== "string" || !pending.has(streamId)) return;
      const jobs = parseJobRows(frame);
      if (jobs === null) return finish(null);
      running += jobs.filter((job) => job.running).length;
      pending.delete(streamId);
      socket.send(JSON.stringify({ type: "cancel", streamId }));
      if (pending.size === 0) finish(running);
    });
  });
}

/** The jobs in a `job/list` frame (`{type: "item", value: {type: "rows", jobs}}`); null for any other frame. */
export function parseJobRows(frame: unknown): Array<{ running: boolean }> | null {
  if (field(frame, "type") !== "item") return null;
  const value = field(frame, "value");
  const jobs = field(value, "jobs");
  if (field(value, "type") !== "rows" || !Array.isArray(jobs)) return null;
  return jobs.map((job) => ({ running: field(job, "status") === "running" }));
}
