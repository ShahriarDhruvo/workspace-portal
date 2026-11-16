// Docker objects the gateway creates: per-user workspace containers (one per kind: Private wp-ws-<id>, Online
// wp-wo-<id>, never both at once) and the two workspace networks.
//
// A workspace container gets as little as possible:
//   * its own UID (its kind's base + user id: no other workspace, not the same user's other kind, and no host
//     account shares it), no capabilities, no-new-privileges, memory/CPU/PID limits, and the OOM killer's
//     attention first;
//   * a read-only root filesystem; writable are only that kind's home and workspace directories of the user and
//     an in-memory /tmp;
//   * read-only, per-user and per-kind copies of the agent's settings and of /etc/passwd and /etc/group;
//     nothing on the host is mounted that another workspace (or the other kind) also sees;
//   * its kind's network, with inter-container traffic disabled. Private: *internal*, the only address it can
//     reach is the gateway's service port (model + web search): no internet, no LAN, no other workspace. Online: a
//     bridge with NAT, where the host firewall (deploy/firewall.sh) lets it reach the public internet (any TCP port,
//     DNS to its two resolvers) and the gateway's service port on its own bridge, and nothing else.
// All of this is the same whichever agent and kind the workspace runs; the driver adds only its port, environment
// and settings, the kind only its network, DNS, UID and mounts, and the image is the agent's current version
// (WorkspaceManager asks agent-versions.ts at every start).
import type Docker from "dockerode";
import { isWorkspaceKind, type AgentKind, type WorkspaceKind } from "@portal/db";
import { LLM_KEY_ENV, type AgentDriver } from "./agents/index.ts";
import { MIB, type Config, type KindConfig } from "./config.ts";
import { parseWorkspaceImage } from "./image-names.ts";
import { userPaths, workspaceOwner } from "./paths.ts";

export const WORKSPACE_LABEL = "workspace-portal.workspace";
export const USER_ID_LABEL = "workspace-portal.user-id";
/** The agent the container runs (an AgentKind). Containers from before the choice have none: Qwen Code. */
export const AGENT_LABEL = "workspace-portal.agent";
/**
 * The agent version the container started with. Docker lists a container's image as an image id once its tag has
 * moved to a rebuild (an update), so a restarted gateway reads the version from here. Containers from before it
 * have none.
 */
export const VERSION_LABEL = "workspace-portal.version";
/** The workspace kind (a WorkspaceKind). Containers from before kinds have none: Private. */
export const KIND_LABEL = "workspace-portal.kind";

/** Swap allowed on top of the memory limit, so short spikes slow down instead of OOM-killing the agent. */
const SWAP_HEADROOM_BYTES = 512 * MIB;
/** Makes workspaces the OOM killer's first choice, so the LLM server survives a memory shortage. */
const OOM_SCORE_ADJ = 500;

/** The name of a user's workspace container of one kind: Private wp-ws-<id> (as before kinds), Online wp-wo-<id>. */
export function containerName(userId: number, kind: WorkspaceKind): string {
  return `${kind === "online" ? "wp-wo" : "wp-ws"}-${userId}`;
}

/** The kind label of a workspace container; containers from before kinds have none and are Private. */
export function containerKind(label: string | undefined): WorkspaceKind | null {
  if (label === undefined) return "private";
  return isWorkspaceKind(label) ? label : null;
}

export interface WorkspaceStartOptions {
  kind: WorkspaceKind;
  agent: AgentKind;
  /** The agent's credential (driver.credentialEnv); new for every start. */
  credential: string;
  /** The image of the agent's current version (workspace-portal/workspace:<agent>-<version>). */
  image: string;
}

export function workspaceContainerOptions(
  config: Config,
  userId: number,
  driver: AgentDriver,
  { kind, credential, image }: Pick<WorkspaceStartOptions, "kind" | "credential" | "image">,
): Docker.ContainerCreateOptions {
  const ws = config.workspace;
  const own = ws.kinds[kind];
  const paths = userPaths(config.dataDir, userId, kind);
  const owner = workspaceOwner(own.uidBase, userId);
  const version = parseWorkspaceImage(image)?.version;
  return {
    name: containerName(userId, kind),
    Hostname: "workspace",
    Image: image,
    User: `${owner.uid}:${owner.gid}`,
    WorkingDir: "/workspace",
    Labels: {
      [WORKSPACE_LABEL]: "1",
      [USER_ID_LABEL]: String(userId),
      [KIND_LABEL]: kind,
      [AGENT_LABEL]: driver.kind,
      ...(version ? { [VERSION_LABEL]: version } : {}),
    },
    Env: [
      // A placeholder: the gateway replaces it with the real LLM key, which never enters a workspace.
      `${LLM_KEY_ENV}=portal`,
      "HOME=/home/user",
      "USER=user",
      "LOGNAME=user",
      ...driver.containerEnv(credential, config),
    ],
    HostConfig: {
      // The data dir is labelled container_file_t by the installer, so no :z relabelling here.
      Binds: [
        `${paths.home}:/home/user`,
        `${paths.workspace}:/workspace`,
        `${paths.agentSettings(driver.kind)}:${driver.settingsMount}:ro`,
        `${paths.passwd}:/etc/passwd:ro`,
        `${paths.group}:/etc/group:ro`,
      ],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${ws.tmpBytes}` },
      NetworkMode: own.network,
      // Online resolves names through its two resolvers (Docker's embedded DNS forwards to them, from the
      // container's own network namespace, so through the firewall's online chains); "." keeps the host's search
      // domains out, so a failed lookup doesn't send the LAN's name to them. Private's internal network has no DNS.
      ...(own.dns.length > 0 ? { Dns: [...own.dns], DnsSearch: ["."] } : {}),
      Memory: ws.memoryBytes,
      MemorySwap: ws.memoryBytes + SWAP_HEADROOM_BYTES,
      NanoCpus: ws.nanoCpus,
      PidsLimit: ws.pidsLimit,
      ShmSize: ws.shmBytes,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      // The image runs tini as PID 1 (reaps the agent's orphaned processes).
      Init: false,
      OomScoreAdj: OOM_SCORE_ADJ,
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
  };
}

/**
 * A kind's network, both with no inter-container traffic and no IPv6.
 *   * Private: internal (no route off the host). The host side of the bridge (WORKSPACE_GATEWAY_IP) is the one
 *     address its workspaces can reach, and deploy/firewall.sh limits that to the gateway's service port.
 *   * Online: a bridge with masquerading (NAT) to the internet. deploy/firewall.sh lets it reach public addresses
 *     (any TCP port, DNS to ONLINE_DNS_1/2) and ONLINE_GATEWAY_IP:SERVICE_PORT, and nothing else: not the LAN, the
 *     host, the other workspaces or the stack's own containers.
 */
export function workspaceNetworkOptions(own: KindConfig): Docker.NetworkCreateOptions {
  const online = own.kind === "online";
  return {
    Name: own.network,
    Driver: "bridge",
    Internal: !online,
    EnableIPv6: false,
    Options: {
      "com.docker.network.bridge.name": own.bridge,
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.enable_ip_masquerade": online ? "true" : "false",
    },
    IPAM: { Driver: "default", Config: [{ Subnet: own.subnet, Gateway: own.gatewayIp, IPRange: own.ipRange }] },
    Labels: { "workspace-portal.network": "1", [KIND_LABEL]: own.kind },
  };
}
