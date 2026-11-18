import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createNpmRegistry, githubRepository, packagePath, readPackument } from "./npm-registry.ts";

type Answer = { status: number; body?: string; headers?: Record<string, string> } | Error | "hang";

/** A fetch stand-in that records the requests and answers from a table. */
function stubFetch(answers: Record<string, Answer>): { fetch: typeof fetch; requests: Array<{ url: string; headers: Headers }> } {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    const answer = answers[url] ?? { status: 404, body: "{}" };
    if (answer === "hang") {
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    if (answer instanceof Error) throw answer;
    return new Response(answer.status === 304 ? null : (answer.body ?? ""), { status: answer.status, headers: answer.headers });
  }) as typeof fetch;
  return { fetch: fetchStub, requests };
}

const DSH = "https://registry.npmjs.org/@deepseek-ai%2Fdsh";

/** DeepSeek Harness's document as the registry has it, cut down (the real one is 330 kB). */
const DSH_DOC = JSON.stringify({
  name: "@deepseek-ai/dsh",
  "dist-tags": { alpha: "0.2.2-alpha.3", latest: "0.2.2-rc.1", next: "0.2.2-rc.3", odd: 7 },
  versions: {
    "0.2.2-rc.1": { version: "0.2.2-rc.1" },
    "0.2.2-rc.3": { version: "0.2.2-rc.3" },
    "0.2.0": { version: "0.2.0", deprecated: "broken lockfile" },
    "not a version": {},
  },
  time: { created: "2026-08-01T00:00:00.000Z", "0.2.2-rc.1": "2026-11-04T09:20:32.310Z", "0.2.0": "garbage", "0.1.0": "2026-08-01T00:00:00.000Z" },
  repository: { type: "git", url: "git+https://github.com/deepseek-ai/deepseek-harness.git", directory: "apps/cli" },
  readme: "…",
});

test("packagePath escapes the slash of a scoped package, as the registry expects", () => {
  assert.equal(packagePath("@deepseek-ai/dsh"), "@deepseek-ai%2Fdsh");
  assert.equal(packagePath("@qwen-code/qwen-code"), "@qwen-code%2Fqwen-code");
  assert.equal(packagePath("left-pad"), "left-pad");
});

test("packument: dist-tags, the published versions with their times, deprecation and the GitHub repository", async () => {
  const { fetch, requests } = stubFetch({ [DSH]: { status: 200, body: DSH_DOC, headers: { etag: 'W/"abc"' } } });
  const answer = await createNpmRegistry({ fetch }).packument("@deepseek-ai/dsh");
  assert.deepEqual(answer, {
    etag: 'W/"abc"',
    package: {
      distTags: { alpha: "0.2.2-alpha.3", latest: "0.2.2-rc.1", next: "0.2.2-rc.3" },
      versions: [
        { version: "0.2.2-rc.1", publishedAt: Date.parse("2026-11-04T09:20:32.310Z"), deprecated: false },
        { version: "0.2.2-rc.3", publishedAt: null, deprecated: false },
        { version: "0.2.0", publishedAt: null, deprecated: true },
      ],
      githubRepo: "deepseek-ai/deepseek-harness",
    },
  });
  assert.equal(requests[0]!.headers.get("if-none-match"), null);
  assert.equal(requests[0]!.headers.get("accept"), "application/json", "the full document: the abbreviated one has no times");
});

test("packument with the last ETag: a 304 means unchanged (null), without a body", async () => {
  const { fetch, requests } = stubFetch({ [DSH]: { status: 304 } });
  assert.equal(await createNpmRegistry({ fetch }).packument("@deepseek-ai/dsh", 'W/"abc"'), null);
  assert.equal(requests[0]!.headers.get("if-none-match"), 'W/"abc"');
});

test("githubRepository reads every form of the repository field npm accepts", () => {
  const cases: Array<[unknown, string | null]> = [
    [{ type: "git", url: "git+https://github.com/QwenLM/qwen-code.git" }, "QwenLM/qwen-code"],
    ["https://github.com/deepseek-ai/deepseek-harness", "deepseek-ai/deepseek-harness"],
    ["git://github.com/owner/name.git", "owner/name"],
    ["git+ssh://git@github.com/owner/name.git", "owner/name"],
    ["git@github.com:owner/name.git", "owner/name"],
    ["https://github.com/owner/name/tree/main/apps/cli", null],
    ["https://github.com/owner/name#readme", "owner/name"],
    ["github:owner/name", "owner/name"],
    ["owner/name", "owner/name"],
    ["gitlab:owner/name", null],
    ["https://gitlab.com/owner/name.git", null],
    [{ url: 7 }, null],
    [undefined, null],
  ];
  for (const [field, repo] of cases) assert.equal(githubRepository(field), repo, JSON.stringify(field));
});

test("readPackument refuses what isn't a package document, and ignores inherited keys", () => {
  assert.equal(readPackument(["latest"]), null);
  assert.equal(readPackument(null), null);
  const odd = readPackument(JSON.parse('{"dist-tags":{"__proto__":{"latest":"6.6.6"}},"versions":{"__proto__":{}}}'));
  assert.deepEqual(odd, { distTags: {}, versions: [], githubRepo: null });
});

test("hasVersion: 200 is published, 404 is not, anything else is a registry error", async () => {
  const { fetch, requests } = stubFetch({
    [`${DSH}/0.2.2-rc.3`]: { status: 200, body: '{"version":"0.2.2-rc.3"}' },
    [`${DSH}/9.9.9`]: { status: 404, body: '"version not found: 9.9.9"' },
    [`${DSH}/1.0.0`]: { status: 503 },
  });
  const registry = createNpmRegistry({ fetch });
  assert.equal(await registry.hasVersion("@deepseek-ai/dsh", "0.2.2-rc.3"), true);
  assert.equal(await registry.hasVersion("@deepseek-ai/dsh", "9.9.9"), false);
  await assert.rejects(registry.hasVersion("@deepseek-ai/dsh", "1.0.0"), { status: 502, code: "registry_unreachable" });
  assert.equal(requests.length, 3);
});

test("an unreachable, slow or odd registry is registry_unreachable", async () => {
  const cases: Array<[string, Answer, RegExp]> = [
    ["down", new TypeError("fetch failed"), /unreachable \(fetch failed\)/],
    ["hangs", "hang", /unreachable \(no answer within 0\.05 s\)/],
    ["500", { status: 500 }, /answered 500/],
    ["304 unasked", { status: 304 }, /answered 304/],
    ["not JSON", { status: 200, body: "<html>" }, /not JSON/],
    ["not an object", { status: 200, body: '["latest"]' }, /not a package/],
    ["huge", { status: 200, body: `{"x":"${"a".repeat(2048)}"}` }, /too large/],
  ];
  for (const [what, answer, message] of cases) {
    const registry = createNpmRegistry({ fetch: stubFetch({ [DSH]: answer }).fetch, timeoutMs: 50, maxPackumentBytes: 1024 });
    await assert.rejects(registry.packument("@deepseek-ai/dsh"), { code: "registry_unreachable", message }, what);
  }
});

test("a registry that sends its headers and then stalls is registry_unreachable too (not an internal error)", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"dist-tags":');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const registry = createNpmRegistry({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 200 });
    await assert.rejects(registry.packument("@deepseek-ai/dsh"), { code: "registry_unreachable", message: /unreachable \(no answer within 0\.2 s\)/ });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("another registry can be used (a mirror, or a test server)", async () => {
  const { fetch, requests } = stubFetch({ "http://mirror.test/npm/left-pad": { status: 200, body: '{"dist-tags":{"latest":"1.3.0"},"versions":{"1.3.0":{}}}' } });
  const registry = createNpmRegistry({ fetch, baseUrl: "http://mirror.test/npm/" });
  assert.deepEqual((await registry.packument("left-pad"))?.package.distTags, { latest: "1.3.0" });
  assert.deepEqual(requests.map((request) => request.url), ["http://mirror.test/npm/left-pad"]);
});
