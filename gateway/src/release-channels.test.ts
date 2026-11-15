import { test } from "node:test";
import assert from "node:assert/strict";
import { isChannelName, releaseChannels } from "./release-channels.ts";

test("only release channels are offered, latest first, and only with a usable version", () => {
  // Qwen Code's real dist-tags (November 2026).
  const qwen = {
    jobbench: "0.20.2-jobbench-no-todo-write.0",
    "gdpval-vl-agent": "0.20.2-gdpval-vl-agent.1",
    dev: "0.23.5-dev.codemode-responses.20260915.f024b37689",
    preview: "0.27.2-preview.0",
    latest: "0.27.4",
    nightly: "0.27.2-nightly.20261113.6f754be654",
  };
  assert.deepEqual(releaseChannels(qwen), [
    { tag: "latest", version: "0.27.4" },
    { tag: "preview", version: "0.27.2-preview.0" },
    { tag: "nightly", version: "0.27.2-nightly.20261113.6f754be654" },
  ]);
  assert.deepEqual(releaseChannels({ alpha: "0.2.2-alpha.3", latest: "0.2.2-rc.1", next: "0.2.2-rc.3" }), [
    { tag: "latest", version: "0.2.2-rc.1" },
    { tag: "next", version: "0.2.2-rc.3" },
    { tag: "alpha", version: "0.2.2-alpha.3" },
  ]);
  assert.deepEqual(releaseChannels({ latest: "not a version", beta: "1.0.0-beta.1", rc: "1.0.0;rm" }), [{ tag: "beta", version: "1.0.0-beta.1" }]);
  assert.deepEqual(releaseChannels(JSON.parse('{"__proto__":{"latest":"6.6.6"}}') as Record<string, string>), [], "inherited keys don't count");
  assert.deepEqual(releaseChannels({}), []);
});

test("isChannelName: dist-tag shaped words only", () => {
  for (const name of ["latest", "next", "nightly", "gdpval-vl-agent"]) assert.equal(isChannelName(name), true, name);
  for (const name of ["", "Latest", "1.2", "latest\n", "../x", "a".repeat(65), "next tag"]) assert.equal(isChannelName(name), false, name);
});
