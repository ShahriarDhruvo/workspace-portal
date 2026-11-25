// What WorkspaceManager needs from a container engine. DockerRuntime implements it for real;
// the integration tests use an in-process fake.
import type { AgentKind, WorkspaceRef } from "@portal/core";

export interface WorkspaceStartOptions {
  /** Which of the user's workspaces. */
  ref: WorkspaceRef;
  /** The agent's credential (driver.credentialEnv); new for every start. */
  credential: string;
  /** The image of the agent's current version (workspace-portal/workspace:<agent>-<version>). */
  image: string;
}

export interface StartedContainer {
  id: string;
  /** Address on its kind's network. The service API identifies callers by it, within that network only. */
  ip: string;
  /** Where the agent's web server listens on `ip` (the driver's port for real workspaces). */
  port: number;
}

/** userId, ref and version are the container's labels: null when one is missing or names nothing known. */
export interface ContainerSummary {
  id: string;
  userId: number | null;
  /**
   * The workspace it is: its agent and kind labels. Null too when the container is not named as that workspace's
   * is (containerName): it is not one the gateway would have created, so nothing about it can be relied on.
   */
  ref: WorkspaceRef | null;
  running: boolean;
  /** Its address on its own kind's network. */
  ip: string | null;
  /** The agent's port; null when the workspace is unknown. */
  port: number | null;
  version: string | null;
}

export type ContainerState =
  | { running: true }
  | { running: false; exitCode: number | null; oomKilled: boolean };

export type ContainerSample =
  | { running: false }
  | {
      running: true;
      memoryBytes: number | null;
      /**
       * CPU time the container has used since it started, in seconds, or null when unknown. The
       * manager turns two samples into an average over the interval between them.
       */
      cpuSeconds: number | null;
    };

export class WorkspaceImageMissingError extends Error {
  constructor(image: string) {
    super(`workspace image ${image} not found`);
    this.name = "WorkspaceImageMissingError";
  }
}

export interface ContainerRuntime {
  /** Removes any stale container of this user, whichever workspace's, then creates and starts `options.ref`'s. */
  startWorkspace(userId: number, options: WorkspaceStartOptions): Promise<StartedContainer>;
  /** The credential a running container's agent was started with; null if unknown or gone. */
  credential(id: string, agent: AgentKind): Promise<string | null>;
  /** Graceful stop (10 s) followed by forced removal. Succeeds if the container is already gone. */
  stopContainer(id: string): Promise<void>;
  /** Forced removal. Succeeds if the container is already gone. */
  removeContainer(id: string): Promise<void>;
  /** A container that does not exist reports as not running with an unknown exit code. */
  state(id: string): Promise<ContainerState>;
  /** Every workspace container, running or not. */
  list(): Promise<ContainerSummary[]>;
  logsTail(id: string, lines: number): Promise<string>;
  sample(id: string): Promise<ContainerSample>;
  /** A running container's TCP sockets as its kernel lists them (/proc/net/tcp, then tcp6), for workspaces/servers.ts to read. */
  sockets(id: string): Promise<string>;
}
