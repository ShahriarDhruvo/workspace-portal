import { test } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import { averageCores, cpuSeconds, demuxDockerLogs, memoryUsage } from "./docker-runtime.ts";

function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function stats(partial: object): Docker.ContainerStats {
  return partial as Docker.ContainerStats;
}

test("demuxDockerLogs joins stdout and stderr frames", () => {
  const logs = Buffer.concat([frame(1, "starting qwen serve\n"), frame(2, "warn: x\n"), frame(1, "listening\n")]);
  assert.equal(demuxDockerLogs(logs), "starting qwen serve\nwarn: x\nlistening\n");
  assert.equal(demuxDockerLogs(Buffer.alloc(0)), "");
});

test("demuxDockerLogs passes TTY output through", () => {
  assert.equal(demuxDockerLogs(Buffer.from("plain tty output\n")), "plain tty output\n");
  const truncated = frame(1, "hello").subarray(0, 10);
  assert.equal(demuxDockerLogs(truncated), truncated.toString("utf8"));
});

test("memoryUsage subtracts reclaimable cache (cgroup v2 and v1)", () => {
  assert.equal(memoryUsage(stats({ memory_stats: { usage: 1000, stats: { inactive_file: 300 } } })), 700);
  assert.equal(memoryUsage(stats({ memory_stats: { usage: 1000, stats: { total_inactive_file: 100 } } })), 900);
  assert.equal(memoryUsage(stats({ memory_stats: { usage: 1000 } })), 1000);
  assert.equal(memoryUsage(stats({ memory_stats: {} })), null);
});

test("cpuSeconds reads the cumulative CPU time", () => {
  assert.equal(cpuSeconds(stats({ cpu_stats: { cpu_usage: { total_usage: 2.5e9 } } })), 2.5);
  assert.equal(cpuSeconds(stats({ cpu_stats: {} })), null);
});

test("averageCores turns two cumulative samples into cores over the interval", () => {
  assert.equal(averageCores({ cpuSeconds: 10, at: 0 }, { cpuSeconds: 17.5, at: 15_000 }), 0.5);
  assert.equal(averageCores(null, { cpuSeconds: 10, at: 0 }), null, "first sample");
  assert.equal(averageCores({ cpuSeconds: 10, at: 5 }, { cpuSeconds: 11, at: 5 }), null, "no elapsed time");
  assert.equal(averageCores({ cpuSeconds: 10, at: 0 }, { cpuSeconds: 1, at: 15_000 }), null, "container restarted");
});
