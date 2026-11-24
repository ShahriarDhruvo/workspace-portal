// Docker objects the gateway creates: the workspace containers (one per workspace, wp-<agent>-<kind>-<user id>; of a
// user's, one at a time) and the two workspace networks.
//
// A workspace container gets as little as possible: a UID no other workspace (not even another of the same user)
// and no host account shares, nothing mounted that another workspace also sees, and its kind's network
// (workspaceNetworkOptions). That is the same whichever workspace it is: the agent's driver adds only its port,
// environment and settings, the kind only its network and DNS.
import type Docker from "dockerode";
import type { WorkspaceRef } from "@portal/core";
import { driverFor, LLM_KEY_ENV } from "../agents/index.ts";
import { MIB, type Config, type KindConfig } from "../config.ts";
import { parseWorkspaceImage } from "./image-names.ts";
import { workspaceOwner, workspacePaths } from "../workspaces/paths.ts";

export const WORKSPACE_LABEL = "workspace-portal.workspace";
export const USER_ID_LABEL = "workspace-portal.user-id";
export const AGENT_LABEL = "workspace-portal.agent";
/** Docker lists a container's image as an image id once its tag has moved to a rebuild, so a restarted gateway reads the version from here. */
export const VERSION_LABEL = "workspace-portal.version";
export const KIND_LABEL = "workspace-portal.kind";

/** Swap allowed on top of the memory limit, so short spikes slow down instead of OOM-killing the agent. */
const SWAP_HEADROOM_BYTES = 512 * MIB;
/** Makes workspaces the OOM killer's first choice, so the LLM server survives a memory shortage. */
const OOM_SCORE_ADJ = 500;

export function containerName(userId: number, ref: WorkspaceRef): string {
  return `wp-${ref.agent}-${ref.kind}-${userId}`;
}

export interface WorkspaceStartOptions {
  /** Which of the user's workspaces. */
  ref: WorkspaceRef;
  /** The agent's credential (driver.credentialEnv); new for every start. */
  credential: string;
  /** The image of the agent's current version (workspace-portal/workspace:<agent>-<version>). */
  image: string;
}

export function workspaceContainerOptions(config: Config, userId: number, { ref, credential, image }: WorkspaceStartOptions): Docker.ContainerCreateOptions {
  const ws = config.workspace;
  const own = ws.kinds[ref.kind];
  const driver = driverFor(ref.agent);
  const paths = workspacePaths(config.dataDir, userId, ref);
  const owner = workspaceOwner(config, userId, ref);
  const version = parseWorkspaceImage(image)?.version;
  return {
    name: containerName(userId, ref),
    Hostname: "workspace",
    Image: image,
    User: `${owner.uid}:${owner.gid}`,
    WorkingDir: "/workspace",
    Labels: {
      [WORKSPACE_LABEL]: "1",
      [USER_ID_LABEL]: String(userId),
      [KIND_LABEL]: ref.kind,
      [AGENT_LABEL]: ref.agent,
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
        `${paths.settings}:${driver.settingsMount}:ro`,
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
