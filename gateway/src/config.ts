// Gateway configuration, read once from the environment (docker compose passes the repo's .env).
// Defaults match .env.example; docs/ARCHITECTURE.md documents every variable.
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_KINDS, isAgentKind, WORKSPACE_KINDS, type AgentKind, type WorkspaceKind } from "@portal/db";
import { isVersion } from "./versions.ts";

/**
 * What one kind of workspace (Private, Online) has to itself: its Docker network, its UID range and its agent port
 * range. Nothing here is shared with the other kind, so a user's two workspaces can't reach or read each other.
 */
export interface KindConfig {
  kind: WorkspaceKind;
  /**
   * The kind's Docker network. Private: internal (no route off the host); its only reachable address is the
   * gateway's service port. Online: a bridge with NAT to the internet; deploy/firewall.sh lets it reach public
   * addresses (any TCP port, DNS to `dns`) and the gateway's service port, nothing else.
   */
  network: string;
  subnet: string;
  /** The host's address on the network: the service API listens here for this kind's containers. */
  gatewayIp: string;
  ipRange: string;
  bridge: string;
  /** User N's workspace of this kind runs as UID/GID uidBase + N, which owns that user's directories of this kind only. */
  uidBase: number;
  /** User N's workspace of this kind is served on port agentPortBase + N (1 <= N < agentPortCount). */
  agentPortBase: number;
  /** The DNS servers its containers use (Online; ONLINE_DNS_1/2). Empty for Private, whose internal network has none. */
  dns: readonly string[];
}

export interface WorkspaceConfig {
  /** The agents users may choose from, in display order (WORKSPACE_AGENTS). */
  agents: readonly AgentKind[];
  /**
   * Each agent's default version (QWEN_CODE_VERSION, DSH_VERSION; the keys are the drivers'
   * release.versionKey): what a fresh install builds. The version new workspaces start with is the
   * admin's current choice, which agent-versions.ts keeps, falling back to these.
   */
  defaultVersions: Readonly<Record<AgentKind, string>>;
  /** Each kind's network, UIDs and agent ports (Private: WORKSPACE_*, AGENT_PORT_BASE; Online: ONLINE_*). */
  kinds: Record<WorkspaceKind, KindConfig>;
  /**
   * ONLINE_WORKSPACES: Online workspaces exist on this portal. Off: no online network, no online service listener,
   * online starts are refused, and an Online container found running is stopped.
   */
  onlineEnabled: boolean;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  shmBytes: number;
  /** Size of the in-memory /tmp (the root filesystem is read-only). */
  tmpBytes: number;
  /** Offer the headless browser (Playwright MCP); it can only open pages served inside the workspace. */
  browser: boolean;
  /**
   * The reasoning effort every new agent session starts with, for models that offer it
   * (DEFAULT_REASONING_EFFORT; null = "model": the admin's defaultEffort). A person may change it within
   * a session; the next session starts here again.
   */
  defaultEffort: string | null;
}

export interface SearchConfig {
  /** SearXNG base URL as the gateway reaches it; its /search must allow format=json. */
  url: string;
  /** Optional Authorization header value for instances behind auth ("Basic …", "Bearer …"). */
  authorization: string;
  timeoutMs: number;
  maxConcurrentPerUser: number;
  /** Engines asked by name, once more, when a search returns fewer than fallbackBelow results. */
  fallbackEngines: readonly string[];
  fallbackBelow: number;
  /** How long an answer is reused for the same search; 0 turns the cache off. */
  cacheMs: number;
}

/** A server's portal-hostd (hostd/): live hardware readings, and on the LLM server engine updates. */
export interface HostdConfig {
  /** "" = not set up: the admin console shows how to set it up. */
  url: string;
  token: string;
}

export interface EngineConfig {
  /** The GitHub repository (owner/name) whose releases hold the engine's release notes; "" = none. */
  releaseNotesRepo: string;
  /** An engine update waits this long for running LLM requests to finish before it restarts the engine anyway. */
  drainMs: number;
}

export type ReaderPolicy = "shown" | "any";

/** The page reader behind the read_page tool (the reader container). */
export interface ReaderConfig {
  /** Base URL of the reader as the gateway reaches it; empty means no read_page tool. */
  url: string;
  timeoutMs: number;
  /**
   * "shown": a workspace may open URLs it was shown (search results, pages it read, its conversation)
   * and anything on trustedHosts. "any": every public page.
   */
  policy: ReaderPolicy;
  /** Sites that may be opened without having been shown; subdomains included. */
  trustedHosts: readonly string[];
  /** Characters of a page returned per read_page call. */
  pageChars: number;
  /** How long a page is kept for paging and repeat reads; 0 turns the cache off. */
  cacheMs: number;
  maxConcurrentPerUser: number;
}

/**
 * Documentation and code sites any workspace may read without having been shown the URL. Only their
 * operators see what is requested from them, so a request there cannot carry data to someone else.
 */
export const DEFAULT_TRUSTED_HOSTS =
  "github.com,raw.githubusercontent.com,gitlab.com,stackoverflow.com,stackexchange.com,superuser.com,serverfault.com,askubuntu.com," +
  "wikipedia.org,developer.mozilla.org,python.org,pypi.org,npmjs.com,nodejs.org,docs.rs,crates.io,rust-lang.org,go.dev," +
  "kubernetes.io,docs.docker.com,learn.microsoft.com,archlinux.org,man7.org,kernel.org,fedoraproject.org,debian.org,ubuntu.com," +
  "postgresql.org,sqlite.org,arxiv.org,huggingface.co";

export interface Config {
  /** Host path of the portal data, mounted at the same path inside the gateway container. */
  dataDir: string;
  dbFile: string;
  /**
   * Admin-provided Qwen Code settings (settings.json, system-defaults.json), applied to every workspace.
   * Its system-defaults.json also defines the models of DeepSeek Harness workspaces.
   */
  qwenConfigDir: string;
  /** Admin-provided DeepSeek Harness patch (patch.yml), applied before the portal's own. */
  dshConfigDir: string;
  /** The current version of each agent, where it differs from the default (agent-versions.ts). */
  agentVersionsFile: string;
  /**
   * The workspace-image/ directory the gateway builds agent images from: the project's own, which
   * docker-compose.yml mounts read-only at /app/workspace-image. The default finds it in the container
   * and in a development checkout alike (DEFAULT_IMAGE_CONTEXT); WORKSPACE_IMAGE_CONTEXT overrides it
   * for another layout.
   */
  imageContextDir: string;
  webPort: number;
  agentBind: string;
  /** Workspace ports per kind and user: workspace.kinds[kind].agentPortBase + N for 1 <= N < agentPortCount. */
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
  reader: ReaderConfig;
  workspace: WorkspaceConfig;
  hostd: { portal: HostdConfig; llm: HostdConfig };
  engine: EngineConfig;
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
/** portal-hostd refuses shorter tokens. */
const MIN_HOSTD_TOKEN_LENGTH = 32;
export const MIB = 1024 * 1024;
/** The effort tiers Qwen Code knows (capabilities.reasoning.efforts); "none" turns thinking off. */
const REASONING_EFFORTS: readonly string[] = ["none", "low", "medium", "high", "xhigh", "max"];

/** Workspace UIDs stay clear of system and human accounts, */
const MIN_UID_BASE = 100_000;
/**
 * and below systemd's foreign UID range (0x7FFE0000: every user has access to files owned there), so also below 2^31,
 * past which some code takes UIDs for negative numbers.
 */
const UID_LIMIT = 2_147_352_576;

/**
 * Everything that is not the public internet (the IANA special-purpose IPv4 ranges): the host firewall drops it for
 * the Online workspaces, the reader and SearXNG (NOT_PUBLIC in deploy/firewall.sh; config.test.ts keeps the two equal).
 */
export const NOT_PUBLIC: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/3",
];

/** An IPv4 address outside NOT_PUBLIC: one the firewall lets the Online workspaces reach. */
export function isPublicIpv4(address: string): boolean {
  return net.isIPv4(address) && !NOT_PUBLIC.some((range) => cidrContains(parseCidr(range)!, address));
}

const BYTE_UNITS: Record<string, number> = { "": 1, k: 1024, m: MIB, g: 1024 * MIB };
/**
 * workspace-image/ next to the gateway's code: /app/workspace-image in the gateway container (dist/main.js
 * is /app/gateway/dist/main.js; docker-compose.yml mounts the project's workspace-image/ there), the
 * repository's own in development (src/config.ts).
 */
const DEFAULT_IMAGE_CONTEXT = fileURLToPath(new URL("../../workspace-image", import.meta.url));

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
  const agentPortBase = read.port("AGENT_PORT_BASE", 3100);
  const agentPortCount = read.int("AGENT_PORT_COUNT", 200, 2);

  const config: Config = {
    dataDir,
    dbFile: path.join(dataDir, "db", "portal.sqlite"),
    qwenConfigDir: path.join(dataDir, "config", "qwen"),
    dshConfigDir: path.join(dataDir, "config", "dsh"),
    agentVersionsFile: path.join(dataDir, "config", "agent-versions.env"),
    imageContextDir: read.absolutePath("WORKSPACE_IMAGE_CONTEXT", DEFAULT_IMAGE_CONTEXT),
    webPort: read.port("WEB_PORT", 3000),
    agentBind: read.ip("AGENT_BIND", "0.0.0.0"),
    agentPortCount,
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
      // The engines searxng/settings.yml loads but keeps out of ordinary searches.
      fallbackEngines: read.list(
        "SEARCH_FALLBACK_ENGINES",
        "duckduckgo,swisscows,privacywall,mojeek",
        /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/,
        "SearXNG engine names",
      ),
      fallbackBelow: read.int("SEARCH_FALLBACK_BELOW", 3, 1),
      cacheMs: read.int("SEARCH_CACHE_MINUTES", 15, 0) * 60_000,
    },
    reader: {
      url: read.optionalHttpUrl("READER_URL"),
      timeoutMs: read.int("READER_TIMEOUT_SECONDS", 60, 5) * 1000,
      policy: read.oneOf("READER_URL_POLICY", "shown", ["shown", "any"] as const),
      trustedHosts: read.list("READER_TRUSTED_HOSTS", DEFAULT_TRUSTED_HOSTS, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "host names such as docs.python.org").map(
        (host) => host.toLowerCase(),
      ),
      pageChars: read.int("READER_PAGE_CHARS", 20_000, 1000),
      cacheMs: read.int("READER_CACHE_MINUTES", 15, 0) * 60_000,
      maxConcurrentPerUser: read.int("READER_MAX_CONCURRENT_PER_USER", 2, 1),
    },
    workspace: {
      agents: read.agentList("WORKSPACE_AGENTS", "qwen,dsh"),
      defaultVersions: {
        qwen: read.version("QWEN_CODE_VERSION", "0.27.0"),
        dsh: read.version("DSH_VERSION", "0.2.2-rc.1"),
      },
      kinds: {
        private: {
          kind: "private",
          network: read.nonEmpty("WORKSPACE_NETWORK", "workspace-portal-ws"),
          subnet: read.cidr("WORKSPACE_SUBNET", "172.29.0.0/16"),
          gatewayIp: read.ipv4("WORKSPACE_GATEWAY_IP", "172.29.0.1"),
          ipRange: read.cidr("WORKSPACE_IP_RANGE", "172.29.128.0/17"),
          bridge: read.nonEmpty("WORKSPACE_BRIDGE", "br-wportal"),
          uidBase: read.int("WORKSPACE_UID_BASE", 200_000, MIN_UID_BASE),
          agentPortBase,
          dns: [],
        },
        online: {
          kind: "online",
          network: read.nonEmpty("ONLINE_NETWORK", "workspace-portal-online"),
          subnet: read.cidr("ONLINE_SUBNET", "172.28.0.0/16"),
          gatewayIp: read.ipv4("ONLINE_GATEWAY_IP", "172.28.0.1"),
          ipRange: read.cidr("ONLINE_IP_RANGE", "172.28.128.0/17"),
          bridge: read.nonEmpty("ONLINE_BRIDGE", "br-wonline"),
          // Far from the Private one and from the ranges useradd gives out in /etc/subuid (100000 or 524288 upward).
          uidBase: read.int("ONLINE_UID_BASE", 2_000_000_000, MIN_UID_BASE),
          agentPortBase: read.port("ONLINE_AGENT_PORT_BASE", agentPortBase + agentPortCount),
          dns: [read.ipv4("ONLINE_DNS_1", "1.1.1.1"), read.ipv4("ONLINE_DNS_2", "9.9.9.9")],
        },
      },
      onlineEnabled: read.bool("ONLINE_WORKSPACES", true),
      memoryBytes: read.byteSize("WORKSPACE_MEMORY", "3g"),
      nanoCpus: Math.round(read.positiveNumber("WORKSPACE_CPUS", 4) * 1e9),
      pidsLimit: read.int("WORKSPACE_PIDS", 1024, 1),
      shmBytes: read.byteSize("WORKSPACE_SHM", "1g"),
      tmpBytes: read.byteSize("WORKSPACE_TMP", "1g"),
      browser: read.bool("WORKSPACE_BROWSER", true),
      defaultEffort: read.effort("DEFAULT_REASONING_EFFORT", "low"),
    },
    hostd: {
      portal: read.hostd("HOSTD_PORTAL", "http://127.0.0.1:9180"),
      llm: read.hostd("HOSTD_LLM", ""),
    },
    engine: {
      releaseNotesRepo: read.githubRepo("ENGINE_RELEASE_NOTES_REPO", "gufo-org/gufo"),
      drainMs: read.int("ENGINE_DRAIN_MINUTES", 15, 1) * 60_000,
    },
    maxRunning: read.int("MAX_RUNNING_WORKSPACES", 4, 1),
    idleTimeoutMs: read.int("IDLE_TIMEOUT_MINUTES", 30, 1) * 60_000,
    maxBusyMs: read.int("MAX_BUSY_HOURS", 24, 0) * 3_600_000,
    uploadLimitBytes: read.int("UPLOAD_LIMIT_MB", 100, 1) * MIB,
  };

  if (config.search.authorization.includes("\n") || config.search.authorization.includes("\r")) {
    read.problems.push("SEARXNG_AUTHORIZATION must be a single header value");
  }
  read.problems.push(...kindProblems(config));
  if (read.problems.length > 0) throw new ConfigError(read.problems);
  return config;
}

/** The .env names of each kind's settings, for the problems kindProblems reports. */
const KIND_KEYS: Record<WorkspaceKind, { ports: string; uid: string; network: string; subnet: string; bridge: string; gateway: string; range: string }> = {
  private: {
    ports: "AGENT_PORT_BASE",
    uid: "WORKSPACE_UID_BASE",
    network: "WORKSPACE_NETWORK",
    subnet: "WORKSPACE_SUBNET",
    bridge: "WORKSPACE_BRIDGE",
    gateway: "WORKSPACE_GATEWAY_IP",
    range: "WORKSPACE_IP_RANGE",
  },
  online: {
    ports: "ONLINE_AGENT_PORT_BASE",
    uid: "ONLINE_UID_BASE",
    network: "ONLINE_NETWORK",
    subnet: "ONLINE_SUBNET",
    bridge: "ONLINE_BRIDGE",
    gateway: "ONLINE_GATEWAY_IP",
    range: "ONLINE_IP_RANGE",
  },
};

/**
 * What would let the two kinds (or a kind and the portal's own ports) share something: overlapping port or UID
 * ranges, the same network, bridge or addresses; and addresses that don't fit their subnet. Both kinds are checked
 * even with ONLINE_WORKSPACES=off, so switching it on later can't break isolation.
 */
function kindProblems(config: Config): string[] {
  const problems: string[] = [];
  const count = config.agentPortCount;
  const { private: priv, online } = config.workspace.kinds;
  /** The ports, or UIDs, users 1 … count - 1 get from `base`. */
  const span = (base: number): [number, number] => [base + 1, base + count - 1];
  const overlaps = ([a1, a2]: [number, number], [b1, b2]: [number, number]): boolean => a1 <= b2 && b1 <= a2;

  for (const kind of WORKSPACE_KINDS) {
    const { agentPortBase, gatewayIp, ipRange, subnet, uidBase, dns } = config.workspace.kinds[kind];
    const keys = KIND_KEYS[kind];
    if (uidBase + count - 1 >= UID_LIMIT) {
      problems.push(`${keys.uid} + AGENT_PORT_COUNT must stay below ${UID_LIMIT} (got ${uidBase} + ${count})`);
    }
    // The firewall drops every private address before it lets DNS through: a private resolver would not answer,
    // and one on the LAN would be a door into it.
    dns.forEach((address, index) => {
      if (net.isIPv4(address) && !isPublicIpv4(address)) {
        problems.push(`ONLINE_DNS_${index + 1} (${address}) must be a public resolver, such as 1.1.1.1 or 9.9.9.9: the Online workspaces may reach no private address`);
      }
    });
    if (agentPortBase + count - 1 > 65535) {
      problems.push(`${keys.ports} + AGENT_PORT_COUNT must stay below 65536 (got ${agentPortBase} + ${count})`);
    }
    const [first, last] = span(agentPortBase);
    if ([config.webPort, config.controlPort, config.servicePort].some((port) => port >= first && port <= last)) {
      problems.push(`WEB_PORT, CONTROL_PORT and SERVICE_PORT must lie outside the workspace port range (${keys.ports} + 1 … ${keys.ports} + AGENT_PORT_COUNT - 1: ${first}-${last})`);
    }
    const own = parseCidr(subnet);
    if (own && !cidrContains(own, gatewayIp)) problems.push(`${keys.gateway} (${gatewayIp}) must lie inside ${keys.subnet} (${subnet})`);
    const range = parseCidr(ipRange);
    if (own && range && !(range.bits >= own.bits && cidrContains(own, ipRange.split("/")[0]!))) {
      problems.push(`${keys.range} (${ipRange}) must lie inside ${keys.subnet} (${subnet})`);
    }
  }
  if (overlaps(span(priv.agentPortBase), span(online.agentPortBase))) {
    problems.push(
      `the Private and Online workspace port ranges overlap (AGENT_PORT_BASE ${priv.agentPortBase}, ONLINE_AGENT_PORT_BASE ${online.agentPortBase}, AGENT_PORT_COUNT ${count}): each kind needs ports of its own`,
    );
  }
  if (overlaps(span(priv.uidBase), span(online.uidBase))) {
    problems.push(
      `the Private and Online workspace UID ranges overlap (WORKSPACE_UID_BASE ${priv.uidBase}, ONLINE_UID_BASE ${online.uidBase}, AGENT_PORT_COUNT ${count}): the bases must be at least AGENT_PORT_COUNT apart`,
    );
  }
  if (priv.network === online.network) problems.push(`WORKSPACE_NETWORK and ONLINE_NETWORK must differ (both "${priv.network}")`);
  if (priv.bridge === online.bridge) problems.push(`WORKSPACE_BRIDGE and ONLINE_BRIDGE must differ (both "${priv.bridge}")`);
  const [a, b] = [parseCidr(priv.subnet), parseCidr(online.subnet)];
  if (a && b && cidrsOverlap(a, b)) problems.push(`WORKSPACE_SUBNET (${priv.subnet}) and ONLINE_SUBNET (${online.subnet}) must not overlap`);
  return problems;
}

interface Cidr {
  /** The network address as an unsigned 32-bit number. */
  address: number;
  bits: number;
}

function ipv4Number(address: string): number | null {
  if (!net.isIPv4(address)) return null;
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

/** An IPv4 CIDR, its address masked to the prefix; null when it doesn't parse (EnvReader.cidr reported it). */
function parseCidr(text: string): Cidr | null {
  const [address, bits] = text.split("/");
  const value = ipv4Number(address ?? "");
  const prefix = Number(bits);
  if (value === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return { address: value - (value % 2 ** (32 - prefix)), bits: prefix };
}

function cidrContains(cidr: Cidr, address: string): boolean {
  const value = ipv4Number(address);
  return value !== null && Math.floor(value / 2 ** (32 - cidr.bits)) === Math.floor(cidr.address / 2 ** (32 - cidr.bits));
}

function cidrsOverlap(a: Cidr, b: Cidr): boolean {
  const bits = Math.min(a.bits, b.bits);
  return Math.floor(a.address / 2 ** (32 - bits)) === Math.floor(b.address / 2 ** (32 - bits));
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

  /** An http(s) URL, or "" when the variable is not set or says "off". */
  optionalHttpUrl(name: string): string {
    const raw = this.nonEmpty(name, "").toLowerCase();
    return raw === "" || raw === "off" ? "" : this.httpUrl(name, "");
  }

  /** One of a fixed set of words. */
  oneOf<T extends string>(name: string, fallback: T, choices: readonly T[]): T {
    const raw = this.nonEmpty(name, fallback).toLowerCase();
    if ((choices as readonly string[]).includes(raw)) return raw as T;
    this.problems.push(`${name} must be one of ${choices.join(", ")} (got "${raw}")`);
    return fallback;
  }

  /** A comma-separated list without repeats. Not set or empty: the fallback; "none": an empty list. */
  list(name: string, fallback: string, pattern: RegExp, what: string): string[] {
    const raw = this.nonEmpty(name, fallback);
    if (raw.toLowerCase() === "none") return [];
    const items = raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
    const bad = items.filter((item) => !pattern.test(item));
    if (bad.length > 0) {
      this.problems.push(`${name} must be a comma-separated list of ${what} (got "${bad.join('", "')}")`);
      return [];
    }
    return [...new Set(items)];
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

  /** A comma-separated list of agent kinds without repeats, at least one. */
  agentList(name: string, fallback: string): AgentKind[] {
    const raw = this.nonEmpty(name, fallback);
    const items = raw.split(",").map((item) => item.trim().toLowerCase()).filter((item) => item !== "");
    const unknown = items.filter((item) => !isAgentKind(item));
    if (unknown.length > 0 || items.length === 0) {
      this.problems.push(`${name} must list one or more of ${AGENT_KINDS.join(", ")}, comma-separated (got "${raw}")`);
      return fallback.split(",").filter(isAgentKind);
    }
    return [...new Set(items.filter(isAgentKind))];
  }

  /**
   * A portal-hostd address and its token, from <prefix>_URL and <prefix>_TOKEN. Without a token, or with
   * the URL "off", it is not set up; a token needs an address.
   */
  hostd(prefix: string, fallbackUrl: string): HostdConfig {
    const urlName = `${prefix}_URL`;
    const tokenName = `${prefix}_TOKEN`;
    const raw = this.nonEmpty(urlName, fallbackUrl);
    const token = this.string(tokenName, "");
    if (token === "" || raw.toLowerCase() === "off") return { url: "", token: "" };
    const url = raw === "" ? "" : this.httpUrl(urlName, fallbackUrl);
    if (url === "") this.problems.push(`${tokenName} is set, so ${urlName} must be the http:// address of that portal-hostd`);
    if (token.length < MIN_HOSTD_TOKEN_LENGTH || /\s/.test(token)) {
      this.problems.push(`${tokenName} must be the portal-hostd token: at least ${MIN_HOSTD_TOKEN_LENGTH} characters, no spaces`);
    }
    return { url, token };
  }

  /** A GitHub repository as owner/name, or "" for none ("none" or empty). */
  githubRepo(name: string, fallback: string): string {
    const raw = this.nonEmpty(name, fallback);
    if (raw.toLowerCase() === "none") return "";
    if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(raw)) return raw;
    this.problems.push(`${name} must be a GitHub repository such as gufo-org/gufo, or none (got "${raw}")`);
    return fallback;
  }

  /** A reasoning effort tier, or "model" (null): leave the models' own default. */
  effort(name: string, fallback: string): string | null {
    const raw = this.nonEmpty(name, fallback).toLowerCase();
    if (raw === "model") return null;
    if (REASONING_EFFORTS.includes(raw)) return raw;
    this.problems.push(`${name} must be one of ${REASONING_EFFORTS.join(", ")} or "model" (got "${raw}")`);
    return fallback;
  }

  /** An npm-style version, as used in image tags (versions.ts). */
  version(name: string, fallback: string): string {
    const value = this.nonEmpty(name, fallback);
    if (!isVersion(value)) {
      this.problems.push(`${name} must be a version such as 0.27.0 (got "${value}")`);
      return fallback;
    }
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
