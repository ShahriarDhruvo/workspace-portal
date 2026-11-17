import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { closeServer, listenLocal } from "../../test/fakes.ts";
import { waitFor } from "../../test/harness.ts";
import { HostMonitor } from "./host-monitor.ts";
import { HostdClient, HostdError, SseParser, type HostSample } from "./hostd.ts";
import type { Logger } from "../lib/log.ts";

const TOKEN = "h".repeat(64);
const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function sample(t: number): HostSample {
  return {
    t,
    cpu: { usage: 10, mhz: 3000, mhzPeak: 5000, tempC: 50, powerW: 5, coreUsage: [10], coreMhz: [3000] },
    gpu: null,
    memory: { totalBytes: 100, availableBytes: 60, usedBytes: 40, gpuBytes: null, swapTotalBytes: 0, swapUsedBytes: 0, readBps: 1e9, writeBps: 5e8 },
    power: { watts: 20, parts: { gpu: null, cpu: 5, dram: 2 } },
    fans: [],
  };
}

/** A portal-hostd that streams a sample every 20 ms to authorized clients. */
async function fakeHostd(): Promise<{ port: number; streams: () => number; opened: () => number; close: () => Promise<void> }> {
  let open = 0;
  let opened = 0;
  let t = 1_000;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized","message":"Missing or wrong token."}');
      return;
    }
    if (req.url === "/v1/engine") {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"no_engine","message":"This server controls no engine."}');
      return;
    }
    if (req.url !== "/v1/stream") return void res.writeHead(404).end();
    open++;
    opened++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: info\ndata: ${JSON.stringify({ hostd: 1, hostname: "locust", role: "portal" })}\n\n`);
    const timer = setInterval(() => res.write(`: ping\n\nevent: sample\ndata: ${JSON.stringify(sample((t += 500)))}\n\n`), 20);
    res.on("close", () => {
      clearInterval(timer);
      open--;
    });
  });
  const port = await listenLocal(server);
  return { port, streams: () => open, opened: () => opened, close: () => closeServer(server) };
}

test("SseParser splits events across chunks and ignores comments", () => {
  const events: Array<[string, string]> = [];
  const parser = new SseParser((event, data) => events.push([event, data]));
  parser.push(": hello\nevent: info\nda");
  parser.push("ta: {\"a\":1}\r\n\r\ndata: x\ndata: y\n\n");
  assert.deepEqual(events, [
    ["info", '{"a":1}'],
    ["message", "x\ny"],
  ]);
  assert.equal(parser.push(`data: ${"z".repeat(300_000)}`), false, "an event that never ends is refused");
});

test("HostdClient: JSON requests carry the token; errors keep hostd's code", async () => {
  const hostd = await fakeHostd();
  try {
    const client = new HostdClient({ url: `http://127.0.0.1:${hostd.port}`, token: TOKEN });
    await assert.rejects(client.get("/v1/engine"), (error) => error instanceof HostdError && error.status === 404 && error.code === "no_engine");
    const wrong = new HostdClient({ url: `http://127.0.0.1:${hostd.port}`, token: "x".repeat(64) });
    await assert.rejects(wrong.get("/v1/info"), (error) => error instanceof HostdError && error.code === "unauthorized");
    const nobody = new HostdClient({ url: "http://127.0.0.1:1", token: TOKEN });
    await assert.rejects(nobody.get("/v1/info"), (error) => error instanceof HostdError && error.status === null && error.code === "unreachable");
  } finally {
    await hostd.close();
  }
});

test("HostMonitor streams only while watched, keeps recent readings, and reports a refused token", async () => {
  const hostd = await fakeHostd();
  const monitor = new HostMonitor({ role: "portal", config: { url: `http://127.0.0.1:${hostd.port}`, token: TOKEN }, log: quiet });
  try {
    assert.equal(monitor.live().state, "connecting");
    assert.equal(hostd.streams(), 0, "nothing before the first viewer");
    const leave = monitor.watch();
    const leaveToo = monitor.watch();
    await waitFor(() => monitor.live().state === "online" && monitor.history().length >= 3, "readings");
    const live = monitor.live();
    assert.equal(live.info?.hostname, "locust");
    assert.equal(live.sample, monitor.history().at(-1));
    assert.equal(hostd.opened(), 1, "one stream for all viewers");
    const times = monitor.history().map((s) => s.t);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    leave();
    leave();
    leaveToo();
    // It lingers (a reload doesn't reconnect); close() ends it at once.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(hostd.streams(), 1);
    monitor.close();
    await waitFor(() => hostd.streams() === 0, "the stream to close");
    assert.deepEqual([monitor.live().state, monitor.history()], ["connecting", []]);
  } finally {
    monitor.close();
    await hostd.close();
  }

  const second = await fakeHostd();
  const wrong = new HostMonitor({ role: "llm", config: { url: `http://127.0.0.1:${second.port}`, token: "x".repeat(64) }, log: quiet });
  try {
    const leave = wrong.watch();
    await waitFor(() => wrong.live().state === "offline", "the refusal");
    assert.equal(wrong.live().error, "Missing or wrong token.");
    leave();
  } finally {
    wrong.close();
    await second.close();
  }

  const off = new HostMonitor({ role: "llm", config: { url: "", token: "" }, log: quiet });
  off.watch()();
  assert.deepEqual([off.live().state, off.live().error], ["off", null]);
});

test("HostdClient keeps the path of its URL (a hostd behind a reverse proxy's prefix)", async () => {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  const port = await listenLocal(server);
  try {
    await new HostdClient({ url: `http://127.0.0.1:${port}/hostd/`, token: TOKEN }).get("/v1/health");
    await new HostdClient({ url: `http://127.0.0.1:${port}`, token: TOKEN }).get("/v1/health");
    assert.deepEqual(paths, ["/hostd/v1/health", "/v1/health"]);
  } finally {
    await closeServer(server);
  }
});
