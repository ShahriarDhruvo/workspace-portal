// The Qwen Code driver: `qwen serve` (the Web Shell) in a workspace container.
//   * Auth: a bearer token, random per start (QWEN_SERVER_TOKEN). The Web Shell sends a token on every API call and
//     socket; the browser holds only the session-bound agentBrowserToken.
//   * Readiness and "is the agent working?": `GET /health?deep=1`. Readiness also asks `GET /daemon/status` when the
//     daemon is up without its agent process (see probeReady).
//   * Settings: settings.json and system-defaults.json, mounted where the image's QWEN_CODE_SYSTEM_SETTINGS_PATH /
//     QWEN_CODE_SYSTEM_DEFAULTS_PATH point.
import { AGENT_NAMES } from "@portal/core";
import { workspaceRequestHeaders } from "../proxy/headers.ts";
import { agentJson, generateCredential, type AgentDriver, type AgentEndpoint } from "./driver.ts";
import { field, isRecord } from "../lib/json.ts";
import { qwenSettingsFor } from "./qwen-settings.ts";

const QWEN_SOCKET_PATHS: ReadonlySet<string> = new Set(["/terminal", "/acp", "/live/web"]);
const MAX_HEALTH_BYTES = 64 * 1024;
/** `/daemon/status` lists every capability of the daemon: about 107 KB in Qwen Code 0.27.0. */
const MAX_STATUS_BYTES = 1024 * 1024;

/** The parts of `GET /health?deep=1` the gateway uses. All figures cover every session of the daemon. */
export interface QwenHealth {
  activePrompts: number;
  pendingPermissions: number;
  /** Agent, subagent, shell, background task or tool work the agent process reports as running. */
  activeWork: boolean;
  /** The agent process is running. The daemon stops it when no session is open and starts it for the next one. */
  channelAlive: boolean;
  /** Time since the agent last started or finished something; null before the first session. */
  idleSinceMs: number | null;
}

export function parseQwenHealth(body: unknown): QwenHealth | null {
  if (!isRecord(body) || body.status !== "ok") return null;
  const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const idle = body.idleSinceMs;
  return {
    activePrompts: count(body.activePrompts),
    pendingPermissions: count(body.pendingPermissions),
    activeWork: body.activeWork === true,
    channelAlive: body.channelAlive === true,
    idleSinceMs: typeof idle === "number" && Number.isFinite(idle) && idle >= 0 ? idle : null,
  };
}

/** The JSON a workspace's daemon answers a GET with; null when it does not answer with 200 and JSON of at most `maxBytes`. */
function getJson({ host, port, credential }: AgentEndpoint, path: string, maxBytes: number): Promise<unknown> {
  return agentJson({ host, port, path, headers: { authorization: `Bearer ${credential}`, accept: "application/json" } }, maxBytes);
}

/** Reads `/health?deep=1` from a workspace; null when it does not answer or answers oddly. */
export async function fetchQwenHealth(endpoint: AgentEndpoint): Promise<QwenHealth | null> {
  return parseQwenHealth(await getJson(endpoint, "/health?deep=1", MAX_HEALTH_BYTES));
}

/** True when `GET /daemon/status` says the daemon's first start of its agent process went through (`daemon.startup.preheat.status`). */
export function parseQwenStarted(body: unknown): boolean {
  return field(field(field(field(body, "daemon"), "startup"), "preheat"), "status") === "succeeded";
}

/**
 * The agent is doing something: a prompt, a tool, a subagent, a background task, or an approval it waits for. An
 * approval nobody answers needs no special case: `qwen serve` declines it after --permission-response-timeout-ms,
 * which the gateway sets to the idle timeout.
 */
export function agentWorking(health: QwenHealth): boolean {
  return health.activePrompts > 0 || health.pendingPermissions > 0 || health.activeWork;
}

export const qwenDriver: AgentDriver = {
  kind: "qwen",
  name: AGENT_NAMES.qwen,
  description: "Qwen Code's Web Shell: chat, files, terminal and a headless browser.",
  release: { packageName: "@qwen-code/qwen-code", versionKey: "QWEN_CODE_VERSION", cli: "qwen" },
  // See workspace-image/start-qwen.sh.
  port: 4170,
  credentialEnv: "QWEN_SERVER_TOKEN",
  settingsMount: "/etc/workspace-portal/qwen",
  browserAuth: "token",
  // Device pairing would hand a browser the container's real token.
  blockedPrefixes: ["/web-shell/pairing"],

  isSocketPath: (pathname) => QWEN_SOCKET_PATHS.has(pathname),

  // The Web Shell polls several endpoints and sends heartbeats while a tab is merely open.
  isUserAction(method, pathname) {
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
    return !pathname.endsWith("/heartbeat");
  },

  generateCredential,

  containerEnv(credential, config) {
    return [
      `QWEN_SERVER_TOKEN=${credential}`,
      "QWEN_USAGE_STATISTICS_ENABLED=false",
      // An approval nobody answers is declined after this long, so it can't keep the workspace up forever.
      `QWEN_PERMISSION_TIMEOUT_MS=${config.idleTimeoutMs}`,
      // The Web Shell's upload limit (workspace-image/qwen/trim-web-shell.mjs), the same as the gateway's.
      `WORKSPACE_PORTAL_UPLOAD_LIMIT_BYTES=${config.uploadLimitBytes}`,
    ];
  },

  renderSettings(config, kind) {
    const rendered = qwenSettingsFor(config, kind);
    return {
      "settings.json": `${JSON.stringify(rendered.settings, null, 2)}\n`,
      "system-defaults.json": `${JSON.stringify(rendered.systemDefaults, null, 2)}\n`,
    };
  },

  // `qwen serve` checks Host and Origin itself: Host is its own address and Origin is dropped (the gateway checked
  // the browser's). Its token goes only on requests that presented the browser's.
  requestHeaders(incoming, endpoint, { authorised, websocket }) {
    const headers = workspaceRequestHeaders(incoming, `${endpoint.host}:${endpoint.port}`, { websocket });
    if (authorised) headers.authorization = `Bearer ${endpoint.credential}`;
    return headers;
  },

  async probeReady(endpoint) {
    const health = await fetchQwenHealth(endpoint);
    if (health === null) return false;
    if (health.channelAlive) return true;
    // No agent process. While a workspace starts that means "not yet". Later it is how an unused workspace looks:
    // `qwen serve` stops the process once no session is open and starts it again for the next one. Such a workspace
    // must count as ready when the gateway restarts and takes it over, or it would be removed as one that never came up.
    return parseQwenStarted(await getJson(endpoint, "/daemon/status", MAX_STATUS_BYTES));
  },

  async fetchStatus(endpoint) {
    const health = await fetchQwenHealth(endpoint);
    return health === null ? null : { working: agentWorking(health), idleSinceMs: health.idleSinceMs };
  },
};
