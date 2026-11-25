// The seam between the portal and the agent harness a workspace runs (Qwen Code, DeepSeek Harness or OpenCode).
// Everything else (the container, its network and limits, sessions, the proxy's access checks, busy/idle rules) is
// the same for every harness; a driver supplies only what differs: how the container is started, how the gateway
// authenticates to the harness's web server and which paths and sockets it has, how the gateway learns that the
// harness is up and whether it is working, and where its releases come from. A harness's folder holds all of it: the
// driver, its settings renderer, its image files and what the shell scripts read (harness.env).
import type { AgentKind, WorkspaceKind } from "@portal/core";

export type HeaderMap = Record<string, string | string[]>;

/** What a driver reads of the gateway's configuration (the gateway's Config has all of it). */
export interface HarnessConfig {
  /** The admin's model list, in Qwen Code's settings format (models.ts); Qwen Code takes its own settings from it too. */
  modelsDir: string;
  /** The admin's own instructions for every agent (instructions.ts); the file need not exist. */
  instructionsFile: string;
  servicePort: number;
  idleTimeoutMs: number;
  /** The largest request body into a workspace, and the Web Shell's largest upload. */
  uploadLimitBytes: number;
  reader: { /** "": no read_page tool. */ url: string };
  workspace: {
    kinds: Record<WorkspaceKind, { /** The host's address on the kind's network, where the service API listens. */ gatewayIp: string }>;
    browser: boolean;
    /** What a new agent session starts with; null: each model's own defaultEffort. */
    defaultEffort: string | null;
  };
}

/** What the gateway knows of one workspace when it starts: its settings and its agent's instructions are rendered from it. */
export interface WorkspaceFacts {
  kind: WorkspaceKind;
  /** The full name of the person it belongs to. */
  person: string;
  /** Where the portal's server is, as its admin set it ("Florida, US"); null when not set. */
  place: string | null;
}

/** Where a running agent listens, and the per-start credential the gateway uses with it. */
export interface AgentEndpoint {
  host: string;
  port: number;
  credential: string;
}

/** Where a harness's releases come from and how its workspace image is checked. Its harness.env says the same to the shell scripts (index.test.ts compares them). */
interface AgentRelease {
  /** The npm package the image installs (and the registry is asked about). */
  readonly packageName: string;
  /** The .env key that holds the version, e.g. QWEN_CODE_VERSION. */
  readonly versionKey: string;
  /** What a fresh install builds when the key is not set. */
  readonly defaultVersion: string;
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
  /**
   * A token agent's UI can't set headers on a WebSocket, so it offers its bearer token as a subprotocol with this
   * prefix (base64url after it); absent for session agents.
   */
  readonly bearerSubprotocolPrefix?: string;
  /** Path prefixes the proxy refuses (canonical, lowercase): features that would hand out access to the container or that need the internet. */
  readonly blockedPrefixes: readonly string[];

  /** A WebSocket path the agent's UI uses; an upgrade on any other is refused. */
  isSocketPath(pathname: string): boolean;
  /** A request that means a person is using the workspace, as opposed to a poll or heartbeat. */
  isUserAction(method: string, pathname: string): boolean;
  /** A fresh random credential for one container start. */
  generateCredential(): string;
  /** The agent's own container environment, the credential included. */
  containerEnv(credential: string, config: HarnessConfig): string[];
  /**
   * The files of the settings directory (name → content) for a workspace: the admin's settings with the portal's
   * forced keys on top (its kind's service address among them), and the agent's instructions (instructions.ts).
   * Throws AgentConfigError when the admin's settings or instructions are unusable.
   */
  renderSettings(config: HarnessConfig, workspace: WorkspaceFacts): Record<string, string>;
  /**
   * Makes a forwarded request the agent's own: `headers` are the browser's as the proxy cleaned them (no Host, no
   * Origin, none of its cookies or credentials), and get the Host the agent expects and its credential. `authorised`
   * is false only for token agents when the browser presented no token (the page and its static assets); `origin`
   * says the browser sent an Origin, which the proxy checked.
   */
  signRequest(headers: HeaderMap, endpoint: AgentEndpoint, options: { authorised: boolean; origin: boolean }): void;
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
