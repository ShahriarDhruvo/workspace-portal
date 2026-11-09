// Docker objects the gateway creates: per-user workspace containers and the workspace network.
//
// A workspace container gets as little as possible:
//   * its own UID (no other workspace and no host account shares it), no capabilities,
//     no-new-privileges, memory/CPU/PID limits, and the OOM killer's attention first;
//   * a read-only root filesystem; writable are only the user's own home and workspace
//     directories and an in-memory /tmp;
//   * read-only, per-user copies of the Qwen Code settings and of /etc/passwd and /etc/group;
//     nothing on the host is mounted that another workspace also sees;
//   * an *internal* network with inter-container traffic disabled: the only address it can reach
//     is the gateway's service port (model + web search). No internet, no LAN, no other workspace.
import type Docker from "dockerode";
import { MIB, type Config, type WorkspaceConfig } from "./config.ts";
import { userPaths, workspaceOwner } from "./paths.ts";
import { LLM_KEY_ENV, QWEN_SETTINGS_MOUNT } from "./qwen.ts";

export const WORKSPACE_LABEL = "workspace-portal.workspace";
export const USER_ID_LABEL = "workspace-portal.user-id";
/** The env var carrying the per-start token of `qwen serve`; read back when adopting a container. */
export const TOKEN_ENV = "QWEN_SERVER_TOKEN";

/** Swap allowed on top of the memory limit, so short spikes slow down instead of OOM-killing the agent. */
const SWAP_HEADROOM_BYTES = 512 * MIB;
/** Makes workspaces the OOM killer's first choice, so the LLM server survives a memory shortage. */
const OOM_SCORE_ADJ = 500;

export function containerName(userId: number): string {
  return `wp-ws-${userId}`;
}

export interface WorkspaceStartOptions {
  /** Bearer token `qwen serve` requires; new for every start. */
  token: string;
}

export function workspaceContainerOptions(config: Config, userId: number, options: WorkspaceStartOptions): Docker.ContainerCreateOptions {
  const ws = config.workspace;
  const paths = userPaths(config.dataDir, userId);
  const owner = workspaceOwner(ws.uidBase, userId);
  return {
    name: containerName(userId),
    Hostname: "workspace",
    Image: ws.image,
    User: `${owner.uid}:${owner.gid}`,
    WorkingDir: "/workspace",
    Labels: { [WORKSPACE_LABEL]: "1", [USER_ID_LABEL]: String(userId) },
    Env: [
      `${TOKEN_ENV}=${options.token}`,
      // A placeholder: the gateway replaces it with the real LLM key, which never enters a workspace.
      `${LLM_KEY_ENV}=portal`,
      "HOME=/home/user",
      "USER=user",
      "LOGNAME=user",
      "QWEN_USAGE_STATISTICS_ENABLED=false",
      // An approval nobody answers is declined after this long, so it can't keep the workspace up forever.
      `QWEN_PERMISSION_TIMEOUT_MS=${config.idleTimeoutMs}`,
    ],
    HostConfig: {
      // The data dir is labelled container_file_t by the installer, so no :z relabelling here.
      Binds: [
        `${paths.home}:/home/user`,
        `${paths.workspace}:/workspace`,
        `${paths.qwenSettings}:${QWEN_SETTINGS_MOUNT}:ro`,
        `${paths.passwd}:/etc/passwd:ro`,
        `${paths.group}:/etc/group:ro`,
      ],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${ws.tmpBytes}` },
      NetworkMode: ws.network,
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
 * The workspace network: internal (no route off the host), no inter-container traffic, no IPv6.
 * The host side of the bridge (WORKSPACE_GATEWAY_IP) is the one address workspaces can reach, and
 * deploy/firewall.sh limits that to the gateway's service port.
 */
export function workspaceNetworkOptions(ws: WorkspaceConfig): Docker.NetworkCreateOptions {
  return {
    Name: ws.network,
    Driver: "bridge",
    Internal: true,
    EnableIPv6: false,
    Options: {
      "com.docker.network.bridge.name": ws.bridge,
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.enable_ip_masquerade": "false",
    },
    IPAM: { Driver: "default", Config: [{ Subnet: ws.subnet, Gateway: ws.gatewayIp, IPRange: ws.ipRange }] },
    Labels: { "workspace-portal.network": "1" },
  };
}
