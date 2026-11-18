// ImageBuilder backed by the Docker Engine API: the gateway already holds the Docker socket, so the admin console
// can update agents without a shell on the host.
//   * BuildKit (`version: "2"`): workspace-image/Dockerfile uses `COPY --chmod`, which the classic builder refuses.
//   * The context is the project's workspace-image/ directory, mounted read-only (docker-compose.yml), so an edit
//     there applies to the next build. dockerode tars it into the request: nothing is written to disk (the
//     gateway's root filesystem is read-only and its /tmp a small tmpfs).
//   * A BuildKit build needs a session: a second connection to the engine, hijacked for a gRPC server on our side.
//     dockerode's buildImage closes it only when the build stream emits "end", which a refused, aborted or broken
//     build never does. So the builder opens the session itself (with dockerode's own session code), sends the build
//     request the way buildImage does, and closes the session whatever happens.
//   * Builds use a Docker client without dockerode's timeout: that is a socket inactivity timeout
//     (DOCKER_API_TIMEOUT_MS), and a build can stay silent for longer. The caller's AbortSignal bounds a build
//     instead: aborting closes the connection, and the engine cancels the build.
import fs from "node:fs";
import { createRequire } from "node:module";
import Docker from "dockerode";
import { BuildProgress, JsonLineDecoder } from "./build-progress.ts";
import { MIB } from "../config.ts";
import { AGENT_LABEL } from "./container-spec.ts";
import { demuxDockerLogs, DOCKER_API_TIMEOUT_MS, engineMessage, orMissing, statusCode } from "./docker-runtime.ts";
import { BuildError, imageInUse, imageNotFound, VerifyError, type BuildObserver, type BuildSpec, type ImageBuilder, type SweepResult, type WorkspaceImageSummary } from "./image-builder.ts";
import { parseWorkspaceImage, STAGING_REPOSITORY, WORKSPACE_REPOSITORY } from "./image-names.ts";
import { findVersion } from "@portal/core";

/** BuildKit's session for one build (see above). */
interface BuildSession {
  id: string;
  close(): void;
}

type OpenBuildSession = (docker: Docker) => Promise<BuildSession>;

/** The build's query parameters, with the session BuildKit uses (missing from dockerode's types). */
type BuildRequestOptions = Docker.ImageBuildOptions & { session: string };

/** The build context as dockerode packs it: the directory and the entries to include. */
interface BuildContext {
  context: string;
  src: string[];
}

// dockerode's internals that buildImage uses (dockerode is pinned; the tests load them too).
const requireFromDockerode = createRequire(import.meta.url);
const withSession = requireFromDockerode("dockerode/lib/session.js") as (
  docker: Docker,
  auth: undefined,
  handler: (error: Error | null, id: string, done: () => void) => void,
) => void;
const { prepareBuildContext } = requireFromDockerode("dockerode/lib/util.js") as {
  prepareBuildContext(context: BuildContext, next: (tar: NodeJS.ReadableStream) => void): void;
};

/** The session as dockerode's buildImage opens it (anonymous: the base image is public). */
export const openDockerodeSession: OpenBuildSession = (docker) =>
  new Promise((resolve, reject) => withSession(docker, undefined, (error, id, done) => (error ? reject(error) : resolve({ id, close: done }))));

/** `--version` prints and exits; a slow, busy 2-core host still answers well within this. */
const VERIFY_TIMEOUT_MS = 45_000;
const VERIFY_LOG_LINES = 20;
/** Marks the throwaway containers of version checks (never workspace containers). */
const VERIFY_LABEL = "workspace-portal.verify";

interface DockerImageBuilderOptions {
  /** The workspace-image/ directory: the build context. */
  contextDir: string;
  /** For short API calls (with the gateway's usual client timeout). */
  docker?: Docker;
  /** For build streams: no client timeout (see above). */
  buildDocker?: Docker;
  /** Opens a build's BuildKit session (by default as dockerode does). */
  openSession?: OpenBuildSession;
}

export class DockerImageBuilder implements ImageBuilder {
  readonly #contextDir: string;
  readonly #docker: Docker;
  readonly #buildDocker: Docker;
  readonly #openSession: OpenBuildSession;

  constructor(options: DockerImageBuilderOptions) {
    this.#contextDir = options.contextDir;
    this.#docker = options.docker ?? new Docker({ timeout: DOCKER_API_TIMEOUT_MS });
    this.#buildDocker = options.buildDocker ?? new Docker();
    this.#openSession = options.openSession ?? openDockerodeSession;
  }

  async build(spec: BuildSpec, observer: BuildObserver, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const context = this.#context();
    let session: BuildSession;
    try {
      session = await this.#openSession(this.#buildDocker);
    } catch (error) {
      throw new BuildError(`the Docker Engine refused the build session: ${engineMessage(error)}`);
    }
    try {
      signal.throwIfAborted();
      await this.#runBuild(context, { ...buildOptions(spec), session: session.id }, observer, signal);
    } finally {
      session.close();
    }
    if ((await this.#imageId(spec.image)) === null) throw new BuildError(`the build finished, but there is no image ${spec.image}`);
  }

  /** The workspace-image directory to send; BuildError when it can't be read or isn't one. */
  #context(): BuildContext {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.#contextDir);
    } catch (error) {
      throw new BuildError(`the build context ${this.#contextDir} cannot be read: ${engineMessage(error)}`);
    }
    // Docker creates an empty directory for a bind mount whose source is missing.
    if (!entries.includes("Dockerfile")) {
      throw new BuildError(`the build context ${this.#contextDir} has no Dockerfile (docker-compose.yml mounts the project's workspace-image/ directory there)`);
    }
    return { context: this.#contextDir, src: entries };
  }

  /** Sends the build and follows its progress to the end. */
  async #runBuild(context: BuildContext, options: BuildRequestOptions, observer: BuildObserver, signal: AbortSignal): Promise<void> {
    let stream: NodeJS.ReadableStream;
    try {
      stream = await postBuild(this.#buildDocker, context, options, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new BuildError(`the Docker Engine refused the build: ${engineMessage(error)}`);
    }

    const decoder = new JsonLineDecoder();
    const progress = new BuildProgress();
    let step: string | null = null;
    const take = (lines: string[]): void => {
      if (lines.length > 0) observer.onLog(lines);
      if (progress.step !== null && progress.step !== step) {
        step = progress.step;
        observer.onStep(step);
      }
    };
    // docker-modem hands the signal to the HTTP request; destroying the response as well makes sure the
    // loop below ends at once, whatever state the request is in.
    const onAbort = (): void => void (stream as NodeJS.ReadableStream & { destroy(): void }).destroy();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        for (const message of decoder.push(chunk)) take(progress.push(message));
      }
    } catch (error) {
      signal.throwIfAborted();
      throw new BuildError(`the build stream broke off: ${engineMessage(error)}`);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    signal.throwIfAborted();
    for (const message of decoder.end()) take(progress.push(message));
    take(progress.finish());
    if (progress.error !== null) throw new BuildError(progress.error);
  }

  async cliVersion(image: string, cli: string, signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    let container: Docker.Container | null = null;
    try {
      // Inside the try: a refused container (no such image, …) is a VerifyError like any other failure.
      container = await this.#docker.createContainer(verifyContainerOptions(image, cli));
      await container.start();
      const result = (await container.wait({ abortSignal: AbortSignal.any([signal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)]) })) as { StatusCode?: number };
      if (result.StatusCode !== 0) {
        const logs = demuxDockerLogs(await container.logs({ stdout: true, stderr: true, tail: VERIFY_LOG_LINES, follow: false }));
        throw new VerifyError(`\`${cli} --version\` failed (exit code ${result.StatusCode ?? "unknown"})${logs.trim() ? `: ${logs.trim()}` : ""}`);
      }
      const stdout = demuxDockerLogs(await container.logs({ stdout: true, stderr: false, follow: false }));
      return findVersion(stdout);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof VerifyError) throw error;
      if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") {
        throw new VerifyError(`\`${cli} --version\` did not finish within ${VERIFY_TIMEOUT_MS / 1000} s`);
      }
      throw new VerifyError(`\`${cli} --version\` could not run: ${engineMessage(error)}`);
    } finally {
      await container?.remove({ force: true }).catch(() => undefined);
    }
  }

  async promote(staging: string, image: string): Promise<string | null> {
    const before = await this.#imageId(image);
    const { repo, tag } = splitReference(image);
    await this.#docker.getImage(staging).tag({ repo, tag });
    await this.discard(staging);
    const after = await this.#imageId(image);
    return before !== null && before !== after ? before : null;
  }

  async removeUntagged(id: string): Promise<void> {
    const image = await this.#docker.getImage(id).inspect().catch(orMissing(null));
    // Removing by id would take a remaining tag with it: an image that is still tagged is someone's to keep.
    if (image !== null && (image.RepoTags ?? []).length === 0) await removedUnlessBusy(this.#docker.getImage(id).remove());
  }

  async discard(staging: string): Promise<void> {
    await this.#docker.getImage(staging).remove().catch(() => undefined);
  }

  async exists(image: string): Promise<boolean> {
    return (await this.#imageId(image)) !== null;
  }

  async sweep(): Promise<SweepResult> {
    const removed: SweepResult = { containers: [], images: [] };
    // Containers first: a leftover version check holds its image.
    for (const { Id } of await this.#docker.listContainers({ all: true, filters: { label: [VERIFY_LABEL] } })) {
      if (await removedUnlessBusy(this.#docker.getContainer(Id).remove())) removed.containers.push(Id);
    }
    // The filter lists every tag of an image that has a staging tag. Only the staging tags go: a gateway
    // that stopped while promoting leaves the build with its workspace tag as well, maybe the current one.
    for (const { RepoTags } of await this.#docker.listImages({ filters: { reference: [`${STAGING_REPOSITORY}:*`] } })) {
      for (const tag of RepoTags ?? []) {
        if (tag.startsWith(`${STAGING_REPOSITORY}:`) && (await removedUnlessBusy(this.#docker.getImage(tag).remove()))) removed.images.push(tag);
      }
    }
    // A rebuild moves the workspace tag; the build it replaced loses its last tag but stays while a
    // workspace container uses it (or if the gateway stopped before removing it), and only the label
    // workspace-image/Dockerfile's agent stages set still tells it apart.
    for (const { Id } of await this.#docker.listImages({ filters: { dangling: ["true"], label: [AGENT_LABEL] } })) {
      if (await removedUnlessBusy(this.#docker.getImage(Id).remove())) removed.images.push(Id);
    }
    return removed;
  }

  async list(): Promise<WorkspaceImageSummary[]> {
    const rows = await this.#docker.listImages({ filters: { reference: [`${WORKSPACE_REPOSITORY}:*`] } });
    const images: WorkspaceImageSummary[] = [];
    for (const row of rows) {
      for (const tag of row.RepoTags ?? []) {
        const parsed = parseWorkspaceImage(tag);
        if (parsed) images.push({ image: tag, ...parsed, id: row.Id, sizeBytes: Math.max(0, row.Size ?? 0), createdAt: (row.Created ?? 0) * 1000 });
      }
    }
    return images;
  }

  async remove(image: string): Promise<void> {
    try {
      await this.#docker.getImage(image).remove();
    } catch (error) {
      const status = statusCode(error);
      if (status === 404) throw imageNotFound(image);
      if (status === 409) throw imageInUse(image);
      throw error;
    }
  }

  async #imageId(image: string): Promise<string | null> {
    return (await this.#docker.getImage(image).inspect().catch(orMissing(null)))?.Id ?? null;
  }
}

/** As `deploy/lib.sh build_workspace_image` builds: --pull, --target <agent>, --build-arg <KEY>=<version>. */
export function buildOptions(spec: BuildSpec): Docker.ImageBuildOptions {
  return { t: spec.image, target: spec.kind, buildargs: { [spec.versionKey]: spec.version }, pull: true, nocache: spec.noCache, version: "2" };
}

/** POST /build as dockerode's buildImage sends it, minus the session it would open itself. */
function postBuild(docker: Docker, context: BuildContext, options: BuildRequestOptions, signal: AbortSignal): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    prepareBuildContext(context, (tar) => {
      docker.modem.dial(
        { path: "/build?", method: "POST", file: tar, options, abortSignal: signal, isStream: true, statusCodes: { 200: true, 500: "server error" } },
        (error, stream) => (error ? reject(error) : resolve(stream as NodeJS.ReadableStream)),
      );
    });
  });
}

/** True once removed; false when Docker keeps it because it is in use (409) or it is gone (404). */
async function removedUnlessBusy(removal: Promise<unknown>): Promise<boolean> {
  try {
    await removal;
    return true;
  } catch (error) {
    const status = statusCode(error);
    if (status === 404 || status === 409) return false;
    throw error;
  }
}

/** The throwaway container that asks an image's agent CLI for its version, as `deploy/lib.sh check_workspace_image` does but with nothing it doesn't need. */
export function verifyContainerOptions(image: string, cli: string): Docker.ContainerCreateOptions {
  return {
    Image: image,
    Entrypoint: [cli],
    Cmd: ["--version"],
    User: "65534:65534",
    WorkingDir: "/tmp",
    Env: ["HOME=/tmp"],
    Labels: { [VERIFY_LABEL]: "1" },
    NetworkDisabled: true,
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=64m" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 512 * MIB,
      PidsLimit: 128,
      NanoCpus: 1e9,
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
    },
  };
}

/** `repo:tag` → its parts (a registry port before the tag is not a tag). */
function splitReference(reference: string): { repo: string; tag: string } {
  const colon = reference.lastIndexOf(":");
  if (colon <= reference.lastIndexOf("/")) return { repo: reference, tag: "latest" };
  return { repo: reference.slice(0, colon), tag: reference.slice(colon + 1) };
}
