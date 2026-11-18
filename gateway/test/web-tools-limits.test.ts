// What a workspace (or a page it read) can cost the gateway through the web tools: every test here
// was once a way to stall it, fill its memory or get more downloads going than a workspace is allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { withPageCache, type ReaderBackend } from "../src/service/reader.ts";
import { json, mcp, request, startGateway, withGateway } from "./harness.ts";

const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
const readCall = (url: string) => rpc("tools/call", { name: "read_page", arguments: { url } });
/** Sends an MCP request on a socket of its own and returns the socket, so the test decides whether the answer is ever read. */
const rawPost = (port: number, body: string, read = true): Promise<net.Socket> =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      if (!read) socket.pause();
      socket.write(`POST /mcp/search HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => resolve(socket));
    });
    socket.on("error", () => undefined);
  });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an LLM request full of brackets after a URL does not hold up the gateway", () =>
  withGateway({ env: { READER_URL: "http://127.0.0.1:9" }, reader: { read: async (url) => ({ url, kind: "html", title: "", text: "", truncated: false, note: "" }) } }, async (gw) => {
    gw.caller.userId = gw.ids.alice;
    let longest = 0;
    let last = performance.now();
    const beat = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 10);
    // 60,000 brackets stalled the event loop for over ten seconds; this is 2,000,000 of each kind.
    const content = `see http://a.example/x${"]".repeat(2_000_000)} and http://b.example/y${")".repeat(2_000_000)} and https://kept.example/page.`;
    const chat = await request(gw.ports.service, { method: "POST", path: "/llm/v1/chat/completions", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content }] }) });
    clearInterval(beat);
    assert.equal(chat.status, 200);
    assert.ok(longest < 1500, `the event loop stood still for ${Math.round(longest)} ms`);
    const read = json<{ result: { isError?: boolean } }>(await mcp(gw, readCall("https://kept.example/page")));
    assert.equal(read.result.isError, undefined, "the rest of the message was still read");
  }));

test("hanging up does not free a workspace's read slot while its download goes on", async () => {
  let inFlight = 0;
  let peak = 0;
  let started = 0;
  const slow: ReaderBackend = {
    read: (url) =>
      new Promise((resolve) => {
        started++;
        peak = Math.max(peak, ++inFlight);
        setTimeout(() => {
          inFlight--;
          resolve({ url, kind: "html", title: "", text: "x", truncated: false, note: "" });
        }, 400);
      }),
  };
  await withGateway({ env: { READER_URL: "http://127.0.0.1:9", READER_URL_POLICY: "any", READER_MAX_CONCURRENT_PER_USER: "2" }, reader: withPageCache(slow, { ttlMs: 900_000 }) }, async (gw) => {
    gw.caller.userId = gw.ids.alice;
    for (let index = 0; index < 12; index++) {
      const socket = await rawPost(gw.ports.service, JSON.stringify(readCall(`https://slow-site.net/${index}`)));
      await wait(20);
      socket.destroy();
      await wait(10);
    }
    assert.equal(peak, 2, "never more downloads at once than the workspace's limit");
    assert.equal(started, 2, "the other ten were turned away while the first two were still downloading");
    await wait(450);
    const after = json<{ result: { isError?: boolean } }>(await mcp(gw, readCall("https://slow-site.net/next")));
    assert.equal(after.result.isError, undefined, "the slots come back when the downloads end");
  });
});

test("a batch is at most 8 messages, and one address has at most 128 connections open", async () => {
  const text = "All work and no play makes Jack a dull boy.\n".repeat(9000);
  const gw = await startGateway({ env: { READER_URL: "http://127.0.0.1:9", READER_URL_POLICY: "any" }, reader: withPageCache({ read: async (url) => ({ url, kind: "html", title: "", text, truncated: false, note: "" }) }, { ttlMs: 900_000 }) });
  const sockets: net.Socket[] = [];
  try {
    gw.caller.userId = gw.ids.alice;
    const call = readCall("https://docs.example/long");
    const nine = await mcp(gw, Array.from({ length: 9 }, () => call));
    assert.equal(nine.status, 400);
    assert.match(json<{ error: { message: string } }>(nine).error.message, /at most 8 messages/);
    assert.equal(json<unknown[]>(await mcp(gw, Array.from({ length: 8 }, () => call))).length, 8);

    // A client that sends full batches on many connections and never takes the answers: the
    // answers wait in memory, so the connections of one workspace are counted.
    const batch = JSON.stringify(Array.from({ length: 8 }, () => call));
    for (let index = 0; index < 128; index++) sockets.push(await rawPost(gw.ports.service, batch, false));
    await wait(200);
    await assert.rejects(mcp(gw, rpc("ping")), "connection 129 is closed at once");
    for (const socket of sockets) socket.destroy();
    await wait(200);
    assert.equal((await mcp(gw, rpc("ping"))).status, 200, "closing them frees the workspace's connections");
  } finally {
    for (const socket of sockets) socket.destroy();
    await gw.close();
  }
});
