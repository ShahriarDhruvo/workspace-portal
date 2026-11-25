// The OpenCode driver: `opencode serve` (OpenCode 2's web UI and API on one port) in a workspace container
// (image/start.sh).
//   * Auth: HTTP Basic, user "opencode", with a password that is random per start (OPENCODE_PASSWORD). The gateway
//     adds it to every request it forwards; the browser never holds it and is never asked for it, because no request
//     reaches OpenCode's API without it: the proxy's session, port and Origin checks are what authorise the browser
//     (browserAuth "session").
//   * OpenCode refuses a terminal socket, and the ticket its UI fetches for one, from an Origin that is not its own
//     address. The gateway has checked the browser's Origin and passes none on, which OpenCode accepts.
//   * Its API: plain HTTP routes under /api, an event stream, and one WebSocket per terminal.
//   * Readiness: `GET /api/info`. Working: a session runs a turn (`GET /api/session/active`, for every project folder
//     at once), unless the turn only waits for the person: an approval or a question
//     (`GET /api/session/<id>/permission`, `/form`), which OpenCode leaves open (minutes later it still waits) and
//     which must not keep a workspace nobody uses running. A subagent is a session of its own, the one its approvals
//     are asked in, and the session that started it does not run while it only waits for it. A command a turn left
//     running in the background is work too, though its session no longer runs (`GET /api/experimental/job`).
//     OpenCode reports no time of last activity, so the gateway times the end of the work itself.
//   * Settings: opencode.json in OpenCode's directory for managed settings, which names the instructions file
//     beside it (settings.ts).
import { AGENT_NAMES, field } from "@portal/core";
import type { AgentDriver, AgentEndpoint, AgentStatus } from "../harness.ts";
import { agentInstructions, INSTRUCTIONS_FILE } from "../instructions.ts";
import { modelCatalog } from "../models.ts";
import { agentJson, generateCredential, serviceBaseUrl } from "../shared.ts";
import { OPENCODE_CONFIG_FILE, OPENCODE_SETTINGS_DIR, renderOpencodeConfig } from "./settings.ts";

/** OpenCode's fixed user name for its HTTP sign-in. */
const OPENCODE_USER = "opencode";
/**
 * A terminal's socket, the only one OpenCode's page opens: a persistent terminal, which outlives a reload of the page
 * (ids such as pty_persistent_5005401935434722).
 */
const TERMINAL_SOCKET = /^\/api\/experimental\/persistent-pty\/[\w-]+\/connect$/;
/**
 * What OpenCode's UI sends without anyone acting, as "METHOD path": a terminal's ticket when its socket (re)connects,
 * the note that the open tab has seen a turn end, and what it reads again when it loads. An idle tab otherwise only
 * reads.
 */
const PASSIVE_API = new RegExp(
  `^(?:${[
    "POST /api/experimental/persistent-pty/[^/]+/connect-token",
    "POST /api/session/[^/]+/view",
    "POST /api/worktree/refresh",
    "POST /api/rpc/[^/]+/get",
  ].join("|")})$`,
);
/** An answer lists the running sessions, one session's pending requests, or the background jobs: small, but bounded. */
const MAX_API_BYTES = 1024 * 1024;
/** Running sessions asked about per status check; with more than these running, the workspace is working. */
const MAX_RUNNING = 16;
const WORKING: AgentStatus = { working: true, idleSinceMs: null };

export function opencodeAuthorization(password: string): string {
  return `Basic ${Buffer.from(`${OPENCODE_USER}:${password}`).toString("base64")}`;
}

export const opencodeDriver: AgentDriver = {
  kind: "opencode",
  name: AGENT_NAMES.opencode,
  description: "OpenCode's web UI: chat, projects, files, terminal and a headless browser.",
  release: { packageName: "@opencode/cli", versionKey: "OPENCODE_VERSION", defaultVersion: "2.4.1", cli: "opencode" },
  port: 4096,
  credentialEnv: "OPENCODE_PASSWORD",
  settingsMount: OPENCODE_SETTINGS_DIR,
  browserAuth: "session",
  // Pairing hands another browser or app a session of its own, outside the portal's; a remote machine's link takes
  // no password at all.
  blockedPrefixes: ["/api/pair", "/auth/connect", "/api/experimental/machine"],

  isSocketPath: (pathname) => TERMINAL_SOCKET.test(pathname),

  // Prompts, approvals, new sessions and terminals, settings. Terminal keystrokes come over the socket, where every
  // message counts (an idle tab sends none).
  isUserAction(method, pathname) {
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
    return !PASSIVE_API.test(`${method} ${pathname}`);
  },

  generateCredential,

  containerEnv(credential) {
    return [`OPENCODE_PASSWORD=${credential}`];
  },

  renderSettings(config, kind) {
    return {
      [OPENCODE_CONFIG_FILE]: renderOpencodeConfig({ catalog: modelCatalog(config), serviceBaseUrl: serviceBaseUrl(config, kind), browser: config.workspace.browser }),
      [INSTRUCTIONS_FILE]: agentInstructions(config, kind),
    };
  },

  signRequest(headers, endpoint) {
    headers.host = `${endpoint.host}:${endpoint.port}`;
    headers.authorization = opencodeAuthorization(endpoint.credential);
  },

  async probeReady(endpoint) {
    return typeof field(await get(endpoint, "/api/info"), "version") === "string";
  },

  async fetchStatus(endpoint) {
    const running = parseRunningSessions(await get(endpoint, "/api/session/active"));
    if (running === null) return null;
    if (running.length > MAX_RUNNING) return WORKING;
    // A session that did not say what it waits for (it ended meanwhile, say) must not hide one that works.
    let unknown = false;
    for (const id of running) {
      const session = `/api/session/${encodeURIComponent(id)}`;
      const asked = await Promise.all([get(endpoint, `${session}/permission`), get(endpoint, `${session}/form`)]);
      const pending = asked.map(parsePendingCount);
      if (pending.includes(null)) unknown = true;
      else if (pending.every((count) => count === 0)) return WORKING;
    }
    const jobs = parseRunningJobs(await get(endpoint, "/api/experimental/job"));
    if (jobs !== null && jobs > 0) return WORKING;
    return unknown || jobs === null ? null : { working: false, idleSinceMs: null };
  },
};

/** One GET of OpenCode's API: the JSON of a 200, or null on any failure. */
function get(endpoint: AgentEndpoint, path: string): Promise<unknown> {
  const headers = { authorization: opencodeAuthorization(endpoint.credential), accept: "application/json" };
  return agentJson({ host: endpoint.host, port: endpoint.port, path, headers }, MAX_API_BYTES);
}

/** The sessions of a `GET /api/session/active` answer, which lists those that run a turn; null when it is not one. */
export function parseRunningSessions(body: unknown): string[] | null {
  const sessions = field(body, "data");
  if (typeof sessions !== "object" || sessions === null || Array.isArray(sessions)) return null;
  return Object.keys(sessions);
}

/**
 * How many requests of a `GET /api/session/<id>/permission` or `/form` answer wait for the person (approvals,
 * questions); null when it is no such list.
 */
export function parsePendingCount(body: unknown): number | null {
  const requests = field(body, "data");
  return Array.isArray(requests) ? requests.length : null;
}

/**
 * How many background jobs of a `GET /api/experimental/job` answer still run; null when it is no such list. A
 * subagent is listed as a job as well: it is a session, counted as one, with what it waits for.
 */
export function parseRunningJobs(body: unknown): number | null {
  const jobs = field(body, "data");
  if (!Array.isArray(jobs)) return null;
  return jobs.filter((job) => field(job, "status") === "running" && field(job, "kind") !== "subagent").length;
}
