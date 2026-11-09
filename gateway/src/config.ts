// Gateway configuration, read once from the environment (docker compose passes the repo's .env).
// Defaults match .env.example; docs/ARCHITECTURE.md documents every variable.
import net from "node:net";
import path from "node:path";

export interface WorkspaceConfig {
  image: string;
  /** Docker *internal* network: workspaces can reach the gateway's bridge address and nothing else. */
  network: string;
  subnet: string;
  gatewayIp: string;
  ipRange: string;
  bridge: string;
  /** Workspace of user N runs as UID/GID uidBase + N, which owns that user's directories only. */
  uidBase: number;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  shmBytes: number;
  /** Size of the in-memory /tmp (the root filesystem is read-only). */
  tmpBytes: number;
  /** Offer the headless browser (Playwright MCP); it can only open pages served inside the workspace. */
  browser: boolean;
}

export interface SearchConfig {
  /** SearXNG base URL as the gateway reaches it; its /search must allow format=json. */
  url: string;
  /** Optional Authorization header value for instances behind auth ("Basic …", "Bearer …"). */
  authorization: string;
  timeoutMs: number;
  maxConcurrentPerUser: number;
}

export interface Config {
  /** Host path of the portal data, mounted at the same path inside the gateway container. */
  dataDir: string;
  dbFile: string;
  /** Admin-provided Qwen Code settings (settings.json, system-defaults.json), applied to every workspace. */
  qwenConfigDir: string;
  webPort: number;
  agentBind: string;
  /** User N's workspace is served on port agentPortBase + N (1 <= N < agentPortCount). */
  agentPortBase: number;
  agentPortCount: number;
  controlPort: number;
  servicePort: number;
  controlSecret: string;
  llm: {
    upstreamUrl: string;
    apiKey: string;
    maxConcurrency: number;
    maxConcurrencyPerUser: number;
  };
  search: SearchConfig;
  workspace: WorkspaceConfig;
  maxRunning: number;
  idleTimeoutMs: number;
  /**
   * A working agent keeps its workspace up for at most this long after the last thing a person did
   * in it (a safety net for stuck agents); 0 means no limit.
   */
  maxBusyMs: number;
  uploadLimitBytes: number;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid gateway configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const MIN_SECRET_LENGTH = 16;
export const MIB = 1024 * 1024;
/** Workspace UIDs stay clear of system and human accounts and below the 32-bit limit. */
const MIN_UID_BASE = 100_000;

const BYTE_UNITS: Record<string, number> = { "": 1, k: 1024, m: MIB, g: 1024 * MIB };

/** Parses a Docker-style size such as `1536m`, `2g`, `512k` or `1048576` (binary units). */
export function parseByteSize(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(text.trim());
  if (!match) return null;
  const bytes = Math.floor(Number(match[1]) * BYTE_UNITS[match[2]!.toLowerCase()]!);
  return bytes > 0 && Number.isSafeInteger(bytes) ? bytes : null;
}

/** Reads and validates the gateway configuration. Throws ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const read = new EnvReader(env);

  const dataDir = read.absolutePath("PORTAL_DATA_DIR", "/srv/workspace-portal");

  const config: Config = {
    dataDir,
    dbFile: path.join(dataDir, "db", "portal.sqlite"),
    qwenConfigDir: path.join(dataDir, "config", "qwen"),
    webPort: read.port("WEB_PORT", 3000),
    agentBind: read.ip("AGENT_BIND", "0.0.0.0"),
    agentPortBase: read.port("AGENT_PORT_BASE", 3100),
    agentPortCount: read.int("AGENT_PORT_COUNT", 200, 2),
    controlPort: read.port("CONTROL_PORT", 4002),
    servicePort: read.port("SERVICE_PORT", 4001),
    controlSecret: read.secret("GATEWAY_CONTROL_SECRET"),
    llm: {
      upstreamUrl: read.httpUrl("LLM_UPSTREAM_URL", "http://127.0.0.1:8080"),
      apiKey: read.string("LLM_API_KEY", ""),
      maxConcurrency: read.int("LLM_MAX_CONCURRENCY", 3, 1),
      maxConcurrencyPerUser: read.int("LLM_MAX_CONCURRENCY_PER_USER", 2, 1),
    },
    search: {
      url: read.httpUrl("SEARXNG_URL", "http://127.0.0.1:8888"),
      authorization: read.string("SEARXNG_AUTHORIZATION", ""),
      timeoutMs: read.int("SEARXNG_TIMEOUT_SECONDS", 20, 1) * 1000,
      maxConcurrentPerUser: read.int("SEARCH_MAX_CONCURRENT_PER_USER", 2, 1),
    },
    workspace: {
      image: read.nonEmpty("WORKSPACE_IMAGE", "workspace-portal/workspace:qwen-0.27.0"),
      network: read.nonEmpty("WORKSPACE_NETWORK", "workspace-portal-ws"),
      subnet: read.cidr("WORKSPACE_SUBNET", "172.29.0.0/16"),
      gatewayIp: read.ipv4("WORKSPACE_GATEWAY_IP", "172.29.0.1"),
      ipRange: read.cidr("WORKSPACE_IP_RANGE", "172.29.128.0/17"),
      bridge: read.nonEmpty("WORKSPACE_BRIDGE", "br-wportal"),
      uidBase: read.int("WORKSPACE_UID_BASE", 200_000, MIN_UID_BASE),
      memoryBytes: read.byteSize("WORKSPACE_MEMORY", "3g"),
      nanoCpus: Math.round(read.positiveNumber("WORKSPACE_CPUS", 4) * 1e9),
      pidsLimit: read.int("WORKSPACE_PIDS", 1024, 1),
      shmBytes: read.byteSize("WORKSPACE_SHM", "1g"),
      tmpBytes: read.byteSize("WORKSPACE_TMP", "1g"),
      browser: read.bool("WORKSPACE_BROWSER", true),
    },
    maxRunning: read.int("MAX_RUNNING_WORKSPACES", 4, 1),
    idleTimeoutMs: read.int("IDLE_TIMEOUT_MINUTES", 30, 1) * 60_000,
    maxBusyMs: read.int("MAX_BUSY_HOURS", 24, 0) * 3_600_000,
    uploadLimitBytes: read.int("UPLOAD_LIMIT_MB", 100, 1) * MIB,
  };

  if (config.search.authorization.includes("\n") || config.search.authorization.includes("\r")) {
    read.problems.push("SEARXNG_AUTHORIZATION must be a single header value");
  }
  if (config.agentPortBase + config.agentPortCount - 1 > 65535) {
    read.problems.push(`AGENT_PORT_BASE + AGENT_PORT_COUNT must stay below 65536 (got ${config.agentPortBase} + ${config.agentPortCount})`);
  }
  const ports = [config.webPort, config.controlPort, config.servicePort];
  if (ports.some((port) => port > config.agentPortBase && port < config.agentPortBase + config.agentPortCount)) {
    read.problems.push("WEB_PORT, CONTROL_PORT and SERVICE_PORT must lie outside the workspace port range (AGENT_PORT_BASE + 1 … AGENT_PORT_BASE + AGENT_PORT_COUNT - 1)");
  }
  if (read.problems.length > 0) throw new ConfigError(read.problems);
  return config;
}

/** Typed accessors over the environment that collect problems instead of throwing at the first one. */
class EnvReader {
  readonly problems: string[] = [];
  readonly #env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv) {
    this.#env = env;
  }

  string(name: string, fallback: string): string {
    return this.#env[name]?.trim() ?? fallback;
  }

  nonEmpty(name: string, fallback: string): string {
    const value = this.#env[name]?.trim();
    return value ? value : fallback;
  }

  secret(name: string): string {
    const value = this.string(name, "");
    if (value.length === 0) this.problems.push(`${name} is required (deploy/install.sh generates it in .env)`);
    else if (value.length < MIN_SECRET_LENGTH) this.problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    return value;
  }

  int(name: string, fallback: number, min: number): number {
    const raw = this.nonEmpty(name, String(fallback));
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min) {
      this.problems.push(`${name} must be an integer >= ${min} (got "${raw}")`);
      return fallback;
    }
    return value;
  }

  port(name: string, fallback: number): number {
    const value = this.int(name, fallback, 1);
    if (value > 65535) {
      this.problems.push(`${name} must be a TCP port (got ${value})`);
      return fallback;
    }
    return value;
  }

  positiveNumber(name: string, fallback: number): number {
    const raw = this.nonEmpty(name, String(fallback));
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      this.problems.push(`${name} must be a positive number (got "${raw}")`);
      return fallback;
    }
    return value;
  }

  bool(name: string, fallback: boolean): boolean {
    const raw = this.nonEmpty(name, String(fallback)).toLowerCase();
    if (["true", "1", "yes", "on"].includes(raw)) return true;
    if (["false", "0", "no", "off"].includes(raw)) return false;
    this.problems.push(`${name} must be true or false (got "${raw}")`);
    return fallback;
  }

  byteSize(name: string, fallback: string): number {
    const raw = this.nonEmpty(name, fallback);
    const value = parseByteSize(raw);
    if (value === null) {
      this.problems.push(`${name} must be a size such as 1536m or 2g (got "${raw}")`);
      return parseByteSize(fallback)!;
    }
    return value;
  }

  absolutePath(name: string, fallback: string): string {
    const value = this.nonEmpty(name, fallback);
    if (!path.isAbsolute(value)) this.problems.push(`${name} must be an absolute path (got "${value}")`);
    return path.resolve(value);
  }

  httpUrl(name: string, fallback: string): string {
    const value = this.nonEmpty(name, fallback);
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") return value.replace(/\/+$/, "");
    } catch {
      // reported below
    }
    this.problems.push(`${name} must be an http(s) URL (got "${value}")`);
    return fallback;
  }

  ip(name: string, fallback: string): string {
    const value = this.nonEmpty(name, fallback);
    if (net.isIP(value) === 0) this.problems.push(`${name} must be an IP address (got "${value}")`);
    return value;
  }

  ipv4(name: string, fallback: string): string {
    const value = this.nonEmpty(name, fallback);
    if (!net.isIPv4(value)) this.problems.push(`${name} must be an IPv4 address (got "${value}")`);
    return value;
  }

  cidr(name: string, fallback: string): string {
    const value = this.nonEmpty(name, fallback);
    const [address, bits, extra] = value.split("/");
    const prefix = Number(bits);
    if (extra !== undefined || !net.isIPv4(address ?? "") || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      this.problems.push(`${name} must be an IPv4 CIDR such as 172.29.0.0/16 (got "${value}")`);
    }
    return value;
  }
}
