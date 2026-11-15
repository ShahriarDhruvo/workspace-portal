import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createNpmRegistry, packagePath, RegistryError } from "./npm-registry.ts";

type Answer = { status: number; body?: string } | Error | "hang";

/** A fetch stand-in that records the URLs asked for and answers from a table. */
function stubFetch(answers: Record<string, Answer>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const answer = answers[url] ?? { status: 404, body: "{}" };
    if (answer === "hang") {
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    if (answer instanceof Error) throw answer;
    return new Response(answer.body ?? "", { status: answer.status });
  }) as typeof fetch;
  return { fetch: fetchStub, urls };
}

const DSH_TAGS = "https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags";

test("packagePath escapes the slash of a scoped package, as the registry expects", () => {
  assert.equal(packagePath("@deepseek-ai/dsh"), "@deepseek-ai%2Fdsh");
  assert.equal(packagePath("@qwen-code/qwen-code"), "@qwen-code%2Fqwen-code");
  assert.equal(packagePath("left-pad"), "left-pad");
});

test("distTags reads a package's dist-tags", async () => {
  const { fetch, urls } = stubFetch({ [DSH_TAGS]: { status: 200, body: '{"alpha":"0.2.2-alpha.3","latest":"0.2.2-rc.1","next":"0.2.2-rc.3","odd":7}' } });
  const registry = createNpmRegistry({ fetch });
  assert.deepEqual(await registry.distTags("@deepseek-ai/dsh"), { alpha: "0.2.2-alpha.3", latest: "0.2.2-rc.1", next: "0.2.2-rc.3" });
  assert.deepEqual(urls, [DSH_TAGS]);
});

test("hasVersion: 200 is published, 404 is not, anything else is a registry error", async () => {
  const { fetch, urls } = stubFetch({
    "https://registry.npmjs.org/@deepseek-ai%2Fdsh/0.2.2-rc.3": { status: 200, body: '{"version":"0.2.2-rc.3"}' },
    "https://registry.npmjs.org/@deepseek-ai%2Fdsh/9.9.9": { status: 404, body: '"version not found: 9.9.9"' },
    "https://registry.npmjs.org/@deepseek-ai%2Fdsh/1.0.0": { status: 503 },
  });
  const registry = createNpmRegistry({ fetch });
  assert.equal(await registry.hasVersion("@deepseek-ai/dsh", "0.2.2-rc.3"), true);
  assert.equal(await registry.hasVersion("@deepseek-ai/dsh", "9.9.9"), false);
  await assert.rejects(registry.hasVersion("@deepseek-ai/dsh", "1.0.0"), RegistryError);
  assert.equal(urls.length, 3);
});

test("an unreachable, slow or odd registry is a RegistryError", async () => {
  const cases: Array<[string, Answer, RegExp]> = [
    ["down", new TypeError("fetch failed"), /unreachable \(fetch failed\)/],
    ["hangs", "hang", /unreachable \(no answer within 0\.05 s\)/],
    ["500", { status: 500 }, /answered 500/],
    ["not JSON", { status: 200, body: "<html>" }, /not JSON/],
    ["not an object", { status: 200, body: '["latest"]' }, /not a list/],
    ["huge", { status: 200, body: `{"x":"${"a".repeat(300 * 1024)}"}` }, /too large/],
  ];
  for (const [what, answer, message] of cases) {
    const registry = createNpmRegistry({ fetch: stubFetch({ [DSH_TAGS]: answer }).fetch, timeoutMs: 50 });
    await assert.rejects(registry.distTags("@deepseek-ai/dsh"), (error: unknown) => error instanceof RegistryError && message.test(error.message), what);
  }
});

test("a registry that sends its headers and then stalls is a RegistryError too (not an internal error)", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"latest":');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const registry = createNpmRegistry({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 200 });
    await assert.rejects(registry.distTags("@deepseek-ai/dsh"), (error: unknown) => error instanceof RegistryError && /unreachable \(no answer within 0\.2 s\)/.test(error.message));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("another registry can be used (a mirror, or a test server)", async () => {
  const { fetch, urls } = stubFetch({ "http://mirror.test/npm/-/package/left-pad/dist-tags": { status: 200, body: '{"latest":"1.3.0"}' } });
  const registry = createNpmRegistry({ fetch, baseUrl: "http://mirror.test/npm/" });
  assert.deepEqual(await registry.distTags("left-pad"), { latest: "1.3.0" });
  assert.deepEqual(urls, ["http://mirror.test/npm/-/package/left-pad/dist-tags"]);
});
