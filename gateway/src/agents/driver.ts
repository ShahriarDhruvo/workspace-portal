// The seam between the gateway and the agent harness a workspace runs (Qwen Code or DeepSeek
// Harness). Everything else (the container, its network and limits, sessions, the proxy's access
// checks, busy/idle rules) is the same for every agent; a driver supplies only what differs:
//   * how the container is started: port, env, the read-only settings it mounts (the image comes from
//     the agent's current version, agent-versions.ts);
//   * how the gateway authenticates to the agent's web server, and which paths and sockets it has;
//   * how the gateway learns that the agent is up and whether it is working;
//   * where its releases come from, so the admin can update it (release).
import type { IncomingHttpHeaders } from "node:http";
import type { AgentKind, WorkspaceKind } from "@portal/db";
import type { Config } from "../config.ts";
import type { HeaderMap } from "../headers.ts";

/**
 * Name of the env var holding the placeholder LLM key in every workspace. The gateway's LLM proxy
 * replaces it with the real key, which never enters a workspace.
 */
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

/** Where a running agent listens, and the per-start credential the gateway uses with it. */
export interface AgentEndpoint {
  host: string;
  port: number;
  credential: string;
}

/**
 * How the browser's requests are authorised, on top of the portal session and the port's user,
 * which the proxy checks for every agent:
 *   * "token": the agent's UI sends a bearer token; the browser holds a session-bound token
 *     (agentBrowserToken) that the gateway checks and swaps for the container's credential.
 *   * "cookie": the agent's UI relies on a cookie; the gateway adds the container's credential to
 *     every request itself and never lets the browser hold it.
 */
export type BrowserAuth = "token" | "cookie";

/**
 * Where an agent's releases come from and how its workspace image is built and checked. deploy/lib.sh
 * keeps its own copy of the key (agent_version_key) and the CLI (image_agent_version).
 */
export interface AgentRelease {
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
  /** Mount point of the per-user settings directory rendered by renderSettings (read-only). */
  readonly settingsMount: string;
  readonly browserAuth: BrowserAuth;
  /** WebSocket paths the agent's UI uses; any other upgrade is refused. */
  readonly socketPaths: ReadonlySet<string>;
  /**
   * Path prefixes the proxy refuses (canonical, lowercase): features that would hand out access to
   * the container or that need the internet.
   */
  readonly blockedPrefixes: readonly string[];

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
   * Headers for a request forwarded to the agent, from the browser's. `authorised` is false only for
   * token agents when the browser presented no token (the page and its static assets).
   */
  requestHeaders(incoming: IncomingHttpHeaders, endpoint: AgentEndpoint, options: { authorised: boolean; websocket?: boolean }): HeaderMap;
  /** The agent is up and can take prompts. */
  probeReady(endpoint: AgentEndpoint): Promise<boolean>;
  /** What the agent reports about its work; null when it didn't answer. */
  fetchStatus(endpoint: AgentEndpoint): Promise<AgentStatus | null>;
}

export interface AgentStatus {
  /** A turn, a tool, a subagent, a background task or a pending approval is in progress. */
  working: boolean;
  /** How long ago the agent last started or finished something, when it reports that; else null. */
  idleSinceMs: number | null;
}
