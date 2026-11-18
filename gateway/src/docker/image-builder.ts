// What the agent updater needs from the image side of the container engine: build an agent's
// workspace image, ask the image which version it contains, give a checked image its workspace tag,
// list and remove workspace images, and clear away what interrupted updates leave behind.
// DockerImageBuilder implements it with the Docker Engine API; the tests use a fake.
import type { AgentKind } from "@portal/core";
import { HttpError } from "../lib/http-util.ts";

export interface BuildSpec {
  kind: AgentKind;
  version: string;
  /** The Dockerfile build argument that carries the version (the driver's release.versionKey). */
  versionKey: string;
  /** The tag the build gets. */
  image: string;
  /** Without the build cache: fresh Debian packages and a fresh npm install. */
  noCache: boolean;
}

export interface BuildObserver {
  /** The step the build is at, as BuildKit names it (`[qwen 1/3] RUN npm install -g …`). */
  onStep(step: string): void;
  /** New lines of build output. */
  onLog(lines: string[]): void;
}

/** A workspace image Docker has, one per tag. */
export interface WorkspaceImageSummary {
  image: string;
  kind: AgentKind;
  version: string;
  /** The image id: tags of the same build share it. */
  id: string;
  sizeBytes: number;
  /** Epoch ms. */
  createdAt: number;
}

/** What sweep() removed: container ids, and image tags or ids. */
export interface SweepResult {
  containers: string[];
  images: string[];
}

/** The engine refused or failed the build; the message is what it reported. */
export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}

/** The image's own CLI could not report a version. */
export class VerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

export const imageNotFound = (image: string): HttpError => new HttpError(404, "not_found", `There is no image ${image}.`);

/** A container (running or not) uses the image, so Docker keeps it. */
export const imageInUse = (image: string): HttpError =>
  new HttpError(409, "image_in_use", `${image} is in use by a workspace container. It can be removed once that workspace has stopped.`);

export interface ImageBuilder {
  /**
   * Builds `spec.image` from the workspace-image Dockerfile (target = the agent kind). Rejects with
   * BuildError when the build fails; when `signal` aborts, the build is abandoned and the promise
   * rejects with the signal's reason.
   */
  build(spec: BuildSpec, observer: BuildObserver, signal: AbortSignal): Promise<void>;
  /**
   * Runs `<cli> --version` in a throwaway container of `image` without network or privileges and
   * returns the version it prints, or null when it prints none. Rejects with VerifyError when the
   * command fails.
   */
  cliVersion(image: string, cli: string, signal: AbortSignal): Promise<string | null>;
  /**
   * Gives the image tagged `staging` the tag `image` and drops the staging tag. Resolves with the id of
   * the image `image` named before when the tag moved off it, else null (no such tag before, or the
   * same image). That image stays: removeUntagged removes it.
   */
  promote(staging: string, image: string): Promise<string | null>;
  /**
   * Removes the image with this id, never forcing. It stays if a tag still names it or a container
   * (running or not) uses it; missing is fine.
   */
  removeUntagged(id: string): Promise<void>;
  /** Drops a staging tag (and the image, unless another tag names it). Missing is fine. */
  discard(staging: string): Promise<void>;
  /** Whether Docker has an image by this name. */
  exists(image: string): Promise<boolean>;
  /**
   * Removes what interrupted updates leave behind (a gateway that stopped mid-job, a discard that
   * failed): version-check containers, staging tags (only those: never another tag of the same
   * image), and agent builds left without a tag because a rebuild moved theirs (a workspace still used
   * them, or the gateway stopped first). Never forces: whatever is still in use stays (for a later
   * sweep). Returns what it removed.
   */
  sweep(): Promise<SweepResult>;
  /** Every workspace image tag (workspace-portal/workspace:<agent>-<version>). */
  list(): Promise<WorkspaceImageSummary[]>;
  /** Removes one tag, never forcing. Rejects with imageNotFound or imageInUse. */
  remove(image: string): Promise<void>;
}
