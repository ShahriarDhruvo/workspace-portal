// What WorkspaceManager needs from a container engine. DockerRuntime implements it for real;
// the integration tests use an in-process fake.
import type { AgentKind, WorkspaceKind } from "@portal/core";
import type { WorkspaceStartOptions } from "./container-spec.ts";

export interface StartedContainer {
  id: string;
  /** Address on its kind's network. The service API identifies callers by it, within that network only. */
  ip: string;
  /** Where the agent's web server listens on `ip` (the driver's port for real workspaces). */
  port: number;
}

export interface ContainerSummary {
  id: string;
  /** From the user-id label; null when the label is missing or malformed. */
  userId: number | null;
  /** From the kind label (none means Private, from before kinds); null when it names no known kind. */
  kind: WorkspaceKind | null;
  /** From the agent label (none means Qwen Code, from before the choice); null when it names no known agent. */
  agent: AgentKind | null;
  running: boolean;
  /** Its address on its own kind's network. */
  ip: string | null;
  /** The agent's port; null when the agent is unknown. */
  port: number | null;
  /**
   * The image as the container was created from it (`workspace-portal/workspace:<agent>-<version>`;
   * image-names.ts parseWorkspaceImage reads the version back), or an image id when that tag has
   * moved on since.
   */
  image: string;
  /** From the version label (container-spec.ts VERSION_LABEL); null for containers from before it. */
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
  /** Removes any stale container of this user, of either kind, then creates and starts a new one of `options.kind`. */
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
}
