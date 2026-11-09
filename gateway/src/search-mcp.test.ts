import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createLimiter,
  createSearxngBackend,
  formatResults,
  handleSearchMcp,
  parseSearchArguments,
  SearchError,
  type SearchBackend,
  type SearchQuery,
} from "./search-mcp.ts";

async function withServer(backend: SearchBackend, run: (url: string, calls: SearchQuery[]) => Promise<void>, max = 2): Promise<void> {
  const calls: SearchQuery[] = [];
  const limiter = createLimiter(max);
  const server = http.createServer((req, res) => {
    void handleSearchMcp(req, res, {
      backend: { search: (query, signal) => (calls.push(query), backend.search(query, signal)) },
      limiter,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/search`, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });

const ok: SearchBackend = { search: async (query) => `results for ${query.query}` };

test("initialize negotiates the protocol version, statelessly", async () => {
  await withServer(ok, async (url) => {
    const res = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("mcp-session-id"), null, "no session");
    const body = (await res.json()) as { result: { protocolVersion: string; capabilities: unknown } };
    assert.equal(body.result.protocolVersion, "2025-03-26");
    assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
    const unknown = (await (await post(url, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json()) as { result: { protocolVersion: string } };
    assert.equal(unknown.result.protocolVersion, "2025-11-25");
  });
});

test("notifications get 202; GET and DELETE get 405; unknown methods an RPC error", async () => {
  await withServer(ok, async (url) => {
    assert.equal((await post(url, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const get = await fetch(url);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");
    assert.equal((await fetch(url, { method: "DELETE" })).status, 405);
    const unknown = (await (await post(url, { jsonrpc: "2.0", id: 3, method: "resources/list" })).json()) as { error: { code: number } };
    assert.equal(unknown.error.code, -32601);
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" })).status, 400);
  });
});

test("tools/list offers only web_search; tools/call runs it", async () => {
  await withServer(ok, async (url, calls) => {
    const list = (await (await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ["web_search"]);
    const call = (await (
      await post(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_search", arguments: { query: " fedora 45 ", page: 2, time_range: "week" } } })
    ).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    assert.equal(call.result.content[0]!.text, "results for fedora 45");
    assert.equal(call.result.isError, undefined);
    assert.deepEqual(calls, [{ query: "fedora 45", page: 2, timeRange: "week", language: null }]);
    const other = (await (await post(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_fetch", arguments: { url: "http://x" } } })).json()) as {
      result: { isError: boolean };
    };
    assert.equal(other.result.isError, true, "no other tools exist");
  });
});

test("bad arguments and backend failures come back as tool errors", async () => {
  const failing: SearchBackend = {
    search: async () => {
      throw new SearchError("The search engine did not answer.");
    },
  };
  await withServer(failing, async (url, calls) => {
    const bad = (await (await post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search", arguments: { query: "" } } })).json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.equal(bad.result.isError, true);
    assert.equal(calls.length, 0, "invalid input never reaches the backend");
    const failed = (await (await post(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_search", arguments: { query: "x" } } })).json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.deepEqual([failed.result.isError, failed.result.content[0]!.text], [true, "The search engine did not answer."]);
  });
});

test("the per-workspace limiter refuses extra concurrent searches", async () => {
  let release: () => void = () => undefined;
  const slow: SearchBackend = { search: () => new Promise((resolve) => (release = () => resolve("done"))) };
  await withServer(
    slow,
    async (url) => {
      const first = post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search", arguments: { query: "a" } } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = (await (await post(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_search", arguments: { query: "b" } } })).json()) as {
        result: { isError: boolean };
      };
      assert.equal(second.result.isError, true);
      release();
      assert.equal(((await (await first).json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text, "done");
    },
    1,
  );
});

test("parseSearchArguments validates every field", () => {
  assert.deepEqual(parseSearchArguments({ query: "x", language: "pt-BR" }), { query: "x", page: 1, timeRange: null, language: "pt-BR" });
  assert.equal(typeof parseSearchArguments({ query: "x", page: 0 }), "string");
  assert.equal(typeof parseSearchArguments({ query: "x", time_range: "decade" }), "string");
  assert.equal(typeof parseSearchArguments({ query: "x", language: "en; rm -rf" }), "string");
  assert.equal(typeof parseSearchArguments({ query: "x".repeat(401) }), "string");
  assert.equal(typeof parseSearchArguments(null), "string");
});

test("the SearXNG backend sends only the query to the configured instance", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ results: [{ title: "Fedora 45", url: "https://fedoraproject.org", content: "Released." }], suggestions: ["fedora 46"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const backend = createSearxngBackend({ baseUrl: "http://127.0.0.1:8888/searx", authorization: "Basic abc", timeoutMs: 1000, fetchImpl });
  const out = await backend.search({ query: "fedora", page: 2, timeRange: "month", language: "en" }, new AbortController().signal);
  const sent = new URL(requests[0]!.url);
  assert.equal(`${sent.origin}${sent.pathname}`, "http://127.0.0.1:8888/searx/search");
  assert.deepEqual(Object.fromEntries(sent.searchParams), { q: "fedora", format: "json", pageno: "2", time_range: "month", language: "en" });
  assert.equal(requests[0]!.headers.get("authorization"), "Basic abc");
  assert.match(out, /1\. Fedora 45\n {3}https:\/\/fedoraproject\.org\n {3}Released\./);
  assert.match(out, /Related searches: fedora 46/);

  const refused = createSearxngBackend({ baseUrl: "http://s", authorization: "", timeoutMs: 1000, fetchImpl: (async () => new Response("", { status: 403 })) as typeof fetch });
  await assert.rejects(refused.search({ query: "x", page: 1, timeRange: null, language: null }, new AbortController().signal), /JSON format/);
});

test("formatResults handles answers, infoboxes and no results", () => {
  const query = { query: "q", page: 1, timeRange: null, language: null };
  assert.equal(formatResults(query, {}), 'No results for "q".');
  const out = formatResults(query, { answers: ["42"], infoboxes: [{ infobox: "Thing", content: "About it" }], results: [{ url: "https://a", title: "A" }] });
  assert.match(out, /^Answer: 42\n\nInfobox — Thing: About it\n\nResults for "q"/);
});
