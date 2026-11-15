import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type Docker from "dockerode";
import type DockerModem from "docker-modem";
import { buildOptions, DockerImageBuilder, openDockerodeSession, verifyContainerOptions } from "./docker-image-builder.ts";
import { BuildError, ImageInUseError, ImageNotFoundError, type BuildSpec } from "./image-builder.ts";
import { stagingImage, workspaceImage } from "./image-names.ts";

const FIXTURES = new URL("../test/fixtures/", import.meta.url);
const CONTEXT = fileURLToPath(new URL("../../workspace-image", import.meta.url));
const SPEC: BuildSpec = { kind: "qwen", version: "0.27.4", versionKey: "QWEN_CODE_VERSION", image: stagingImage("qwen", "0.27.4"), noCache: false };

function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const dockerError = (statusCode: number, message: string): Error => Object.assign(new Error(`(HTTP code ${statusCode}) ${message}`), { statusCode, json: { message } });

interface FakeSetup {
  images?: Record<string, string>;
  stream?: () => NodeJS.ReadableStream;
  buildError?: Error;
  /** The engine doesn't answer the build request until it is aborted. */
  buildHangs?: boolean;
  sessionError?: Error;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  waitForever?: boolean;
  /** Version-check containers left over, and dangling agent builds; "busy-…" ones are in use (409). */
  verifyContainers?: string[];
  dangling?: string[];
  /** The tags of an image with leftover staging tags (Docker lists all of them for a reference filter). */
  staging?: string[];
  /** Ids of images no tag names (a build a rebuild replaced). */
  untagged?: string[];
  /** createContainer fails with this. */
  createError?: Error;
}

/** A dockerode stand-in: image tags → ids, build requests (docker-modem) with their sessions, throwaway containers. */
function fakeDocker(setup: FakeSetup = {}) {
  const images = new Map(Object.entries(setup.images ?? {}));
  const untagged = new Set(setup.untagged ?? []);
  const tagsOf = (id: string): string[] => [...images].filter(([, other]) => other === id).map(([tag]) => tag);
  const calls: string[] = [];
  const builds: Array<{ path: string; method?: string; isStream?: boolean; file: unknown; options: Record<string, unknown> }> = [];
  const sessions = { opened: 0, closed: 0 };
  const created: Docker.ContainerCreateOptions[] = [];
  const removed: string[] = [];
  const openSession = async () => {
    if (setup.sessionError) throw setup.sessionError;
    const id = `session-${++sessions.opened}`;
    return { id, close: () => void sessions.closed++ };
  };
  const removal = (what: string) => async () => {
    calls.push(`remove ${what}`);
    if (what.includes("busy-")) throw dockerError(409, `conflict: ${what} is in use`);
    if (what.includes("gone-")) throw dockerError(404, `No such ${what}`);
  };
  const docker = {
    modem: {
      dial(options: DockerModem.DialOptions, callback: (error: unknown, stream?: unknown) => void) {
        builds.push({ path: options.path, method: options.method, isStream: options.isStream, file: options.file, options: { ...options.options } });
        (options.file as NodeJS.ReadableStream).resume();
        if (setup.buildError) return callback(setup.buildError);
        if (setup.buildHangs) {
          // As the HTTP request does: an abort (also an earlier one) fails it.
          const aborted = () => callback(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          if (options.abortSignal?.aborted) aborted();
          else options.abortSignal?.addEventListener("abort", aborted);
          return;
        }
        const stream = setup.stream?.() ?? Readable.from([]);
        stream.on("end", () => images.set(options.options!.t as string, "sha256:new"));
        callback(null, stream);
      },
    },
    async listContainers(options: { all: boolean; filters: unknown }) {
      calls.push(`list containers ${JSON.stringify(options)}`);
      return (setup.verifyContainers ?? []).map((Id) => ({ Id }));
    },
    getContainer(id: string) {
      return { remove: removal(`container ${id}`) };
    },
    getImage(reference: string) {
      return {
        async inspect() {
          const byId = reference.startsWith("sha256:") && (untagged.has(reference) || tagsOf(reference).length > 0);
          const id = images.get(reference) ?? (byId ? reference : undefined);
          if (!id) throw dockerError(404, `No such image: ${reference}`);
          return { Id: id, RepoTags: tagsOf(id) };
        },
        async tag({ repo, tag }: { repo: string; tag: string }) {
          calls.push(`tag ${reference} ${repo}:${tag}`);
          const before = images.get(`${repo}:${tag}`);
          images.set(`${repo}:${tag}`, images.get(reference)!);
          // As Docker does: the image the tag moved off stays, untagged unless another tag names it.
          if (before !== undefined && tagsOf(before).length === 0) untagged.add(before);
        },
        async remove() {
          if (reference.includes("busy-") || reference.includes("gone-") || reference.startsWith("workspace-portal/workspace-build:leftover")) return removal(`image ${reference}`)();
          calls.push(`remove ${reference}`);
          if (reference === "workspace-portal/workspace:qwen-0.26.0") throw dockerError(409, "conflict: unable to remove repository reference (must force) - container abc is using its referenced image");
          if (reference.startsWith("sha256:")) {
            untagged.delete(reference);
            for (const [tag, id] of images) if (id === reference) images.delete(tag);
            return;
          }
          if (!images.delete(reference)) throw dockerError(404, `No such image: ${reference}`);
        },
      };
    },
    async listImages(options: { filters: Record<string, string[]> }) {
      calls.push(`list ${JSON.stringify(options.filters)}`);
      if (options.filters.dangling) return (setup.dangling ?? []).map((Id) => ({ Id, RepoTags: undefined }));
      if (options.filters.reference?.[0]?.startsWith("workspace-portal/workspace-build:")) return [{ Id: "sha256:s", RepoTags: setup.staging ?? [] }];
      return [
        { Id: "sha256:a", RepoTags: ["workspace-portal/workspace:qwen-0.27.4", "workspace-portal/workspace:qwen-0.27.4-copy"], Size: 2_014_620_610, Created: 1_794_729_782 },
        { Id: "sha256:b", RepoTags: ["workspace-portal/workspace:dsh-0.2.2-rc.1"], Size: 1_900_000_000, Created: 1_794_000_000 },
        { Id: "sha256:c", RepoTags: ["workspace-portal/workspace:latest"], Size: 1, Created: 1 },
        { Id: "sha256:d", RepoTags: undefined, Size: 1, Created: 1 },
      ];
    },
    async createContainer(options: Docker.ContainerCreateOptions) {
      created.push(options);
      if (setup.createError) throw setup.createError;
      return {
        id: "verify-1",
        async start() {
          calls.push("start");
        },
        async wait({ abortSignal }: { abortSignal: AbortSignal }) {
          if (setup.waitForever) return new Promise((_resolve, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason)));
          return { StatusCode: setup.exitCode ?? 0 };
        },
        async logs(options: { stdout: boolean; stderr: boolean }) {
          return Buffer.concat([...(options.stdout ? [frame(1, setup.stdout ?? "0.27.4\n")] : []), ...(options.stderr ? [frame(2, setup.stderr ?? "")] : [])]);
        },
        async remove(options: { force: boolean }) {
          removed.push(`verify-1 force=${options.force}`);
        },
      };
    },
  };
  return { docker: docker as unknown as Docker, openSession, sessions, images, untagged, calls, builds, created, removed };
}

function builder(fake: ReturnType<typeof fakeDocker>, contextDir = CONTEXT): DockerImageBuilder {
  return new DockerImageBuilder({ contextDir, docker: fake.docker, buildDocker: fake.docker, openSession: fake.openSession });
}

/** Resolves once the build request has gone out. */
async function sent(fake: ReturnType<typeof fakeDocker>): Promise<void> {
  while (fake.builds.length === 0) await new Promise((resolve) => setImmediate(resolve));
}

function recorder() {
  const steps: string[] = [];
  const lines: string[] = [];
  return { steps, lines, observer: { onStep: (step: string) => void steps.push(step), onLog: (more: string[]) => void lines.push(...more) } };
}

test("builds use BuildKit with the options deploy/lib.sh uses", () => {
  assert.deepEqual(buildOptions({ ...SPEC, noCache: true }), {
    t: "workspace-portal/workspace-build:qwen-0.27.4",
    target: "qwen",
    buildargs: { QWEN_CODE_VERSION: "0.27.4" },
    pull: true,
    nocache: true,
    version: "2",
  });
});

test("the version check runs the CLI without network, privileges or a writable root", () => {
  assert.deepEqual(verifyContainerOptions("img", "dsh"), {
    Image: "img",
    Entrypoint: ["dsh"],
    Cmd: ["--version"],
    User: "65534:65534",
    WorkingDir: "/tmp",
    Env: ["HOME=/tmp"],
    Labels: { "workspace-portal.verify": "1" },
    NetworkDisabled: true,
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=64m" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      PidsLimit: 128,
      NanoCpus: 1e9,
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
    },
  });
});

test("build streams the workspace-image directory in its own BuildKit session and reports the recorded progress", async () => {
  const trace = fs.readFileSync(new URL("buildkit-qwen-0.27.4.jsonl", FIXTURES));
  const fake = fakeDocker({ stream: () => Readable.from([trace.subarray(0, 5000), trace.subarray(5000)]) });
  const { steps, lines, observer } = recorder();
  await builder(fake).build(SPEC, observer, new AbortController().signal);
  const { file, ...request } = fake.builds[0]!;
  assert.deepEqual(request, { path: "/build?", method: "POST", isStream: true, options: { ...buildOptions(SPEC), session: "session-1" } }, "as dockerode's buildImage sends it");
  assert.ok(file instanceof Readable, "the directory, tarred on the fly");
  assert.deepEqual(fake.sessions, { opened: 1, closed: 1 }, "the session is closed once the build is over");
  assert.ok(steps.includes("exporting to image"));
  assert.ok(lines.some((line) => line.endsWith("added 14 packages in 7s")));
});

test("a failed build rejects with the engine's message after showing the output", async () => {
  const trace = fs.readFileSync(new URL("buildkit-qwen-9.9.9-failed.jsonl", FIXTURES));
  const fake = fakeDocker({ stream: () => Readable.from([trace]) });
  const { lines, observer } = recorder();
  await assert.rejects(builder(fake).build({ ...SPEC, version: "9.9.9" }, observer, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof BuildError);
    assert.match(error.message, /did not complete successfully: exit code: 1$/);
    return true;
  });
  assert.ok(lines.some((line) => line.includes("No matching version found for @qwen-code/qwen-code@9.9.9")));
  assert.deepEqual(fake.sessions, { opened: 1, closed: 1 });
});

test("a refused build, a missing or empty context, a refused session or a missing result is a BuildError", async () => {
  const signal = new AbortController().signal;
  const { observer } = recorder();
  const refused = fakeDocker({ buildError: dockerError(400, "target stage qwen could not be found") });
  await assert.rejects(builder(refused).build(SPEC, observer, signal), {
    name: "BuildError",
    message: "the Docker Engine refused the build: target stage qwen could not be found",
  });
  assert.deepEqual(refused.sessions, { opened: 1, closed: 1 }, "dockerode would leave this session open: there is no stream to end");

  const missing = path.join(os.tmpdir(), "no-such-workspace-image-dir");
  const noContext = fakeDocker();
  await assert.rejects(builder(noContext, missing).build(SPEC, observer, signal), (error: unknown) => error instanceof BuildError && error.message.startsWith(`the build context ${missing} cannot be read`));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-image-"));
  try {
    await assert.rejects(builder(noContext, empty).build(SPEC, observer, signal), {
      name: "BuildError",
      message: `the build context ${empty} has no Dockerfile (docker-compose.yml mounts the project's workspace-image/ directory there)`,
    });
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
  assert.deepEqual([noContext.sessions.opened, noContext.builds.length], [0, 0], "nothing sent");

  const noSession = fakeDocker({ sessionError: dockerError(500, "session not supported") });
  await assert.rejects(builder(noSession).build(SPEC, observer, signal), { name: "BuildError", message: "the Docker Engine refused the build session: session not supported" });
  assert.equal(noSession.builds.length, 0);

  const noImage = fakeDocker({ stream: () => Readable.from(['{"stream":"done\\n"}\n']) });
  noImage.docker.getImage = (() => ({ inspect: async () => Promise.reject(dockerError(404, "No such image")) })) as unknown as Docker["getImage"];
  await assert.rejects(builder(noImage).build(SPEC, observer, signal), { message: "the build finished, but there is no image workspace-portal/workspace-build:qwen-0.27.4" });
  assert.deepEqual(noImage.sessions, { opened: 1, closed: 1 });
});

test("aborting ends the build stream at once and rejects with the signal's reason", async () => {
  const stream = new PassThrough();
  const fake = fakeDocker({ stream: () => stream });
  const abort = new AbortController();
  const { observer } = recorder();
  const building = builder(fake).build(SPEC, observer, abort.signal);
  stream.write('{"stream":"Step 1/2\\n"}\n');
  await sent(fake);
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort(new Error("cancelled"));
  await assert.rejects(building, { message: "cancelled" });
  assert.equal(stream.destroyed, true, "the connection is closed, so the engine cancels the build");
  assert.deepEqual(fake.sessions, { opened: 1, closed: 1 }, "and the session too (a destroyed stream never emits the end dockerode waits for)");
  await assert.rejects(builder(fake).build(SPEC, observer, abort.signal), { message: "cancelled" }, "an aborted signal builds nothing");
  assert.deepEqual([fake.builds.length, fake.sessions.opened], [1, 1]);

  // Aborted (or timed out) before the engine answered: no stream at all, and still no session left open.
  const silent = fakeDocker({ buildHangs: true });
  const timeout = new AbortController();
  const waiting = builder(silent).build(SPEC, observer, timeout.signal);
  await sent(silent);
  timeout.abort(new Error("time limit"));
  await assert.rejects(waiting, { message: "time limit" });
  assert.deepEqual(silent.sessions, { opened: 1, closed: 1 });

  // A stream that breaks off.
  const broken = new PassThrough();
  const breaking = fakeDocker({ stream: () => broken });
  const failing = builder(breaking).build(SPEC, observer, new AbortController().signal);
  await sent(breaking);
  broken.destroy(new Error("connection reset"));
  await assert.rejects(failing, { name: "BuildError", message: "the build stream broke off: connection reset" });
  assert.deepEqual(breaking.sessions, { opened: 1, closed: 1 });
});

test("the session is dockerode's own: a hijacked /session connection that close() ends", async () => {
  const refusing = { modem: { dial: (options: DockerModem.DialOptions, callback: (error: unknown) => void) => callback(Object.assign(new Error("refused"), { options })) } };
  await assert.rejects(openDockerodeSession(refusing as unknown as Docker), (error: unknown) => {
    const { path: route, hijack, headers } = (error as { options: DockerModem.DialOptions }).options;
    assert.deepEqual([route, hijack, (headers as Record<string, string>).Upgrade], ["/session", true, "h2c"]);
    return true;
  });

  // The engine's end of the session: closing it from our side reaches it.
  const ended = new Promise<void>((resolve) => {
    const server = net.createServer((socket) => {
      socket.resume();
      socket.on("end", () => {
        socket.destroy();
        server.close();
        resolve();
      });
    });
    server.listen(0, "127.0.0.1", async () => {
      const client = net.connect((server.address() as AddressInfo).port, "127.0.0.1");
      const accepting = { modem: { dial: (_options: unknown, callback: (error: null, socket: net.Socket) => void) => client.once("connect", () => callback(null, client)) } };
      const session = await openDockerodeSession(accepting as unknown as Docker);
      assert.match(session.id, /^[0-9a-f-]{36}$/);
      session.close();
    });
  });
  await ended;
});

test("cliVersion reads the version from stdout and always removes the container", async () => {
  const ok = fakeDocker({ stdout: "Qwen Code 0.27.4 (linux)\n", stderr: "warning: 9.9.9 is irrelevant\n" });
  assert.equal(await builder(ok).cliVersion("img", "qwen", new AbortController().signal), "0.27.4");
  assert.deepEqual(ok.created.map((c) => [c.Image, c.Entrypoint]), [["img", ["qwen"]]]);
  assert.deepEqual(ok.removed, ["verify-1 force=true"]);

  const silent = fakeDocker({ stdout: "no version here\n" });
  assert.equal(await builder(silent).cliVersion("img", "qwen", new AbortController().signal), null);

  const failing = fakeDocker({ exitCode: 127, stdout: "", stderr: "exec: qwen: not found\n" });
  await assert.rejects(builder(failing).cliVersion("img", "qwen", new AbortController().signal), {
    name: "VerifyError",
    message: "`qwen --version` failed (exit code 127): exec: qwen: not found",
  });
  assert.deepEqual(failing.removed, ["verify-1 force=true"]);

  const noImage = fakeDocker({ createError: dockerError(404, "No such image: img") });
  await assert.rejects(builder(noImage).cliVersion("img", "qwen", new AbortController().signal), {
    name: "VerifyError",
    message: "`qwen --version` could not run: No such image: img",
  });
  assert.deepEqual(noImage.removed, [], "no container to remove");

  const hanging = fakeDocker({ waitForever: true });
  const abort = new AbortController();
  const checking = builder(hanging).cliVersion("img", "qwen", abort.signal);
  setImmediate(() => abort.abort(new Error("cancelled")));
  await assert.rejects(checking, { message: "cancelled" });
  assert.deepEqual(hanging.removed, ["verify-1 force=true"]);
});

test("promote moves the workspace tag to the checked build and reports the build it replaced, which removeUntagged removes", async () => {
  const final = workspaceImage("qwen", "0.27.0");
  const staging = stagingImage("qwen", "0.27.0");
  const fake = fakeDocker({ images: { [final]: "sha256:old", [staging]: "sha256:new" } });
  assert.equal(await builder(fake).promote(staging, final), "sha256:old");
  assert.deepEqual(fake.calls, [`tag ${staging} workspace-portal/workspace:qwen-0.27.0`, `remove ${staging}`], "promote removes nothing else");
  assert.deepEqual([Object.fromEntries(fake.images), [...fake.untagged]], [{ [final]: "sha256:new" }, ["sha256:old"]]);
  await builder(fake).removeUntagged("sha256:old");
  assert.deepEqual(fake.calls.slice(2), ["remove sha256:old"]);
  assert.equal(fake.untagged.size, 0);

  // The same build (cache hit), and a first version: nothing replaced.
  const same = fakeDocker({ images: { [final]: "sha256:same", [staging]: "sha256:same" } });
  assert.equal(await builder(same).promote(staging, final), null);
  assert.deepEqual(same.calls, [`tag ${staging} workspace-portal/workspace:qwen-0.27.0`, `remove ${staging}`]);
  const first = fakeDocker({ images: { [staging]: "sha256:new" } });
  assert.equal(await builder(first).promote(staging, final), null);
  assert.deepEqual(Object.fromEntries(first.images), { [final]: "sha256:new" });
});

test("removeUntagged leaves an image a tag still names, never forces, and is fine with a missing one", async () => {
  const fake = fakeDocker({ images: { "workspace-portal/workspace:qwen-0.27.0-mine": "sha256:kept" }, untagged: ["sha256:busy-old"] });
  await builder(fake).removeUntagged("sha256:kept");
  await builder(fake).removeUntagged("sha256:busy-old");
  await builder(fake).removeUntagged("sha256:gone");
  assert.deepEqual(fake.calls, ["remove image sha256:busy-old"], "only the untagged one is removed (Docker keeps it while a container uses it)");
  assert.equal(fake.images.get("workspace-portal/workspace:qwen-0.27.0-mine"), "sha256:kept");
});

test("discard drops a staging tag; a missing one is fine", async () => {
  const staging = stagingImage("qwen", "9.9.9");
  const fake = fakeDocker({ images: { [staging]: "sha256:failed", [workspaceImage("qwen", "0.27.0")]: "sha256:current" } });
  await builder(fake).discard(staging);
  assert.deepEqual(Object.fromEntries(fake.images), { [workspaceImage("qwen", "0.27.0")]: "sha256:current" });
  await builder(fake).discard(staging);
  assert.deepEqual(fake.calls, [`remove ${staging}`, `remove ${staging}`], "the second time, Docker's 404 is fine");
});

test("exists asks Docker for the image", async () => {
  const fake = fakeDocker({ images: { "workspace-portal/workspace:qwen-0.27.0": "sha256:a" } });
  assert.equal(await builder(fake).exists("workspace-portal/workspace:qwen-0.27.0"), true);
  assert.equal(await builder(fake).exists("workspace-portal/workspace:qwen-0.26.0"), false);
});

test("sweep removes leftover version checks, staging tags and untagged agent builds, never forcing, and keeps what is in use", async () => {
  const fake = fakeDocker({
    verifyContainers: ["verify-a", "busy-verify-b"],
    // A gateway that stopped while promoting: the build has its workspace tag too, which stays.
    staging: ["workspace-portal/workspace-build:leftover-qwen-0.27.4", "workspace-portal/workspace:qwen-0.27.4", "workspace-portal/workspace-build:busy-dsh-0.2.2"],
    dangling: ["sha256:old-qwen", "sha256:busy-old-dsh", "sha256:gone-old"],
  });
  assert.deepEqual(await builder(fake).sweep(), {
    containers: ["verify-a"],
    images: ["workspace-portal/workspace-build:leftover-qwen-0.27.4", "sha256:old-qwen"],
  });
  assert.deepEqual(fake.calls, [
    'list containers {"all":true,"filters":{"label":["workspace-portal.verify"]}}',
    "remove container verify-a",
    "remove container busy-verify-b",
    'list {"reference":["workspace-portal/workspace-build:*"]}',
    "remove image workspace-portal/workspace-build:leftover-qwen-0.27.4",
    "remove image workspace-portal/workspace-build:busy-dsh-0.2.2",
    'list {"dangling":["true"],"label":["workspace-portal.agent"]}',
    "remove sha256:old-qwen",
    "remove image sha256:busy-old-dsh",
    "remove image sha256:gone-old",
  ]);
});

test("list reads workspace image tags; remove maps Docker's 404 and 409", async () => {
  const fake = fakeDocker({ images: { "workspace-portal/workspace:qwen-0.27.4": "sha256:a" } });
  const images = await builder(fake).list();
  assert.deepEqual(fake.calls, ['list {"reference":["workspace-portal/workspace:*"]}']);
  assert.deepEqual(images, [
    { image: "workspace-portal/workspace:qwen-0.27.4", kind: "qwen", version: "0.27.4", id: "sha256:a", sizeBytes: 2_014_620_610, createdAt: 1_794_729_782_000 },
    { image: "workspace-portal/workspace:qwen-0.27.4-copy", kind: "qwen", version: "0.27.4-copy", id: "sha256:a", sizeBytes: 2_014_620_610, createdAt: 1_794_729_782_000 },
    { image: "workspace-portal/workspace:dsh-0.2.2-rc.1", kind: "dsh", version: "0.2.2-rc.1", id: "sha256:b", sizeBytes: 1_900_000_000, createdAt: 1_794_000_000_000 },
  ]);
  await builder(fake).remove("workspace-portal/workspace:qwen-0.27.4");
  await assert.rejects(builder(fake).remove("workspace-portal/workspace:qwen-0.27.4"), ImageNotFoundError);
  await assert.rejects(builder(fake).remove("workspace-portal/workspace:qwen-0.26.0"), ImageInUseError);
});
