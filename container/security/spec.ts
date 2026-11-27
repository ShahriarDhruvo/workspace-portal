// The security profile of a workspace container (one per workspace, wp-<agent>-<kind>-<user id>; of a user's, one at
// a time). It is the same whichever harness the workspace runs and whoever it belongs to: a container gets as little
// as possible. A UID no other workspace (not even another of the same user) and no host account shares, a read-only
// root, no capability, nothing mounted that another workspace also sees, and its kind's network (network.ts). The
// gateway fills in whose it is and what its harness needs: an environment and where its settings are mounted.
import type Docker from "dockerode";
import type { WorkspaceRef } from "@portal/core";
import type { KindNetwork } from "./network.ts";

export const WORKSPACE_LABEL = "workspace-portal.workspace";
export const USER_ID_LABEL = "workspace-portal.user-id";
export const AGENT_LABEL = "workspace-portal.agent";
/** Docker lists a container's image as an image id once its tag has moved to a rebuild, so a restarted gateway reads the version from here. */
export const VERSION_LABEL = "workspace-portal.version";
export const KIND_LABEL = "workspace-portal.kind";

/** Swap allowed on top of the memory limit, so short spikes slow down instead of OOM-killing the agent. */
const SWAP_HEADROOM_BYTES = 512 * 1024 * 1024;
/** Makes workspaces the OOM killer's first choice, so the AI server survives a memory shortage. */
const OOM_SCORE_ADJ = 500;

export function containerName(userId: number, ref: WorkspaceRef): string {
  return `wp-${ref.agent}-${ref.kind}-${userId}`;
}

/**
 * What every container started from a workspace image runs with, the throwaway ones included (the gateway's version
 * check, the installer's, the isolation probe's): a read-only root with a small /tmp nothing can be set-uid in, no
 * capability, and no way to gain one. sandbox.sh says the same to the shell scripts (spec.test.ts compares them).
 */
export function sandbox(tmpBytes: number): Pick<Docker.HostConfig, "ReadonlyRootfs" | "Tmpfs" | "CapDrop" | "SecurityOpt"> {
  return {
    ReadonlyRootfs: true,
    Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${tmpBytes}` },
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
  };
}

export interface WorkspaceContainer {
  userId: number;
  ref: WorkspaceRef;
  image: string;
  /** The harness version the image holds, for VERSION_LABEL; undefined when the image's name doesn't say. */
  version: string | undefined;
  /** The account it runs as, and no other workspace does. */
  owner: { uid: number; gid: number };
  /** Host paths: the workspace's own two folders, and what the gateway rendered for it (mounted read-only). */
  paths: { home: string; workspace: string; settings: string; passwd: string; group: string };
  /** Where the harness reads its settings directory. */
  settingsMount: string;
  /** The harness's environment, its per-start credential included. */
  env: readonly string[];
  network: KindNetwork;
  limits: { memoryBytes: number; nanoCpus: number; pidsLimit: number; shmBytes: number; tmpBytes: number };
}

export function workspaceContainerOptions(workspace: WorkspaceContainer): Docker.ContainerCreateOptions {
  const { userId, ref, version, owner, paths, network, limits } = workspace;
  return {
    name: containerName(userId, ref),
    Hostname: "workspace",
    Image: workspace.image,
    User: `${owner.uid}:${owner.gid}`,
    WorkingDir: "/workspace",
    Labels: {
      [WORKSPACE_LABEL]: "1",
      [USER_ID_LABEL]: String(userId),
      [KIND_LABEL]: ref.kind,
      [AGENT_LABEL]: ref.agent,
      ...(version ? { [VERSION_LABEL]: version } : {}),
    },
    Env: ["HOME=/home/user", "USER=user", "LOGNAME=user", ...workspace.env],
    HostConfig: {
      // The data dir is labelled container_file_t by the installer, so no :z relabelling here.
      Binds: [
        `${paths.home}:/home/user`,
        `${paths.workspace}:/workspace`,
        `${paths.settings}:${workspace.settingsMount}:ro`,
        `${paths.passwd}:/etc/passwd:ro`,
        `${paths.group}:/etc/group:ro`,
      ],
      ...sandbox(limits.tmpBytes),
      NetworkMode: network.network,
      // Online resolves names through its two resolvers (Docker's embedded DNS forwards to them, from the
      // container's own network namespace, so through the firewall's online chains); "." keeps the host's search
      // domains out, so a failed lookup doesn't send the LAN's name to them. Private's internal network has no DNS.
      ...(network.dns.length > 0 ? { Dns: [...network.dns], DnsSearch: ["."] } : {}),
      Memory: limits.memoryBytes,
      MemorySwap: limits.memoryBytes + SWAP_HEADROOM_BYTES,
      NanoCpus: limits.nanoCpus,
      PidsLimit: limits.pidsLimit,
      ShmSize: limits.shmBytes,
      // The image runs tini as PID 1 (reaps the agent's orphaned processes).
      Init: false,
      OomScoreAdj: OOM_SCORE_ADJ,
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
  };
}
