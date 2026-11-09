// Docker objects the gateway creates: per-user workspace containers and the workspace network.
//
// A workspace container gets as little as possible:
//   * its own UID (no other workspace and no host account shares it), no capabilities,
//     no-new-privileges, memory/CPU/PID limits, and the OOM killer's attention first;
//   * a read-only root filesystem; writable are only the user's own home and workspace
//     directories and an in-memory /tmp;
//   * read-only, per-user copies of the agent's settings and of /etc/passwd and /etc/group;
//     nothing on the host is mounted that another workspace also sees;
//   * an *internal* network with inter-container traffic disabled: the only address it can reach
//     is the gateway's service port (model + web search). No internet, no LAN, no other workspace.
// All of this is the same whichever agent the workspace runs; the driver adds only its image,
// port, environment and settings.
import type Docker from "dockerode";
import type { AgentKind } from "@portal/db";
import { LLM_KEY_ENV, type AgentDriver } from "./agents/index.ts";
import { MIB, type Config, type WorkspaceConfig } from "./config.ts";
import { userPaths, workspaceOwner } from "./paths.ts";

export const WORKSPACE_LABEL = "workspace-portal.workspace";
export const USER_ID_LABEL = "workspace-portal.user-id";
/** The agent the container runs (an AgentKind). Containers from before the choice have none: Qwen Code. */
export const AGENT_LABEL = "workspace-portal.agent";

/** Swap allowed on top of the memory limit, so short spikes slow down instead of OOM-killing the agent. */
const SWAP_HEADROOM_BYTES = 512 * MIB;
/** Makes workspaces the OOM killer's first choice, so the LLM server survives a memory shortage. */
const OOM_SCORE_ADJ = 500;

export function containerName(userId: number): string {
  return `wp-ws-${userId}`;
}

export interface WorkspaceStartOptions {
  agent: AgentKind;
  /** The agent's credential (driver.credentialEnv); new for every start. */
  credential: string;
}

export function workspaceContainerOptions(config: Config, userId: number, driver: AgentDriver, credential: string): Docker.ContainerCreateOptions {
  const ws = config.workspace;
  const paths = userPaths(config.dataDir, userId);
  const owner = workspaceOwner(ws.uidBase, userId);
  return {
    name: containerName(userId),
    Hostname: "workspace",
    Image: ws.images[driver.kind].image,
    User: `${owner.uid}:${owner.gid}`,
    WorkingDir: "/workspace",
    Labels: { [WORKSPACE_LABEL]: "1", [USER_ID_LABEL]: String(userId), [AGENT_LABEL]: driver.kind },
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
