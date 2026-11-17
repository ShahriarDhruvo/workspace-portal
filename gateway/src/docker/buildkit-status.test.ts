import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodeStatusResponse } from "./buildkit-status.ts";
import { statusResponse } from "../../test/protobuf-encode.ts";

const FIXTURE = new URL("../../test/fixtures/buildkit-qwen-0.27.4.jsonl", import.meta.url);

test("decodeStatusResponse reads vertexes, logs and warnings, and skips layer progress", () => {
  const update = decodeStatusResponse(
    statusResponse({
      vertexes: [
        { digest: "sha256:a", name: "[qwen 1/2] RUN npm install", started: 1_700_000_000_123, completed: 1_700_000_007_623 },
        { digest: "sha256:b", name: "[base 2/5] RUN apt-get update", cached: true, started: 1_700_000_000_000, completed: 1_700_000_000_000 },
        { digest: "sha256:c", name: "[qwen 2/2] COPY", started: 1_700_000_008_000, error: "exit code: 1" },
        { digest: "sha256:d" },
      ],
      logs: [{ vertex: "sha256:a", msg: "added 14 packages in 7s\n", stream: 2 }],
      warnings: [{ vertex: "sha256:a", short: "FromAsCasing: 'as' and 'FROM' keywords' casing do not match" }],
    }),
  );
  assert.deepEqual(update.vertexes, [
    { digest: "sha256:a", name: "[qwen 1/2] RUN npm install", cached: false, startedAt: 1_700_000_000_123, completedAt: 1_700_000_007_623, error: "" },
    { digest: "sha256:b", name: "[base 2/5] RUN apt-get update", cached: true, startedAt: 1_700_000_000_000, completedAt: 1_700_000_000_000, error: "" },
    { digest: "sha256:c", name: "[qwen 2/2] COPY", cached: false, startedAt: 1_700_000_008_000, completedAt: null, error: "exit code: 1" },
    { digest: "sha256:d", name: "", cached: false, startedAt: null, completedAt: null, error: "" },
  ]);
  assert.equal(update.logs.length, 1);
  assert.deepEqual({ ...update.logs[0]!, data: Buffer.from(update.logs[0]!.data).toString() }, { vertex: "sha256:a", data: "added 14 packages in 7s\n" });
  assert.deepEqual(update.warnings, ["FromAsCasing: 'as' and 'FROM' keywords' casing do not match"]);
});

test("decodeStatusResponse reads a StatusResponse recorded from Docker 29", () => {
  const messages = fs
    .readFileSync(FIXTURE, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: string; aux: unknown });
  const traces = messages.filter((m) => m.id === "moby.buildkit.trace").map((m) => decodeStatusResponse(Buffer.from(m.aux as string, "base64")));
  // The first message names the first step twice: as queued, then as started.
  const [queued, started] = traces[0]!.vertexes;
  assert.equal(queued!.name, "[internal] load remote build context");
  assert.match(queued!.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(queued!.startedAt, null);
  assert.equal(started!.digest, queued!.digest);
  assert.ok(started!.startedAt !== null && started!.startedAt > Date.UTC(2026, 0, 1), "a plausible start time");
  const names = new Set(traces.flatMap((t) => t.vertexes.map((v) => v.name)));
  assert.ok([...names].some((name) => name.startsWith('[qwen 1/2] RUN npm install -g --no-fund --no-audit "@qwen-code/qwen-code@0.27.4"')));
  const output = traces.flatMap((t) => t.logs.map((log) => Buffer.from(log.data).toString())).join("");
  assert.match(output, /added 14 packages in 7s/);
});
