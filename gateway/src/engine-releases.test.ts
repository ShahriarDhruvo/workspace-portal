import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEngineRegistry, FakeNotes } from "../test/fakes.ts";
import { compareVersions, createNotesClient, createRegistryClient, EngineReleases, isStableVersion, splitRepository } from "./engine-releases.ts";

test("splitRepository finds the registry host, Docker Hub by default", () => {
  assert.deepEqual(splitRepository("ghcr.io/gufo-org/toolboxes/gufo-runtime"), { registry: "ghcr.io", path: "gufo-org/toolboxes/gufo-runtime" });
  assert.deepEqual(splitRepository("localhost:5000/engine"), { registry: "localhost:5000", path: "engine" });
  assert.deepEqual(splitRepository("docker.io/vllm/vllm-openai"), { registry: "registry-1.docker.io", path: "vllm/vllm-openai" });
  assert.deepEqual(splitRepository("vllm/vllm-openai"), { registry: "registry-1.docker.io", path: "vllm/vllm-openai" });
  assert.deepEqual(splitRepository("ollama"), { registry: "registry-1.docker.io", path: "library/ollama" });
});

test("versions: X.Y.Z only, compared numerically", () => {
  assert.deepEqual(["0.9.0", "0.10.0", "0.31.0", "1.0.0", "0.31.1"].sort(compareVersions), ["0.9.0", "0.10.0", "0.31.0", "0.31.1", "1.0.0"]);
  for (const version of ["0.34.0", "10.0.1"]) assert.equal(isStableVersion(version), true, version);
  for (const tag of ["latest", "edge", "sha-abc", "v0.34.0", "0.34", "0.34.0-rc.1", "0.34.0 "]) assert.equal(isStableVersion(tag), false, tag);
});

/** A fetch that answers from a table of URL → handler, recording the calls. */
function fakeFetch(routes: Record<string, (init: RequestInit) => Response>): { fetch: typeof fetch; calls: Array<{ url: string; auth: string | null; method: string }> } {
  const calls: Array<{ url: string; auth: string | null; method: string }> = [];
  return {
    calls,
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const headers = new Headers(init.headers);
      calls.push({ url, auth: headers.get("authorization"), method: init.method ?? "GET" });
      const route = routes[url];
      return route ? route(init) : new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
}

test("the registry client follows the anonymous token challenge and reads digests from HEAD", async () => {
  const base = "https://ghcr.io/v2/gufo-org/toolboxes/gufo-runtime";
  const digest = `sha256:${"a".repeat(64)}`;
  const authorized = (init: RequestInit): boolean => new Headers(init.headers).get("authorization") === "Bearer tok";
  const challenge = { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:gufo-org/toolboxes/gufo-runtime:pull"' } };
  const { fetch, calls } = fakeFetch({
    [`${base}/tags/list?n=1000`]: (init) => (authorized(init) ? Response.json({ name: "x", tags: ["0.31.0", "latest", 7] }) : new Response("", challenge)),
    "https://ghcr.io/token?service=ghcr.io&scope=repository%3Agufo-org%2Ftoolboxes%2Fgufo-runtime%3Apull": () => Response.json({ token: "tok" }),
    [`${base}/manifests/0.31.0`]: (init) => (authorized(init) ? new Response(null, { headers: { "docker-content-digest": digest } }) : new Response("", challenge)),
    [`${base}/manifests/bad`]: () => new Response(null, { headers: { "docker-content-digest": "md5:1" } }),
  });
  const client = createRegistryClient(fetch);
  assert.deepEqual(await client.tags("ghcr.io/gufo-org/toolboxes/gufo-runtime"), ["0.31.0", "latest"]);
  assert.equal(await client.digest("ghcr.io/gufo-org/toolboxes/gufo-runtime", "0.31.0"), digest);
  assert.equal(calls.filter((call) => call.url.startsWith("https://ghcr.io/token")).length, 1, "the token is reused");
  assert.equal(calls.at(-1)!.method, "HEAD");
  assert.equal(await client.digest("ghcr.io/gufo-org/toolboxes/gufo-runtime", "bad"), null);
  await assert.rejects(client.digest("ghcr.io/gufo-org/toolboxes/gufo-runtime", "missing"), /answered 404/);
});

test("the registry client refuses challenges it can't answer anonymously", async () => {
  const { fetch } = fakeFetch({
    "https://registry.example/v2/a/tags/list?n=1000": () => new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="x"' } }),
  });
  await assert.rejects(createRegistryClient(fetch).tags("registry.example/a"), /credentials the portal doesn't have/);
});

test("release notes: stable releases only, by version, cut when long, breaking changes flagged", async () => {
  const { fetch, calls } = fakeFetch({
    "https://api.github.com/repos/gufo-org/gufo/releases?per_page=30": () =>
      Response.json([
        { tag_name: "v0.34.0", name: "v0.34.0", html_url: "https://github.com/gufo-org/gufo/releases/tag/v0.34.0", published_at: "2026-11-11T22:36:39Z", body: "### ⚠ BREAKING CHANGES\n* audio", draft: false, prerelease: false },
        { tag_name: "v0.35.0-rc.1", body: "rc", draft: false, prerelease: true },
        { tag_name: "v0.33.0", name: "", html_url: "javascript:alert(1)", published_at: null, body: "x".repeat(20_000) },
        { tag_name: "nightly", body: "" },
      ]),
  });
  const notes = await createNotesClient(fetch).notes("gufo-org/gufo");
  assert.deepEqual([...notes.keys()], ["0.34.0", "0.33.0"]);
  assert.deepEqual(notes.get("0.34.0"), {
    title: "v0.34.0",
    url: "https://github.com/gufo-org/gufo/releases/tag/v0.34.0",
    publishedAt: Date.parse("2026-11-11T22:36:39Z"),
    body: "### ⚠ BREAKING CHANGES\n* audio",
    breaking: true,
  });
  const long = notes.get("0.33.0")!;
  assert.equal(long.title, "v0.33.0");
  assert.equal(long.url, "https://github.com/gufo-org/gufo/releases", "only github.com links");
  assert.ok(long.body.length < 12_100 && long.body.endsWith("…"));
  assert.equal(calls[0]!.auth, null, "anonymous");
});

test("the release list is cached for 10 minutes; a failed check keeps the last list and retries after a minute", async () => {
  const clock = { now: 0 };
  const registry = new FakeEngineRegistry();
  const releases = new EngineReleases({ registry, notes: new FakeNotes(), notesRepo: "gufo-org/gufo", now: () => clock.now });
  const repo = "ghcr.io/gufo-org/toolboxes/gufo-runtime";
  const first = await releases.list(repo);
  assert.equal(first.releases.length, 5);
  assert.equal(first.error, null);
  clock.now += 9 * 60_000;
  await releases.list(repo);
  assert.equal(registry.calls, 1);
  clock.now += 2 * 60_000;
  registry.failing = true;
  const failed = await releases.list(repo);
  assert.equal(registry.calls, 2);
  assert.match(failed.error!, /503/);
  assert.equal(failed.releases.length, 5, "the last good list stays");
  clock.now += 30_000;
  await releases.list(repo);
  assert.equal(registry.calls, 2, "no retry within a minute");
  clock.now += 31_000;
  registry.failing = false;
  assert.equal((await releases.list(repo)).error, null);
  assert.equal(registry.calls, 3);
  await assert.rejects(releases.resolve(repo, "0.99.0"), /no digest/);
  await assert.rejects(releases.resolve(repo, "latest"), /not a release version/);
});
