import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { closeServer, listenLocal } from "../../test/fakes.ts";
import {
  createLimiter,
  createSearxngBackend,
  formatResults,
  handleSearchMcp,
  parseSearchArguments,
  SearchError,
  type PageReader,
  type SearchBackend,
  type SearchMcpOptions,
  type SearchQuery,
} from "./search-mcp.ts";
import { ReadError, type Page } from "./reader.ts";

async function withServer(
  backend: SearchBackend,
  run: (url: string, calls: SearchQuery[]) => Promise<void>,
  max = 2,
  extra: Partial<SearchMcpOptions> = {},
): Promise<void> {
  const calls: SearchQuery[] = [];
  const limiter = createLimiter(max);
  const server = http.createServer((req, res) => {
    void handleSearchMcp(req, res, {
      backend: { search: (query, signal) => (calls.push(query), backend.search(query, signal)) },
      limiter,
      ...extra,
    });
  });
  const port = await listenLocal(server);
  try {
    await run(`http://127.0.0.1:${port}/mcp/search`, calls);
  } finally {
    await closeServer(server);
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
    const list = (await (await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: Array<{ name: string; description: string }> } };
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ["web_search"]);
    assert.match(list.result.tools[0]!.description, /^Search the web through the organization's private SearXNG instance\. Returns titles, URLs and short snippets\. This is the only internet access/);
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

test("the tool's description names where the backend sends a search", async () => {
  const server = http.createServer((req, res) => void handleSearchMcp(req, res, { backend: { ...ok, through: "Exa, or SearXNG" }, limiter: createLimiter(1) }));
  const port = await listenLocal(server);
  try {
    const list = (await (await post(`http://127.0.0.1:${port}/`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: Array<{ description: string }> } };
    assert.match(list.result.tools[0]!.description, /^Search the web through Exa, or SearXNG\. Returns titles/);
  } finally {
    await closeServer(server);
  }
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
    return new Response(JSON.stringify({ results: [{ title: "Fedora 45", url: "https://fedoraproject.org", content: "Released." }], suggestions: ["fedora 45 key west"], corrections: ["fedora 46"] }), {
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
  assert.match(out, /Did you mean: fedora 46/);
  assert.doesNotMatch(out, /key west/);

  const refused = createSearxngBackend({ baseUrl: "http://s", authorization: "", timeoutMs: 1000, fetchImpl: (async () => new Response("", { status: 403 })) as typeof fetch });
  await assert.rejects(refused.search({ query: "x", page: 1, timeRange: null, language: null }, new AbortController().signal), /JSON format/);
  const thrown = createSearxngBackend({ baseUrl: "http://s", authorization: "", timeoutMs: 1000, fetchImpl: () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(thrown.search({ query: "x", page: 1, timeRange: null, language: null }, new AbortController().signal), /did not answer/, "a fetch that throws instead of rejecting");
});

test("formatResults handles answers, infoboxes and no results", () => {
  const query = { query: "q", page: 1, timeRange: null, language: null };
  assert.equal(formatResults(query, {}), 'No results for "q".\nThe search engines answered and found nothing. Try fewer or different words.');
  assert.equal(formatResults({ ...query, page: 3 }, {}), 'No results for "q" on page 3.');
  const out = formatResults(query, { answers: ["42"], infoboxes: [{ infobox: "Thing", content: "About it" }], results: [{ url: "https://a", title: "A" }] });
  assert.match(out, /^Answer: 42\n\nInfobox — Thing: About it\n\nResults for "q"/);
});

test("an empty answer names the engines that failed, so the model does not blame its query", () => {
  const query = { query: "q", page: 1, timeRange: null, language: null };
  const out = formatResults(query, {
    results: [],
    unresponsive_engines: [["brave", "too many requests"], ["duckduckgo", "Suspended: CAPTCHA"], ["brave", "too many requests"], "junk", ["quiet", ""]],
  });
  assert.equal(
    out,
    'No results for "q".\nSearch engines that did not answer: brave (too many requests), duckduckgo (CAPTCHA), quiet.\n' +
      "That is a problem on the search engines' side, not with the query: rewording it will not help. Try once more in a minute, or go on without this search.",
  );
  // With results, a failed engine is not the model's concern.
  assert.doesNotMatch(formatResults(query, { results: [{ url: "https://a", title: "A" }], unresponsive_engines: [["brave", "timeout"]] }), /brave/);
});

function searxng(answers: Array<Record<string, unknown> | number>) {
  const requests: URL[] = [];
  const fetchImpl = (async (input: URL | RequestInfo) => {
    requests.push(new URL(String(input)));
    const answer = answers.shift() ?? { results: [] };
    return typeof answer === "number" ? new Response("", { status: answer }) : Response.json(answer);
  }) as typeof fetch;
  return { requests, fetchImpl };
}
const result = (n: number) => ({ title: `T${n}`, url: `https://r.example/${n}`, content: `snippet ${n}` });
const signal = new AbortController().signal;

test("a thin answer is topped up once from the fallback engines", async () => {
  const { requests, fetchImpl } = searxng([
    { results: [result(1)], unresponsive_engines: [["keenable", "timeout"]] },
    { results: [result(1), result(2), result(3)], unresponsive_engines: [["mojeek", "CAPTCHA"]] },
  ]);
  const uses: unknown[] = [];
  const backend = createSearxngBackend({ baseUrl: "http://s", authorization: "", timeoutMs: 1000, fetchImpl, fallbackEngines: ["duckduckgo", "swisscows"], fallbackBelow: 3, onFallback: (use) => uses.push(use) });
  const out = await backend.search({ query: "rare thing", page: 2, timeRange: "year", language: null }, signal);
  assert.equal(requests.length, 2);
  assert.deepEqual(uses, [{ before: 1, after: 3 }]);
  assert.equal(requests[0]!.searchParams.get("engines"), null, "the first try uses SearXNG's own default engines");
  assert.deepEqual(Object.fromEntries(requests[1]!.searchParams), { q: "rare thing", format: "json", pageno: "2", time_range: "year", engines: "duckduckgo,swisscows" });
  assert.deepEqual([...out.matchAll(/https:\/\/r\.example\/\d/g)].map((match) => match[0]), ["https://r.example/1", "https://r.example/2", "https://r.example/3"], "merged without repeats");

  const enough = searxng([{ results: [result(1), result(2), result(3)] }]);
  await createSearxngBackend({ baseUrl: "http://s", authorization: "", timeoutMs: 1000, fetchImpl: enough.fetchImpl, fallbackEngines: ["duckduckgo"], fallbackBelow: 3 }).search(
    { query: "common thing", page: 1, timeRange: null, language: null },
    signal,
  );
  assert.equal(enough.requests.length, 1, "no second request when there are enough results");

  const broken = searxng([{ results: [], unresponsive_engines: [["keenable", "timeout"]] }, 500]);
  const still = await createSearxngBackend({ baseUrl: "http://s", authorization: "", timeoutMs: 1000, fetchImpl: broken.fetchImpl, fallbackEngines: ["duckduckgo"] }).search(
    { query: "x", page: 1, timeRange: null, language: null },
    signal,
  );
  assert.match(still, /^No results for "x"\.\nSearch engines that did not answer: keenable \(timeout\)\./, "a failing fallback leaves the first answer");

  const none = searxng([{ results: [] }]);
  await createSearxngBackend({ baseUrl: "http://s", authorization: "", timeoutMs: 1000, fetchImpl: none.fetchImpl }).search({ query: "x", page: 1, timeRange: null, language: null }, signal);
  assert.equal(none.requests.length, 1, "no fallback engines configured");
});

test("the same search is answered from the cache for a while; empty answers are not kept", async () => {
  let clock = 0;
  const { requests, fetchImpl } = searxng([{ results: [result(1)] }, { results: [result(2)] }, { results: [] }, { results: [result(3)] }, { results: [result(4)] }]);
  const backend = createSearxngBackend({ baseUrl: "http://s", authorization: "", timeoutMs: 1000, fetchImpl, cacheMs: 1000, now: () => clock });
  const query = { query: "Podman Quadlet", page: 1, timeRange: null, language: null };
  const first = await backend.search(query, signal);
  assert.equal(await backend.search({ ...query, query: "podman quadlet" }, signal), first, "same words, different case");
  assert.equal(requests.length, 1);
  assert.match(await backend.search({ ...query, page: 2 }, signal), /r\.example\/2/, "another page is another search");
  assert.match(await backend.search({ ...query, query: "nothing" }, signal), /^No results/);
  assert.match(await backend.search({ ...query, query: "nothing" }, signal), /r\.example\/3/, "an empty answer was not cached");
  clock = 1001;
  assert.match(await backend.search(query, signal), /r\.example\/4/, "expired");
  assert.equal(requests.length, 5);
});

test("with a page reader, tools/list adds read_page and tools/call reads what the workspace may open", async () => {
  const reads: string[] = [];
  const fences: Array<readonly string[] | null | undefined> = [];
  const shown: string[] = [];
  const text = `Intro https://docs.example/next\n${"line of text\n".repeat(200)}`;
  const reader: PageReader = {
    backend: {
      async read(url, _signal, readOptions) {
        reads.push(url);
        fences.push(readOptions?.redirectHosts);
        if (url.endsWith("/missing")) throw new ReadError("There is no page at that URL (HTTP 404).", true);
        return { url: "https://docs.example/final", kind: "html", title: "Docs", text, truncated: false, note: "" } satisfies Page;
      },
    },
    limiter: createLimiter(2),
    pageChars: 1000,
    // The gateway's rule in miniature: the reader is asked for the URL that access() settled on.
    access: (url) => (url.includes("attacker") ? { refusal: "read_page only opens pages you were shown." } : { url: url.replace("/SECRET/..", ""), redirectHosts: url.includes("/start") ? ["docs.example"] : null }),
  };
  // Like the real formatter, the answer repeats the query, and an engine's spelling correction may too.
  const withSearch: SearchBackend = {
    search: async (query) => `Results for "${query.query}" (page 1):\n\n1. Result\n   https://found.example/page\n   snippet\n\nDid you mean: ${query.query.replace("secret", "secrets")}`,
  };
  await withServer(
    withSearch,
    async (url) => {
      const call = async (name: string, args: unknown) =>
        ((await (await post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;

      const list = (await (await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: Array<{ name: string; description: string }> } };
      assert.deepEqual(list.result.tools.map((tool) => tool.name), ["web_search", "read_page"]);
      assert.match(list.result.tools[0]!.description, /open the result with read_page/);
      assert.doesNotMatch(list.result.tools[0]!.description, /cannot be opened/);
      const init = (await (await post(url, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} })).json()) as { result: { instructions: string } };
      assert.match(init.result.instructions, /read_page/);

      await call("web_search", { query: "x" });
      assert.deepEqual(shown, ["https://found.example/page"], "search results count as shown");

      const first = await call("read_page", { url: "https://docs.example/start" });
      assert.equal(first.isError, undefined);
      assert.match(first.content[0]!.text, /^Title: Docs\nURL: https:\/\/docs\.example\/final\n\nIntro https:\/\/docs\.example\/next\n/);
      const next = /start=(\d+)\.\]$/.exec(first.content[0]!.text);
      assert.ok(next);
      assert.ok(shown.includes("https://docs.example/final") && shown.includes("https://docs.example/next"), "the page and its links count as shown");
      const second = await call("read_page", { url: "https://docs.example/start", start: Number(next[1]) });
      assert.match(second.content[0]!.text, /\n\nline of text\n/);

      const refused = await call("read_page", { url: "https://attacker.example/?d=secret" });
      assert.deepEqual([refused.isError, refused.content[0]!.text], [true, "read_page only opens pages you were shown."]);
      assert.equal(reads.includes("https://attacker.example/?d=secret"), false, "a refused URL never reaches the reader");
      const missing = await call("read_page", { url: "https://docs.example/missing" });
      assert.deepEqual([missing.isError, missing.content[0]!.text], [true, "There is no page at that URL (HTTP 404)."]);
      assert.equal((await call("read_page", { url: "ftp://docs.example/" })).isError, true);
      assert.deepEqual(fences, [["docs.example"], ["docs.example"], null], "the reader is told where a redirect may lead");

      await call("read_page", { url: "https://docs.example/SECRET/../page" });
      assert.equal(reads.at(-1), "https://docs.example/page", "the reader gets the URL that was checked, not the one the model wrote");

      // A URL in the query is the model's own: the answer repeating it does not make it one it was shown.
      shown.length = 0;
      await call("web_search", { query: "https://found.example/page?d=secret https://attacker.example/c?d=secret" });
      assert.deepEqual(shown, ["https://found.example/page"], "only the result");
    },
    2,
    { reader, onShown: (urls) => shown.push(...urls) },
  );
});
