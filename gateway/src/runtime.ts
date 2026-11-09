// What WorkspaceManager needs from a container engine. DockerRuntime implements it for real;
// the integration tests use an in-process fake.
import type { WorkspaceStartOptions } from "./container-spec.ts";

export interface StartedContainer {
  id: string;
  /** Address on the workspace network. The service API identifies callers by it. */
  ip: string;
  /** Where `qwen serve` listens on `ip` (4170 for real workspaces). */
  port: number;
}

export interface ContainerSummary {
  id: string;
  /** From the user-id label; null when the label is missing or malformed. */
  userId: number | null;
  running: boolean;
  ip: string | null;
  port: number;
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
  /** Removes any stale container for this user, then creates and starts a new one. */
  startWorkspace(userId: number, options: WorkspaceStartOptions): Promise<StartedContainer>;
  /** The token a running container's `qwen serve` was started with; null if unknown or gone. */
  serverToken(id: string): Promise<string | null>;
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
