// The gateway's configuration, read once from the environment. The defaults are .env.example's (config.test.ts).
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_KINDS,
  agentPortFor,
  agentPortRange,
  isAgentKind,
  isVersion,
  MIN_CONTROL_SECRET_LENGTH,
  PREVIEW_PORT_OFFSET,
  WORKSPACE_BLOCK,
  WORKSPACE_REFS,
  type AgentKind,
  type WorkspaceKind,
} from "@portal/core";
import { driverFor, imageModels, loadMediaRegistry, type MediaRegistry } from "@portal/harnesses";

/**
 * What one kind of workspace (Private, Online) has to itself: its network. Every agent's workspace of the kind is on
 * it, where no container reaches another.
 */
export interface KindConfig {
  kind: WorkspaceKind;
  network: string;
  subnet: string;
  /** The host's address on the network: the service API listens here for this kind's containers. */
  gatewayIp: string;
  ipRange: string;
  bridge: string;
  /** Its containers' DNS servers; none for Private. */
  dns: readonly string[];
}

export interface WorkspaceConfig {
  /** The enabled agents: those users choose from, the default first. Of any other the portal runs and serves nothing. */
  agents: readonly AgentKind[];
  /** What a fresh install builds; updates/agent-versions.ts holds the versions in use. */
  defaultVersions: Readonly<Record<AgentKind, string>>;
  kinds: Record<WorkspaceKind, KindConfig>;
  /** A workspace runs as UID and GID uidBase + its number (workspaceNumber): no two workspaces share an owner. */
  uidBase: number;
  onlineEnabled: boolean;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  shmBytes: number;
  tmpBytes: number;
  browser: boolean;
  /** What a new agent session starts with; null: each model's own defaultEffort. */
  defaultEffort: string | null;
}

export interface SearchConfig {
  url: string;
  /** The Authorization header for a SearXNG behind auth, or "". */
  authorization: string;
  timeoutMs: number;
  maxConcurrentPerUser: number;
  /** Engines asked by name, once more, when a search returns fewer than fallbackBelow results. */
  fallbackEngines: readonly string[];
  fallbackBelow: number;
  /** 0: no cache. */
  cacheMs: number;
  /** Ask Exa first (exa-search.ts): each search it can answer leaves this server for Exa. */
  exa: boolean;
}

/** A server's portal-hostd; url "": not set up. */
export interface HostdConfig {
  url: string;
  token: string;
}

export interface EngineConfig {
  /** The GitHub repository (owner/name) with the engine's release notes, or "". */
  releaseNotesRepo: string;
  /** An engine update waits this long for running LLM requests before it restarts the engine. */
  drainMs: number;
}

export type ReaderPolicy = "shown" | "any";

export interface ReaderConfig {
  /** "": no read_page tool. */
  url: string;
  timeoutMs: number;
  /** shown: a workspace may open the URLs it was shown and the trusted hosts; any: every public page. */
  policy: ReaderPolicy;
  /** Readable without having been shown, subdomains included. */
  trustedHosts: readonly string[];
  pageChars: number;
  /** 0: no cache. */
  cacheMs: number;
  maxConcurrentPerUser: number;
}

/** Documentation and code sites: only their operators see what is asked of them, so a request carries no data to anyone else. */
export const DEFAULT_TRUSTED_HOSTS =
  "github.com,raw.githubusercontent.com,gitlab.com,stackoverflow.com,stackexchange.com,superuser.com,serverfault.com,askubuntu.com," +
  "wikipedia.org,developer.mozilla.org,python.org,pypi.org,npmjs.com,nodejs.org,docs.rs,crates.io,rust-lang.org,go.dev," +
  "kubernetes.io,docs.docker.com,learn.microsoft.com,archlinux.org,man7.org,kernel.org,fedoraproject.org,debian.org,ubuntu.com," +
  "postgresql.org,sqlite.org,arxiv.org,huggingface.co";

export interface Config {
  /** The same path on the host and in the gateway container. */
  dataDir: string;
  dbFile: string;
  /** The admin's model list (deploy/models.sh), which every harness's settings are rendered from. */
  modelsDir: string;
  /** The admin's own instructions for every workspace's agent; the file need not exist. */
  instructionsFile: string;
  agentVersionsFile: string;
  /** The build context of workspace images: what holds container/image/ and harnesses/. */
  imageContextDir: string;
  webPort: number;
  /** What browsers reach the portal over. Over HTTPS it is on port 443, the workspaces on their own ports. */
  scheme: "http" | "https";
  agentBind: string;
  /** A workspace is served on agentPortBase + its number (workspaceNumber), its web apps PREVIEW_PORT_OFFSET above. */
  agentPortBase: number;
  /** Users 1 … agentPortCount - 1 have workspace ports, and so workspaces. */
  agentPortCount: number;
  controlPort: number;
  servicePort: number;
  controlSecret: string;
  llm: {
    upstreamUrl: string;
    apiKey: string;
    maxConcurrency: number;
    maxConcurrencyPerUser: number;
    /** Where the AI server reports its sessions, llama.cpp style (LLM_SLOTS_PATH). */
    slotsPath: string;
    /** The image and media models, a fast and a quality one of each kind (config/models/media.json), read at start. */
    media: MediaRegistry;
    /** The image models the AI server serves on /v1/images/*, fast first: the registry's. */
    imageModels: string[];
    /**
     * Where the AI server serves one model's own routes, with `{model}` for its id (MEDIA_MODEL_PATH): behind
     * llama-swap /upstream/{model}, which starts that model; "": every model at the server's root.
     */
    mediaModelPath: string;
  };
  search: SearchConfig;
  reader: ReaderConfig;
  workspace: WorkspaceConfig;
  hostd: { portal: HostdConfig; llm: HostdConfig };
  engine: EngineConfig;
  maxRunning: number;
  idleTimeoutMs: number;
  /** A working agent keeps its workspace up this long after a person last used it; 0: no limit. */
  maxBusyMs: number;
  /** The largest request body into a workspace, and the Web Shell's largest upload. */
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

/** portal-hostd refuses shorter tokens. */
const MIN_HOSTD_TOKEN_LENGTH = 32;
export const MIB = 1024 * 1024;
/** The efforts DEFAULT_REASONING_EFFORT may name: the tiers a model's entry lists (capabilities.reasoning.efforts). */
const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];
/** Workspace UIDs stay above system and human accounts, */
const MIN_UID_BASE = 100_000;
/** and below systemd's foreign UID range (0x7FFE0000), whose files every user can access. */
const UID_LIMIT = 2_147_352_576;

/**
 * The ports above 1023 that browsers refuse to open (the Fetch standard's "bad ports"): a workspace served on one
 * could not be opened.
 */
const BROWSER_BLOCKED_PORTS: readonly number[] = [1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080];

/** The IANA special-purpose IPv4 ranges: not the public internet. container/security/firewall.sh drops the same list (config.test.ts). */
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

/** An IPv4 CIDR; undefined for other text. */
function parseCidr(text: string): { address: string; bits: number; has(address: string): boolean } | undefined {
  const [address = "", bits = "", ...rest] = text.split("/");
  if (rest.length > 0 || !net.isIPv4(address) || !/^\d\d?$/.test(bits) || Number(bits) > 32) return undefined;
  const list = new net.BlockList();
  list.addSubnet(address, Number(bits));
  return { address, bits: Number(bits), has: (other) => list.check(other) };
}

const notPublic = NOT_PUBLIC.map((range) => parseCidr(range)!);

export function isPublicIpv4(address: string): boolean {
  return net.isIPv4(address) && !notPublic.some((range) => range.has(address));
}

const BYTE_UNITS: Record<string, number> = { "": 1, k: 1024, m: MIB, g: 1024 * MIB };

/** A Docker-style size such as `1536m`, `2g`, `512k` or `1048576` (binary units). */
export function parseByteSize(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(text.trim());
  if (!match) return null;
  const bytes = Math.floor(Number(match[1]) * BYTE_UNITS[match[2]!.toLowerCase()]!);
  return bytes > 0 && Number.isSafeInteger(bytes) ? bytes : null;
}

/** An http(s) URL without trailing slashes; "" stays "". */
function httpUrl(text: string): string | undefined {
  if (text === "") return "";
  return URL.canParse(text) && /^https?:$/.test(new URL(text).protocol) ? text.replace(/\/+$/, "") : undefined;
}

/**
 * The ports the gateway serves workspaces on, user by user: one per workspace of an enabled agent, each with its
 * preview port PREVIEW_PORT_OFFSET above. The ports of the other agents' workspaces stay closed.
 */
export function workspacePorts({ agentPortBase, agentPortCount, workspace }: Config): number[] {
  const refs = WORKSPACE_REFS.filter((ref) => workspace.agents.includes(ref.agent));
  const ports: number[] = [];
  for (let userId = 1; userId < agentPortCount; userId++) {
    for (const ref of refs) ports.push(agentPortFor(agentPortBase, agentPortCount, userId, ref)!);
  }
  return ports;
}

/** Throws a ConfigError that lists every problem. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];
  /** Not set and empty are the same: docker compose passes either. */
  const text = (name: string, fallback: string): string => env[name]?.trim() || fallback;

  /** The variable as `parse` reads it. What it refuses (undefined) is a problem, and the default stands. */
  function read<T>(name: string, fallback: string, parse: (value: string) => T | undefined, must: string, value = text(name, fallback)): T {
    const parsed = parse(value);
    if (parsed !== undefined) return parsed;
    problems.push(`${name} must ${must} (got "${value}")`);
    return parse(fallback) as T;
  }
  /** The variable when `ok` accepts it. What it refuses is a problem and stands, for networkProblems to skip. */
  const checked = (name: string, fallback: string, ok: (value: string) => boolean, must: string): string => {
    const value = text(name, fallback);
    if (!ok(value)) problems.push(`${name} must ${must} (got "${value}")`);
    return value;
  };
  /** `?? fallback`: a computed default that `ok` refuses stays that number, for the problems that follow. */
  const number = (name: string, fallback: number, ok: (value: number) => boolean, must: string): number =>
    read(name, String(fallback), (value) => (ok(Number(value)) ? Number(value) : undefined), must) ?? fallback;
  const int = (name: string, fallback: number, min: number): number =>
    number(name, fallback, (value) => Number.isSafeInteger(value) && value >= min, `be an integer >= ${min}`);
  const port = (name: string, fallback: number): number => {
    const value = int(name, fallback, 1);
    if (value <= 65535) return value;
    problems.push(`${name} must be a TCP port (got ${value})`);
    return fallback;
  };
  /** One of `words`, in any case. */
  const word = <T extends string>(name: string, fallback: T, words: readonly T[], must = `be one of ${words.join(", ")}`): T =>
    read(name, fallback, (value) => words.find((choice) => choice === value), must, text(name, fallback).toLowerCase());
  const bool = (name: string, fallback: boolean): boolean =>
    ["true", "1", "yes", "on"].includes(word(name, String(fallback), ["true", "1", "yes", "on", "false", "0", "no", "off"], "be true or false"));
  const byteSize = (name: string, fallback: string): number => read(name, fallback, (value) => parseByteSize(value) ?? undefined, "be a size such as 1536m or 2g");
  const url = (name: string, fallback: string): string => read(name, fallback, httpUrl, "be an http(s) URL");
  const ipv4 = (name: string, fallback: string): string => checked(name, fallback, net.isIPv4, "be an IPv4 address");
  const cidr = (name: string, fallback: string): string => checked(name, fallback, (value) => parseCidr(value) !== undefined, "be an IPv4 CIDR such as 172.29.0.0/16");
  const version = (name: string, fallback: string): string => read(name, fallback, (value) => (isVersion(value) ? value : undefined), "be a version such as 0.27.0");
  /** A comma-separated list without repeats; "none" is the empty one. */
  const list = (name: string, fallback: string, pattern: RegExp, what: string): string[] => {
    const value = text(name, fallback);
    const items = value.toLowerCase() === "none" ? [] : value.split(",").map((item) => item.trim()).filter(Boolean);
    const bad = items.filter((item) => !pattern.test(item));
    if (bad.length === 0) return [...new Set(items)];
    problems.push(`${name} must be a comma-separated list of ${what} (got "${bad.join('", "')}")`);
    return [];
  };
  /** Set up by its token; the URL "off" turns it off. */
  const hostd = (prefix: string, fallbackUrl: string): HostdConfig => {
    const token = text(`${prefix}_TOKEN`, "");
    if (token === "" || text(`${prefix}_URL`, fallbackUrl).toLowerCase() === "off") return { url: "", token: "" };
    const address = url(`${prefix}_URL`, fallbackUrl);
    if (address === "") problems.push(`${prefix}_TOKEN is set, so ${prefix}_URL must be the http:// address of that portal-hostd`);
    if (token.length < MIN_HOSTD_TOKEN_LENGTH || /\s/.test(token)) {
      problems.push(`${prefix}_TOKEN must be the portal-hostd token: at least ${MIN_HOSTD_TOKEN_LENGTH} characters, no spaces`);
    }
    return { url: address, token };
  };
  const secret = (name: string): string => {
    const value = text(name, "");
    if (value === "") problems.push(`${name} is required (deploy/install.sh generates it in .env)`);
    else if (value.length < MIN_CONTROL_SECRET_LENGTH) problems.push(`${name} must be at least ${MIN_CONTROL_SECRET_LENGTH} characters`);
    return value;
  };

  const dataDir = read("PORTAL_DATA_DIR", "/srv/workspace-portal", (value) => (path.isAbsolute(value) ? path.resolve(value) : undefined), "be an absolute path");
  const media = mediaRegistry(path.join(dataDir, "config", "models", "media.json"), problems);
  const agents: readonly AgentKind[] = read(
    "WORKSPACE_AGENTS",
    "qwen,dsh,opencode",
    (value) => {
      const items = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
      return items.length > 0 && items.every(isAgentKind) ? [...new Set(items)] : undefined;
    },
    `list one or more of ${AGENT_KINDS.join(", ")}, comma-separated`,
  );

  const config: Config = {
    dataDir,
    dbFile: path.join(dataDir, "db", "portal.sqlite"),
    modelsDir: path.join(dataDir, "config", "models"),
    instructionsFile: path.join(dataDir, "config", "instructions.md"),
    agentVersionsFile: path.join(dataDir, "config", "agent-versions.env"),
    // Two levels above the gateway's code: /app in the container, where docker-compose.yml mounts the two folders, and the repository in development.
    imageContextDir: fileURLToPath(new URL("../../", import.meta.url)),
    webPort: port("WEB_PORT", 3000),
    scheme: bool("PORTAL_HTTPS", false) ? "https" : "http",
    agentBind: checked("AGENT_BIND", "0.0.0.0", (value) => net.isIP(value) !== 0, "be an IP address"),
    agentPortBase: port("AGENT_PORT_BASE", 12_000),
    agentPortCount: int("AGENT_PORT_COUNT", 100, 2),
    controlPort: port("CONTROL_PORT", 4002),
    servicePort: port("SERVICE_PORT", 4001),
    controlSecret: secret("GATEWAY_CONTROL_SECRET"),
    llm: {
      upstreamUrl: url("LLM_UPSTREAM_URL", "http://127.0.0.1:8080"),
      apiKey: text("LLM_API_KEY", ""),
      maxConcurrency: int("LLM_MAX_CONCURRENCY", 3, 1),
      maxConcurrencyPerUser: int("LLM_MAX_CONCURRENCY_PER_USER", 2, 1),
      slotsPath: read("LLM_SLOTS_PATH", "/slots", (value) => (/^\/[^\s?#]*$/.test(value) ? value : undefined), "be a path such as /slots"),
      media,
      imageModels: imageModels(media),
      mediaModelPath: read(
        "MEDIA_MODEL_PATH",
        "none",
        (value) => (value.toLowerCase() === "none" ? "" : /^(?:\/[^\s?#/{}]+)*\/\{model\}(?:\/[^\s?#/{}]+)*$/.test(value) ? value : undefined),
        "be a path with {model} in it, such as /upstream/{model}, or none",
      ),
    },
    search: {
      url: url("SEARXNG_URL", "http://127.0.0.1:8888"),
      authorization: text("SEARXNG_AUTHORIZATION", ""),
      timeoutMs: int("SEARXNG_TIMEOUT_SECONDS", 20, 1) * 1000,
      maxConcurrentPerUser: int("SEARCH_MAX_CONCURRENT_PER_USER", 2, 1),
      fallbackEngines: list("SEARCH_FALLBACK_ENGINES", "duckduckgo,swisscows,privacywall,mojeek", /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, "SearXNG engine names"),
      fallbackBelow: int("SEARCH_FALLBACK_BELOW", 3, 1),
      cacheMs: int("SEARCH_CACHE_MINUTES", 15, 0) * 60_000,
      exa: bool("EXA_SEARCH", false),
    },
    reader: {
      url: text("READER_URL", "").toLowerCase() === "off" ? "" : url("READER_URL", ""),
      timeoutMs: int("READER_TIMEOUT_SECONDS", 60, 5) * 1000,
      policy: word("READER_URL_POLICY", "shown", ["shown", "any"]),
      trustedHosts: list("READER_TRUSTED_HOSTS", DEFAULT_TRUSTED_HOSTS, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "host names such as docs.python.org").map((host) =>
        host.toLowerCase(),
      ),
      pageChars: int("READER_PAGE_CHARS", 20_000, 1000),
      cacheMs: int("READER_CACHE_MINUTES", 15, 0) * 60_000,
      maxConcurrentPerUser: int("READER_MAX_CONCURRENT_PER_USER", 2, 1),
    },
    workspace: {
      agents,
      // Only an enabled agent's version is read from the environment: nothing is built or started of the others.
      defaultVersions: Object.fromEntries(
        AGENT_KINDS.map((kind) => {
          const { versionKey, defaultVersion } = driverFor(kind).release;
          return [kind, agents.includes(kind) ? version(versionKey, defaultVersion) : defaultVersion];
        }),
      ) as Record<AgentKind, string>,
      kinds: {
        private: {
          kind: "private",
          network: text("WORKSPACE_NETWORK", "workspace-portal-ws"),
          subnet: cidr("WORKSPACE_SUBNET", "172.29.0.0/16"),
          gatewayIp: ipv4("WORKSPACE_GATEWAY_IP", "172.29.0.1"),
          ipRange: cidr("WORKSPACE_IP_RANGE", "172.29.128.0/17"),
          bridge: text("WORKSPACE_BRIDGE", "br-wportal"),
          dns: [],
        },
        online: {
          kind: "online",
          network: text("ONLINE_NETWORK", "workspace-portal-online"),
          subnet: cidr("ONLINE_SUBNET", "172.28.0.0/16"),
          gatewayIp: ipv4("ONLINE_GATEWAY_IP", "172.28.0.1"),
          ipRange: cidr("ONLINE_IP_RANGE", "172.28.128.0/17"),
          bridge: text("ONLINE_BRIDGE", "br-wonline"),
          dns: [ipv4("ONLINE_DNS_1", "1.1.1.1"), ipv4("ONLINE_DNS_2", "9.9.9.9")],
        },
      },
      uidBase: int("WORKSPACE_UID_BASE", 200_000, MIN_UID_BASE),
      onlineEnabled: bool("ONLINE_WORKSPACES", true),
      memoryBytes: byteSize("WORKSPACE_MEMORY", "3g"),
      nanoCpus: Math.round(number("WORKSPACE_CPUS", 4, (value) => Number.isFinite(value) && value > 0, "be a positive number") * 1e9),
      pidsLimit: int("WORKSPACE_PIDS", 1024, 1),
      shmBytes: byteSize("WORKSPACE_SHM", "1g"),
      tmpBytes: byteSize("WORKSPACE_TMP", "1g"),
      browser: bool("WORKSPACE_BROWSER", true),
      defaultEffort: word("DEFAULT_REASONING_EFFORT", "low", [...REASONING_EFFORTS, "model"], `be one of ${REASONING_EFFORTS.join(", ")} or "model"`).replace(/^model$/, "") || null,
    },
    hostd: { portal: hostd("HOSTD_PORTAL", "http://127.0.0.1:9180"), llm: hostd("HOSTD_LLM", "") },
    engine: {
      releaseNotesRepo: read(
        "ENGINE_RELEASE_NOTES_REPO",
        "gufo-org/gufo",
        (value) => (value.toLowerCase() === "none" ? "" : /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(value) ? value : undefined),
        "be a GitHub repository such as gufo-org/gufo, or none",
      ),
      drainMs: int("ENGINE_DRAIN_MINUTES", 15, 1) * 60_000,
    },
    maxRunning: int("MAX_RUNNING_WORKSPACES", 4, 1),
    idleTimeoutMs: int("IDLE_TIMEOUT_MINUTES", 30, 1) * 60_000,
    maxBusyMs: int("MAX_BUSY_HOURS", 24, 0) * 3_600_000,
    uploadLimitBytes: int("UPLOAD_LIMIT_MB", 10240, 1) * MIB,
  };

  if (/[\r\n]/.test(config.search.authorization)) problems.push("SEARXNG_AUTHORIZATION must be a single header value");
  problems.push(...numberingProblems(config), ...networkProblems(config));
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/**
 * What would leave a workspace without a usable port or UID. Every workspace has its number (workspaceNumber), so no
 * setting can make two of them share a port or a UID: what can go wrong is where the ranges lie. The whole of each
 * range counts, the numbers no workspace has yet included: they are the next agents'.
 */
function numberingProblems(config: Config): string[] {
  const problems: string[] = [];
  const { agentPortBase: base, agentPortCount: count } = config;
  const ports = agentPortRange(base, count);
  const previews = { first: ports.first + PREVIEW_PORT_OFFSET, last: ports.last + PREVIEW_PORT_OFFSET };
  const span = (range: { first: number; last: number }): string => `${range.first}-${range.last}`;
  const within = (port: number): boolean => [ports, previews].some((range) => port >= range.first && port <= range.last);

  if (count * WORKSPACE_BLOCK > PREVIEW_PORT_OFFSET) {
    problems.push(
      `AGENT_PORT_COUNT must be at most ${PREVIEW_PORT_OFFSET / WORKSPACE_BLOCK}: each user has ${WORKSPACE_BLOCK} workspace ports, and their preview ports are ${PREVIEW_PORT_OFFSET} higher (got ${count})`,
    );
  } else if (previews.last > 65535) {
    problems.push(
      `the preview ports would end at ${previews.last}, past 65535: lower AGENT_PORT_BASE (${base}) or AGENT_PORT_COUNT (${count}); each user has ${WORKSPACE_BLOCK} workspace ports, and their preview ports are ${PREVIEW_PORT_OFFSET} higher`,
    );
  } else {
    for (const [name, port] of Object.entries({ WEB_PORT: config.webPort, CONTROL_PORT: config.controlPort, SERVICE_PORT: config.servicePort })) {
      if (within(port)) problems.push(`${name} (${port}) must lie outside the workspace ports (${span(ports)}) and their preview ports (${span(previews)}): move it, or AGENT_PORT_BASE`);
    }
    const refused = BROWSER_BLOCKED_PORTS.filter(within);
    if (refused.length > 0) {
      problems.push(
        `browsers refuse to open port ${refused.join(", ")}, which AGENT_PORT_BASE (${base}) puts among the workspace ports (${span(ports)}) or their preview ports (${span(previews)}): choose another base, such as 12000`,
      );
    }
  }
  const lastUid = config.workspace.uidBase + count * WORKSPACE_BLOCK - 1;
  if (lastUid >= UID_LIMIT) {
    problems.push(`the workspaces' UIDs would end at ${lastUid}, past ${UID_LIMIT - 1}: lower WORKSPACE_UID_BASE (${config.workspace.uidBase}) or AGENT_PORT_COUNT (${count})`);
  }
  return problems;
}

/**
 * What would let the two kinds share a network, and addresses outside their subnet. Checked with ONLINE_WORKSPACES
 * off too, so turning it on can't break isolation.
 */
function networkProblems(config: Config): string[] {
  const problems: string[] = [];
  const { private: priv, online } = config.workspace.kinds;
  for (const { kind, gatewayIp, ipRange, subnet, dns } of [priv, online]) {
    const prefix = kind === "private" ? "WORKSPACE" : "ONLINE";
    dns.forEach((address, index) => {
      // The firewall drops every private address before it lets DNS through.
      if (net.isIPv4(address) && !isPublicIpv4(address)) {
        problems.push(`ONLINE_DNS_${index + 1} (${address}) must be a public resolver, such as 1.1.1.1 or 9.9.9.9: the Online workspaces may reach no private address`);
      }
    });
    const [own, range] = [parseCidr(subnet), parseCidr(ipRange)];
    if (own && !own.has(gatewayIp)) problems.push(`${prefix}_GATEWAY_IP (${gatewayIp}) must lie inside ${prefix}_SUBNET (${subnet})`);
    if (own && range && (range.bits < own.bits || !own.has(range.address))) problems.push(`${prefix}_IP_RANGE (${ipRange}) must lie inside ${prefix}_SUBNET (${subnet})`);
  }
  if (priv.network === online.network) problems.push(`WORKSPACE_NETWORK and ONLINE_NETWORK must differ (both "${priv.network}")`);
  if (priv.bridge === online.bridge) problems.push(`WORKSPACE_BRIDGE and ONLINE_BRIDGE must differ (both "${priv.bridge}")`);
  const [a, b] = [parseCidr(priv.subnet), parseCidr(online.subnet)];
  if (a && b && (a.has(b.address) || b.has(a.address))) problems.push(`WORKSPACE_SUBNET (${priv.subnet}) and ONLINE_SUBNET (${online.subnet}) must not overlap`);
  return problems;
}

/**
 * The media registry, or an empty one with the reasons in `problems`. It took the place of IMAGE_MODELS, which
 * deploy/install.sh moves into it.
 */
function mediaRegistry(file: string, problems: string[]): MediaRegistry {
  try {
    return loadMediaRegistry(file);
  } catch (error) {
    problems.push((error as Error).message);
    return {};
  }
}
