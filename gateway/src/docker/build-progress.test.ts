import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BuildProgress, JsonLineDecoder } from "./build-progress.ts";
import { traceMessage } from "../../test/protobuf-encode.ts";

const fixture = (name: string): Buffer => fs.readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url));

/** Replays a recorded build stream in chunks of `chunkSize` bytes, as the socket might deliver it. */
function replay(stream: Buffer, chunkSize: number): { progress: BuildProgress; lines: string[]; steps: string[] } {
  const decoder = new JsonLineDecoder();
  const progress = new BuildProgress();
  const lines: string[] = [];
  const steps: string[] = [];
  const take = (more: string[]): void => {
    lines.push(...more);
    if (progress.step !== null && progress.step !== steps.at(-1)) steps.push(progress.step);
  };
  for (let offset = 0; offset < stream.length; offset += chunkSize) {
    for (const message of decoder.push(stream.subarray(offset, offset + chunkSize))) take(progress.push(message));
  }
  for (const message of decoder.end()) take(progress.push(message));
  take(progress.finish());
  return { progress, lines, steps };
}

const NPM_STEP = '[qwen 1/2] RUN npm install -g --no-fund --no-audit "@qwen-code/qwen-code@0.27.4"';

test("a recorded BuildKit build of the qwen image reads as plain progress, with its steps", () => {
  const { progress, lines, steps } = replay(fixture("buildkit-qwen-0.27.4.jsonl"), 1 << 20);
  assert.equal(progress.error, null);
  assert.deepEqual(lines.slice(0, 4), ["#1 [internal] load remote build context", "#1 DONE 0.0s", "#2 copy /context /", "#2 DONE 0.0s"]);
  const npm = lines.findIndex((line) => line.includes(NPM_STEP));
  assert.ok(npm > 0, "the npm install step is shown");
  const n = /^#(\d+) /.exec(lines[npm]!)![1];
  assert.ok(lines.includes(`#${n} added 14 packages in 7s`), "its output, under its number");
  assert.ok(lines.includes(`#${n} DONE 7.5s`), "and its duration");
  assert.ok(lines.some((line) => /^#\d+ CACHED$/.test(line)), "cached base steps");
  assert.match(lines.at(-1)!, /^#\d+ DONE 7\.3s$/, "exporting to image is the last step");
  assert.deepEqual(
    lines.filter((line) => /^#\d+ \[|^#\d+ (copy|exporting)/.test(line)).map((line) => Number(/^#(\d+)/.exec(line)![1])),
    lines.filter((line) => /^#\d+ \[|^#\d+ (copy|exporting)/.test(line)).map((_, index) => index + 1),
    "steps are numbered in the order they are shown",
  );
  assert.ok(steps.some((step) => step.startsWith(NPM_STEP)));
  assert.equal(steps.at(-1), "exporting to image");
  assert.ok(lines.every((line) => line.length <= 500 && !line.includes("\u001b")));
});

test("the stream decodes the same however it is chunked", () => {
  const stream = fixture("buildkit-qwen-0.27.4.jsonl");
  const whole = replay(stream, 1 << 20);
  for (const size of [1, 7, 64, 1000]) {
    const chunked = replay(stream, size);
    assert.deepEqual(chunked.lines, whole.lines, `chunks of ${size}`);
    assert.deepEqual(chunked.steps, whole.steps);
  }
});

test("a recorded failed build reports the engine's error after the step's output", () => {
  const { progress, lines } = replay(fixture("buildkit-qwen-9.9.9-failed.jsonl"), 4096);
  assert.match(progress.error!, /^process "\/bin\/sh -c npm install .* did not complete successfully: exit code: 1$/);
  const notarget = lines.findIndex((line) => line.endsWith("npm error notarget No matching version found for @qwen-code/qwen-code@9.9.9."));
  assert.ok(notarget > 0, "npm's own explanation is in the log");
  assert.match(lines.at(-2)!, /^#\d+ ERROR: process .* exit code: 1$/, "the failed step");
  assert.equal(lines.at(-1), `ERROR: ${progress.error}`);
});

test("output is split into lines per step: partial lines wait, carriage returns and escapes are cleaned", () => {
  const progress = new BuildProgress();
  const push = (parts: Parameters<typeof traceMessage>[0]): string[] => progress.push(traceMessage(parts));
  assert.deepEqual(push({ vertexes: [{ digest: "a", name: "[qwen 1/2] RUN build", started: 1_000 }] }), ["#1 [qwen 1/2] RUN build"]);
  assert.equal(progress.step, "[qwen 1/2] RUN build");
  assert.deepEqual(push({ logs: [{ vertex: "a", msg: "first li" }] }), [], "no newline yet");
  assert.deepEqual(push({ logs: [{ vertex: "a", msg: "ne\nprogress 10%\rprogress 100%\n\n\u001b[1;31mred\u001b[0m\n" }] }), ["#1 first line", "#1 progress 100%", "#1 red"]);
  assert.deepEqual(push({ vertexes: [{ digest: "b", name: "[qwen 2/2] COPY start", started: 2_000 }] }), ["#2 [qwen 2/2] COPY start"]);
  assert.equal(progress.step, "[qwen 2/2] COPY start", "the latest running step");
  assert.deepEqual(push({ logs: [{ vertex: "a", msg: "tail without newline" }] }), []);
  assert.deepEqual(push({ vertexes: [{ digest: "a", name: "[qwen 1/2] RUN build", started: 1_000, completed: 3_500 }] }), ["#1 tail without newline", "#1 DONE 2.5s"]);
  assert.deepEqual(push({ vertexes: [{ digest: "a", name: "[qwen 1/2] RUN build", started: 1_000, completed: 3_500 }] }), [], "a repeated update adds nothing");
  assert.deepEqual(push({ warnings: [{ vertex: "b", short: "something odd" }] }), ["WARNING: something odd"]);
  assert.deepEqual(push({ logs: [{ vertex: "b", msg: `${"x".repeat(600)}\n` }] }), [`#2 ${"x".repeat(496)}…`], "long lines are cut");
  assert.deepEqual(push({ vertexes: [{ digest: "b", started: 2_000, error: "exit code: 2" }] }), ["#2 ERROR: exit code: 2"]);
  assert.deepEqual(push({ vertexes: [{ digest: "c", name: "[base 2/5] RUN apt-get", cached: true, completed: 5 }] }), ["#3 [base 2/5] RUN apt-get", "#3 CACHED"]);
});

test("engine errors and classic builder messages are understood; anything else is ignored", () => {
  const progress = new BuildProgress();
  assert.deepEqual(progress.push({ stream: "Step 1/2 : FROM x\n ---> abc\n" }), ["Step 1/2 : FROM x", " ---> abc"]);
  const results = [{ id: "moby.image.id", aux: { ID: "sha256:1" } }, { aux: { ID: "sha256:1" } }];
  for (const junk of [null, 42, "text", [], { id: "moby.buildkit.trace" }, { status: "Downloading" }, ...results]) assert.deepEqual(progress.push(junk), []);
  assert.deepEqual(progress.push({ error: "short", errorDetail: { message: "the engine's message" } }), ["ERROR: the engine's message"]);
  assert.equal(progress.error, "the engine's message");

  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push('{"a":1}\nnot json\n{"b"'), [{ a: 1 }]);
  assert.deepEqual(decoder.push(':2}\n{"c":3}'), [{ b: 2 }]);
  assert.deepEqual(decoder.end(), [{ c: 3 }]);
});

test("a progress message that can't be decoded is a warning, once per build, and the build goes on", () => {
  const progress = new BuildProgress();
  // Field 1 (a vertex) whose length runs past the end of the message.
  const damaged = { id: "moby.buildkit.trace", aux: Buffer.from([0x0a, 0x05, 0x01]).toString("base64") };
  assert.deepEqual(progress.push(damaged), ["WARNING: unreadable build progress (malformed protobuf: field 1 runs past the end)"]);
  assert.deepEqual(progress.push(damaged), [], "not once per message");
  assert.deepEqual(progress.push(traceMessage({ vertexes: [{ digest: "a", name: "[qwen 1/2] RUN build", started: 1_000 }] })), ["#1 [qwen 1/2] RUN build"]);
  assert.equal(progress.step, "[qwen 1/2] RUN build");
  assert.equal(progress.error, null, "progress is only for show");
});
