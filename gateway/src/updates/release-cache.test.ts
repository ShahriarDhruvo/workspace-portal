import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitHubRelease, GitHubReleases, ReleaseNotes } from "./github-releases.ts";
import { RegistryError, type NpmPackage, type NpmRegistry } from "./npm-registry.ts";
import { NOTES_TTL_MS, notesByVersion, ReleaseCache, RELEASES_RETRY_MS, RELEASES_TTL_MS } from "./release-cache.ts";

const QWEN = "@qwen-code/qwen-code";
const DSH = "@deepseek-ai/dsh";

const pkg = (latest: string, githubRepo: string | null = null): NpmPackage => ({
  distTags: { latest },
  versions: [{ version: latest, publishedAt: 1_000, deprecated: false }],
  githubRepo,
});

/** A registry whose documents carry an ETag that changes with them: a request with the current one gets a 304. */
function fakeRegistry() {
  const state = {
    packages: { [QWEN]: pkg("0.27.4", "QwenLM/qwen-code"), [DSH]: pkg("0.2.2-rc.1") } as Record<string, NpmPackage>,
    revisions: { [QWEN]: 1, [DSH]: 1 } as Record<string, number>,
    down: false,
    calls: [] as Array<{ name: string; etag: string | null; notModified: boolean }>,
    gate: null as Promise<void> | null,
  };
  const registry: NpmRegistry = {
    async packument(name, etag = null) {
      await state.gate;
      if (state.down) throw new RegistryError("The npm registry is unreachable (fetch failed).");
      const current = `"${name}-${state.revisions[name]}"`;
      state.calls.push({ name, etag, notModified: etag === current });
      return etag === current ? null : { etag: current, package: structuredClone(state.packages[name]!) };
    },
    async hasVersion() {
      return true;
    },
  };
  const publish = (name: string, next: NpmPackage) => {
    state.packages[name] = next;
    state.revisions[name] = (state.revisions[name] ?? 0) + 1;
  };
  return { state, registry, publish };
}

const notes = (title: string, breaking = false): ReleaseNotes => ({ title, url: `https://github.com/QwenLM/qwen-code/releases/tag/${title}`, publishedAt: 1_000, body: "", breaking });

function fakeGitHub(releases: GitHubRelease[]) {
  const state = { releases, down: false, calls: 0 };
  const github: GitHubReleases = {
    async list() {
      state.calls++;
      if (state.down) throw new Error("GitHub answered 403 for QwenLM/qwen-code's releases");
      return state.releases;
    },
  };
  return { state, github };
}

test("answers are kept for 10 minutes; then the registry is asked with the ETag, and only a change downloads again", async () => {
  const clock = { now: 1_000_000 };
  const { state, registry, publish } = fakeRegistry();
  const cache = new ReleaseCache({ registry, now: () => clock.now });
  const first = await cache.snapshot([QWEN, DSH]);
  assert.deepEqual(first.packages.get(QWEN)?.distTags, { latest: "0.27.4" });
  assert.deepEqual(first.packages.get(DSH)?.versions, [{ version: "0.2.2-rc.1", publishedAt: 1_000, deprecated: false }]);
  assert.deepEqual([first.checkedAt, first.error], [1_000_000, null]);
  assert.equal(state.calls.length, 2);

  publish(QWEN, pkg("0.28.0", "QwenLM/qwen-code"));
  clock.now += RELEASES_TTL_MS - 1;
  assert.deepEqual((await cache.snapshot([QWEN, DSH])).packages.get(QWEN)?.distTags, { latest: "0.27.4" }, "still fresh");
  assert.equal(state.calls.length, 2);
  const refreshed = await cache.snapshot([QWEN, DSH], { refresh: true });
  assert.deepEqual(refreshed.packages.get(QWEN)?.distTags, { latest: "0.28.0" });
  assert.equal(refreshed.checkedAt, clock.now);
  assert.deepEqual(
    state.calls.slice(2).map((call) => [call.name, call.notModified]),
    [
      [QWEN, false],
      [DSH, true],
    ],
    "each asked with its ETag; the unchanged one answered 304",
  );
  clock.now += RELEASES_TTL_MS;
  const again = await cache.snapshot([QWEN, DSH]);
  assert.equal(state.calls.length, 6, "stale after 10 minutes");
  assert.deepEqual(again.packages.get(DSH)?.distTags, { latest: "0.2.2-rc.1" }, "a 304 keeps what was known");
});

test("an outage keeps the last answers, reports the error and retries after a minute", async () => {
  const clock = { now: 1_000_000 };
  const { state, registry } = fakeRegistry();
  const cache = new ReleaseCache({ registry, now: () => clock.now });
  await cache.snapshot([QWEN, DSH]);
  state.down = true;
  clock.now += RELEASES_TTL_MS;
  const down = await cache.snapshot([QWEN, DSH]);
  assert.equal(down.error, "The npm registry is unreachable (fetch failed).");
  assert.equal(down.checkedAt, 1_000_000, "when it last worked");
  assert.deepEqual(down.packages.get(QWEN)?.distTags, { latest: "0.27.4" }, "the stale answer");
  const calls = state.calls.length;
  clock.now += RELEASES_RETRY_MS - 1;
  assert.equal((await cache.snapshot([QWEN, DSH])).error, down.error);
  assert.equal(state.calls.length, calls, "polls don't hammer a registry that is down");
  state.down = false;
  clock.now += 1;
  const back = await cache.snapshot([QWEN, DSH]);
  assert.deepEqual([back.error, back.checkedAt], [null, clock.now]);
});

test("a registry that was never reached leaves the releases unknown", async () => {
  const { state, registry } = fakeRegistry();
  state.down = true;
  const snapshot = await new ReleaseCache({ registry }).snapshot([QWEN]);
  assert.deepEqual([snapshot.packages.size, snapshot.checkedAt], [0, null]);
  assert.match(snapshot.error!, /unreachable/);
});

test("concurrent callers share one check", async () => {
  const { state, registry } = fakeRegistry();
  let open!: () => void;
  state.gate = new Promise((resolve) => (open = resolve));
  const cache = new ReleaseCache({ registry });
  const both = Promise.all([cache.snapshot([QWEN]), cache.snapshot([QWEN], { refresh: true })]);
  open();
  await both;
  assert.deepEqual(
    state.calls.map((call) => call.name),
    [QWEN],
  );
});

test("release notes come from the package's GitHub repository: again when it changed, else hourly; a failure keeps them", async () => {
  const clock = { now: 1_000_000 };
  const { registry, publish } = fakeRegistry();
  const { state: github, github: client } = fakeGitHub([
    { tag: "v0.27.4", prerelease: false, notes: notes("v0.27.4") },
    { tag: "desktop-v0.27.4", prerelease: false, notes: notes("desktop-v0.27.4") },
  ]);
  const cache = new ReleaseCache({ registry, github: client, now: () => clock.now });
  const first = await cache.snapshot([QWEN, DSH]);
  assert.deepEqual([...(first.packages.get(QWEN)?.notes.keys() ?? [])], ["0.27.4"]);
  assert.equal(first.packages.get(DSH)?.notes.size, 0, "a package without a GitHub repository has none");
  assert.equal(github.calls, 1, "DeepSeek Harness names no repository here: GitHub isn't asked for it");

  clock.now += RELEASES_TTL_MS;
  await cache.snapshot([QWEN, DSH]);
  assert.equal(github.calls, 1, "the package didn't change and the notes are under an hour old");
  github.releases = [{ tag: "v0.28.0", prerelease: false, notes: notes("v0.28.0", true) }, ...github.releases];
  publish(QWEN, pkg("0.28.0", "QwenLM/qwen-code"));
  clock.now += RELEASES_TTL_MS;
  const published = await cache.snapshot([QWEN, DSH]);
  assert.equal(github.calls, 2, "a new release: the notes are read again");
  assert.equal(published.packages.get(QWEN)?.notes.get("0.28.0")?.breaking, true);

  github.down = true;
  clock.now += NOTES_TTL_MS;
  const kept = await cache.snapshot([QWEN, DSH]);
  assert.equal(github.calls, 3, "an hour on, asked again");
  assert.deepEqual([kept.error, kept.packages.get(QWEN)?.notes.size], [null, 2], "GitHub down: the last notes stay, and it is no registry error");
});

test("notesByVersion keeps the package's own releases, by the version their tag names", () => {
  const releases = [
    { tag: "dsh-v0.2.2-rc.3", notes: notes("rc3") },
    { tag: "v0.2.2-rc.1", notes: notes("plain") },
    { tag: "dsh-v0.2.2-rc.1", notes: notes("rc1") },
    { tag: "cli-v0.2.0", notes: notes("other product") },
    { tag: "nightly", notes: notes("not a version") },
  ];
  const byVersion = notesByVersion(releases, "@deepseek-ai/dsh");
  assert.deepEqual(
    [...byVersion].map(([version, entry]) => [version, entry.title]),
    [
      ["0.2.2-rc.3", "rc3"],
      ["0.2.2-rc.1", "plain"],
    ],
    "the newest of two tags for one version wins",
  );
});
