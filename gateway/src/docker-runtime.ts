// ContainerRuntime backed by the Docker Engine API (dockerode, /var/run/docker.sock or DOCKER_HOST).
import Docker from "dockerode";
import type { Config, WorkspaceConfig } from "./config.ts";
import {
  containerName,
  TOKEN_ENV,
  USER_ID_LABEL,
  WORKSPACE_LABEL,
  workspaceContainerOptions,
  workspaceNetworkOptions,
  type WorkspaceStartOptions,
} from "./container-spec.ts";
import { QWEN_PORT } from "./qwen.ts";
import {
  WorkspaceImageMissingError,
  type ContainerRuntime,
  type ContainerSample,
  type ContainerState,
  type ContainerSummary,
  type StartedContainer,
} from "./runtime.ts";

const STOP_GRACE_SECONDS = 10;
/**
 * Every Docker API call fails after this long without an answer. dockerode has no timeout of its
 * own, and one hung call would otherwise hold up the reaper and the stats refresh for everyone.
 * Comfortably above the slowest legitimate call, `stop -t 10`.
 */
export const DOCKER_API_TIMEOUT_MS = 60_000;
/**
 * Older engines forward DNS queries for outside names from internal networks (CVE-2024-29018),
 * which would give workspaces a way out. Fixed in 25.0.5 and 26.0.0.
 */
const MIN_DOCKER_VERSION = [25, 0, 5] as const;
export const MIN_DOCKER_VERSION_TEXT = MIN_DOCKER_VERSION.join(".");

export class DockerRuntime implements ContainerRuntime {
  readonly #docker: Docker;
  readonly #config: Config;

  constructor(config: Config, docker = new Docker({ timeout: DOCKER_API_TIMEOUT_MS })) {
    this.#config = config;
    this.#docker = docker;
  }

  /** The Docker Engine's version, as `docker version` reports it for the server. */
  async engineVersion(): Promise<string> {
    const { Version } = await this.#docker.version();
    return typeof Version === "string" ? Version : "";
  }

  /**
   * Creates the workspace network unless it exists. A network of that name that differs from the
   * one the gateway creates (isolation options, bridge name, addresses) is replaced when nothing
   * uses it, and refused otherwise: workspaces never start on a network that can reach the outside,
   * and the host firewall, which matches on the bridge name, must see the bridge it expects.
   */
  async ensureNetwork(): Promise<"exists" | "created" | "replaced"> {
    const name = this.#config.workspace.network;
    let existing: Docker.NetworkInspectInfo | null = null;
    try {
      existing = (await this.#docker.getNetwork(name).inspect()) as Docker.NetworkInspectInfo;
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
    }
    const mismatches = existing ? networkMismatches(existing, this.#config.workspace) : [];
    if (existing && mismatches.length === 0) return "exists";
    if (existing) {
      if (Object.keys(existing.Containers ?? {}).length > 0) {
        throw new Error(
          `docker network ${name} is not the isolated workspace network (${mismatches.join("; ")}) and containers use it; stop them and remove the network`,
        );
      }
      await this.#docker.getNetwork(name).remove();
    }
    await this.#docker.createNetwork(workspaceNetworkOptions(this.#config.workspace));
    return existing ? "replaced" : "created";
  }

  async imageAvailable(): Promise<boolean> {
    try {
      await this.#docker.getImage(this.#config.workspace.image).inspect();
      return true;
    } catch (error) {
      if (statusCode(error) === 404) return false;
      throw error;
    }
  }

  async startWorkspace(userId: number, options: WorkspaceStartOptions): Promise<StartedContainer> {
    await this.removeContainer(containerName(userId));
    let container: Docker.Container;
    try {
      container = await this.#docker.createContainer(workspaceContainerOptions(this.#config, userId, options));
    } catch (error) {
      if (statusCode(error) === 404 && /no such image/i.test(errorText(error))) {
        throw new WorkspaceImageMissingError(this.#config.workspace.image);
      }
      throw error;
    }
    try {
      await container.start();
      const info = await container.inspect();
      const network = this.#config.workspace.network;
      const ip = info.NetworkSettings.Networks[network]?.IPAddress;
      if (!ip) throw new Error(`workspace container has no address on network ${network}`);
      return { id: container.id, ip, port: QWEN_PORT };
    } catch (error) {
      await this.removeContainer(container.id).catch(() => undefined);
      throw error;
    }
  }

  async stopContainer(id: string): Promise<void> {
    // A failed graceful stop (already stopped, gone, daemon timeout) is settled by the forced removal.
    await this.#docker
      .getContainer(id)
      .stop({ t: STOP_GRACE_SECONDS })
      .catch(() => undefined);
    await this.removeContainer(id);
  }

  async removeContainer(id: string): Promise<void> {
    try {
      await this.#docker.getContainer(id).remove({ force: true });
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
    }
  }

  async state(id: string): Promise<ContainerState> {
    try {
      const { State } = await this.#docker.getContainer(id).inspect();
      if (State.Running) return { running: true };
      return { running: false, exitCode: State.ExitCode, oomKilled: State.OOMKilled };
    } catch (error) {
      if (statusCode(error) === 404) return { running: false, exitCode: null, oomKilled: false };
      throw error;
    }
  }

  async list(): Promise<ContainerSummary[]> {
    const network = this.#config.workspace.network;
    const rows = await this.#docker.listContainers({ all: true, filters: { label: [`${WORKSPACE_LABEL}=1`] } });
    return rows.map((row) => {
      const userId = Number(row.Labels[USER_ID_LABEL]);
      return {
        id: row.Id,
        userId: Number.isSafeInteger(userId) && userId > 0 ? userId : null,
        running: row.State === "running",
        ip: row.NetworkSettings.Networks[network]?.IPAddress || null,
        port: QWEN_PORT,
      };
    });
  }

  /** The `qwen serve` token a running container was started with (to adopt it after a gateway restart). */
  async serverToken(id: string): Promise<string | null> {
    try {
      const info = await this.#docker.getContainer(id).inspect();
      const prefix = `${TOKEN_ENV}=`;
      const entry = (info.Config.Env ?? []).find((item) => item.startsWith(prefix));
      return entry ? entry.slice(prefix.length) || null : null;
    } catch (error) {
      if (statusCode(error) === 404) return null;
      throw error;
    }
  }

  async logsTail(id: string, lines: number): Promise<string> {
    const output = await this.#docker
      .getContainer(id)
      .logs({ stdout: true, stderr: true, tail: lines, follow: false });
    return demuxDockerLogs(output);
  }

  async sample(id: string): Promise<ContainerSample> {
    const state = await this.state(id);
    if (!state.running) return { running: false };
    // one-shot: no second sample a second later; CPU is averaged by the caller across calls.
    const stats = await this.#docker.getContainer(id).stats({ stream: false, "one-shot": true } as { stream: false });
    return { running: true, memoryBytes: memoryUsage(stats), cpuSeconds: cpuSeconds(stats) };
  }
}

/** How an existing network differs from what workspaceNetworkOptions creates; empty when it matches. */
function networkMismatches(network: Docker.NetworkInspectInfo, ws: WorkspaceConfig): string[] {
  const options = network.Options ?? {};
  const problems: string[] = [];
  const expect = (what: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected) problems.push(`${what} is ${JSON.stringify(actual ?? null)}, expected ${JSON.stringify(expected)}`);
  };
  expect("Internal", network.Internal, true);
  expect("EnableIPv6", network.EnableIPv6 === true, false);
  expect("bridge name", options["com.docker.network.bridge.name"], ws.bridge);
  expect("enable_icc", options["com.docker.network.bridge.enable_icc"], "false");
  expect("enable_ip_masquerade", options["com.docker.network.bridge.enable_ip_masquerade"], "false");
  const pools = network.IPAM?.Config ?? [];
  if (pools.length !== 1) problems.push(`it has ${pools.length} IPAM pools, expected 1`);
  const pool = pools[0];
  if (pool) {
    expect("Subnet", pool.Subnet, ws.subnet);
    expect("Gateway", pool.Gateway, ws.gatewayIp);
    expect("IPRange", pool.IPRange, ws.ipRange);
  }
  return problems;
}

/** Whether a Docker Engine version (`26.1.4`, `27.0.0-rc.1`, …) is at least MIN_DOCKER_VERSION. Unparseable is not. */
export function isSupportedDockerVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < MIN_DOCKER_VERSION.length; i++) {
    if (parts[i]! !== MIN_DOCKER_VERSION[i]) return parts[i]! > MIN_DOCKER_VERSION[i]!;
  }
  return true;
}

/** Joins the stdout/stderr frames of a non-TTY log stream (8-byte headers); TTY output passes as is. */
export function demuxDockerLogs(buffer: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) return buffer.toString("utf8");
    const stream = buffer.readUInt8(offset);
    const size = buffer.readUInt32BE(offset + 4);
    const end = offset + 8 + size;
    if (stream > 2 || buffer.readUIntBE(offset + 1, 3) !== 0 || end > buffer.length) return buffer.toString("utf8");
    parts.push(buffer.subarray(offset + 8, end));
    offset = end;
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Memory in use the way `docker stats` reports it: usage minus reclaimable page cache. */
export function memoryUsage(stats: Docker.ContainerStats): number | null {
  const usage = stats.memory_stats?.usage;
  if (typeof usage !== "number") return null;
  const details = (stats.memory_stats.stats ?? {}) as unknown as Record<string, number | undefined>;
  const cache = details.inactive_file ?? details.total_inactive_file ?? 0;
  return Math.max(0, usage - cache);
}

/** Cumulative CPU time of the container (cgroup total_usage, nanoseconds) in seconds. */
export function cpuSeconds(stats: Docker.ContainerStats): number | null {
  const total = stats.cpu_stats?.cpu_usage?.total_usage;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total / 1e9 : null;
}

function statusCode(error: unknown): number | undefined {
  const code = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : undefined;
}

function errorText(error: unknown): string {
  const json = (error as { json?: { message?: unknown } } | null)?.json;
  const message = typeof json?.message === "string" ? json.message : "";
  return `${error instanceof Error ? error.message : String(error)} ${message}`;
}
