// The seam between the gateway and the agent harness a workspace runs (Qwen Code, DeepSeek Harness or OpenCode).
// Everything else (the container, its network and limits, sessions, the proxy's access checks, busy/idle rules) is
// the same for every agent; a driver supplies only what differs: how the container is started, how the gateway
// authenticates to the agent's web server and which paths and sockets it has, how the gateway learns that the agent
// is up and whether it is working, and where its releases come from.
import crypto from "node:crypto";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AgentKind, WorkspaceKind } from "@portal/core";
import { readBounded } from "../lib/bounded-body.ts";
import { parseJson } from "../lib/json.ts";
import type { Config } from "../config.ts";
import type { HeaderMap } from "../proxy/headers.ts";

/** The env var holding the placeholder LLM key in every workspace. The gateway's LLM proxy replaces it with the real key, which never enters a workspace. */
export const LLM_KEY_ENV = "PORTAL_LLM_KEY";

/** The admin's settings for an agent are unusable; the start fails with this message. */
export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

/**
 * The gateway's service API (model + search) as a workspace of `kind` reaches it: the host's address on that kind's
 * network, where the gateway answers only that kind's containers. A Private workspace can reach nothing else.
 */
export function serviceBaseUrl(config: Config, kind: WorkspaceKind): string {
  return `http://${config.workspace.kinds[kind].gatewayIp}:${config.servicePort}`;
}

/** The headless browser as an MCP server. dsh gives MCP children a scrubbed environment, so the browser's path goes on the command line. */
export const BROWSER_MCP = {
  command: "/usr/local/bin/playwright-mcp",
  args: ["--headless", "--isolated", "--no-sandbox", "--executable-path=/usr/bin/chromium", "--output-dir=/workspace/.browser"],
} as const;
/** How long one call of a browser or search tool may take. */
export const BROWSER_TIMEOUT_MS = 120_000;
export const SEARCH_TIMEOUT_MS = 60_000;
/**
 * An agent's own limits on a model request, where its settings take them: as long as Qwen Code's
 * (generationConfig.timeout and streamIdleTimeoutMs in qwen-config/system-defaults.json), because a request may wait
 * in the gateway's queue.
 */
export const LLM_TIMEOUT_MS = 3_600_000;

/** Where a running agent listens, and the per-start credential the gateway uses with it. */
export interface AgentEndpoint {
  host: string;
  port: number;
  credential: string;
}

/** Where an agent's releases come from and how its workspace image is built and checked. deploy/lib.sh keeps its own copy of the key and the CLI. */
interface AgentRelease {
  /** The npm package the image installs (and the registry is asked about). */
  readonly packageName: string;
  /** The .env key and Dockerfile build argument that hold the version, e.g. QWEN_CODE_VERSION. */
  readonly versionKey: string;
  /** The image's CLI that reports the installed version with `--version`. */
  readonly cli: string;
}

export interface AgentDriver {
  readonly kind: AgentKind;
  /** Display name, e.g. "Qwen Code". */
  readonly name: string;
  readonly description: string;
  readonly release: AgentRelease;
  /** TCP port of the agent's web server on the container's own address. */
  readonly port: number;
  /** Env var carrying the per-start credential; read back when adopting a running container. */
  readonly credentialEnv: string;
  /** Mount point of the workspace's settings directory, rendered by renderSettings (read-only). */
  readonly settingsMount: string;
  /**
   * How the browser's requests are authorised, on top of the portal session and the port's user, which the proxy
   * checks for every agent. "token": the agent's UI sends a bearer token; the browser holds a session-bound token
   * (agentBrowserToken) that the gateway checks and swaps for the container's credential. "session": the agent's UI
   * sends nothing of its own that the gateway could check (it relies on a cookie, or on the browser's HTTP sign-in);
   * the gateway adds the container's credential to every request and the browser never holds it.
   */
  readonly browserAuth: "token" | "session";
  /** Path prefixes the proxy refuses (canonical, lowercase): features that would hand out access to the container or that need the internet. */
  readonly blockedPrefixes: readonly string[];

  /** A WebSocket path the agent's UI uses; an upgrade on any other is refused. */
  isSocketPath(pathname: string): boolean;
  /** A request that means a person is using the workspace, as opposed to a poll or heartbeat. */
  isUserAction(method: string, pathname: string): boolean;
  /** A fresh random credential for one container start. */
  generateCredential(): string;
  /** The agent's own container environment, the credential included. */
  containerEnv(credential: string, config: Config): string[];
  /**
   * The files of the settings directory (name → content) for a workspace of `kind`, from the admin's settings with
   * the portal's forced keys on top (that kind's service address among them). Throws AgentConfigError when the
   * admin's settings are unusable.
   */
  renderSettings(config: Config, kind: WorkspaceKind): Record<string, string>;
  /**
   * Headers for a request forwarded to the agent, from the browser's. `authorised` is false only for token agents
   * when the browser presented no token (the page and its static assets).
   */
  requestHeaders(incoming: IncomingHttpHeaders, endpoint: AgentEndpoint, options: { authorised: boolean; websocket?: boolean }): HeaderMap;
  /** The agent is up and can take prompts. */
  probeReady(endpoint: AgentEndpoint): Promise<boolean>;
  /** What the agent reports about its work; null when it didn't answer. */
  fetchStatus(endpoint: AgentEndpoint): Promise<AgentStatus | null>;
}

export interface AgentStatus {
  /**
   * A turn, a tool, a subagent or a background task is in progress. A turn that only waits for the person (an
   * approval, a question) is work for Qwen Code, which declines it in time, and none for the agents that leave it open.
   */
  working: boolean;
  /** How long ago the agent last started or finished something, when it reports that; else null. */
  idleSinceMs: number | null;
}

/** 32 random bytes: also the form of dsh's own browser-session secrets (start-dsh checks it). */
export const generateCredential = (): string => crypto.randomBytes(32).toString("base64url");

/** How long the gateway waits for an agent's answer about itself. */
export const AGENT_TIMEOUT_MS = 3_000;

/**
 * JSON from a workspace's agent over HTTP: the body of a 200, or null on any failure (refused, not JSON, longer than
 * `maxBytes`, no answer within AGENT_TIMEOUT_MS). `body` is what a POST sends.
 */
export function agentJson(options: http.RequestOptions, maxBytes: number, body?: string): Promise<unknown> {
  return new Promise((resolve) => {
    const request = http.request({ ...options, agent: false, timeout: AGENT_TIMEOUT_MS }, (response) => {
      readBounded(response, maxBytes).then(
        (bytes) => resolve(response.statusCode === 200 && bytes !== null ? parseJson(bytes.toString("utf8")) : null),
        () => resolve(null),
      );
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
    request.end(body);
  });
}
