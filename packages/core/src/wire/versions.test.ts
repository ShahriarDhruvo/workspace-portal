import { test } from "node:test";
import assert from "node:assert/strict";
import { byNewestVersion, compareVersions, findVersion, isNewerVersion, isStableVersion, isVersion } from "./versions.ts";

test("isVersion accepts npm versions and nothing that could leave an image tag or a KEY=VALUE line", () => {
  for (const good of ["0.27.4", "0.2.2-rc.3", "0.27.2-nightly.20261113.6f754be654", "1.0.0-alpha", "10.20.30", "0.28.1-beta.2"]) {
    assert.equal(isVersion(good), true, good);
  }
  for (const bad of ["", "latest", "1.2", "v1.2.3", "1.2.3 ", "1.2.3\n", "1.2.3;rm", "1.2.3-a b", "../1.2.3", "1.2.3:x", "1.2.3-x/y", "1.2.3=4", `1.2.3-${"a".repeat(100)}`, 1, null]) {
    assert.equal(isVersion(bad), false, JSON.stringify(bad));
  }
});

test("isStableVersion: X.Y.Z only, compared numerically", () => {
  assert.deepEqual(["0.9.0", "0.10.0", "0.31.0", "1.0.0", "0.31.1"].sort((a, b) => compareVersions(a, b)!), ["0.9.0", "0.10.0", "0.31.0", "0.31.1", "1.0.0"]);
  for (const version of ["0.34.0", "10.0.1"]) assert.equal(isStableVersion(version), true, version);
  for (const tag of ["latest", "edge", "sha-abc", "v0.34.0", "0.34", "0.34.0-rc.1", "0.34.0 "]) assert.equal(isStableVersion(tag), false, tag);
});

test("findVersion takes the first version in a CLI's output, with the syntax isVersion accepts", () => {
  assert.equal(findVersion("Qwen Code 0.27.4 (linux)\n"), "0.27.4");
  assert.equal(findVersion("dsh 0.2.2-rc.3\nnode 24.1.0\n"), "0.2.2-rc.3");
  assert.equal(findVersion("no version here\n"), null);
});

test("compareVersions follows semver precedence, prereleases included", () => {
  // semver.org §11's example, in ascending order.
  const ascending = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
    "10.0.0",
  ];
  for (let i = 0; i < ascending.length; i++) {
    for (let j = 0; j < ascending.length; j++) {
      const order = compareVersions(ascending[i]!, ascending[j]!);
      assert.equal(Math.sign(order!), Math.sign(i - j), `${ascending[i]} vs ${ascending[j]}`);
    }
  }
  assert.equal(compareVersions("1.0.0+build.1", "1.0.0"), 0, "build metadata does not count");
  assert.equal(compareVersions("0.2.2-nightly.20261113.6f754be654", "0.2.2-nightly.20261112.ffffffffff"), 1);
  assert.equal(compareVersions("1.0.0-99999999999999999999", "1.0.0-100000000000000000000"), -1, "big numeric identifiers");
  assert.equal(compareVersions("1.2.3.4", "1.2.3"), null, "not semver: no order");
});

test("an update is available only for a newer version", () => {
  assert.equal(isNewerVersion("0.27.4", "0.27.0"), true);
  assert.equal(isNewerVersion("0.2.2-rc.1", "0.2.2-rc.3"), false, "current from 'next' is ahead of 'latest'");
  assert.equal(isNewerVersion("0.2.2", "0.2.2-rc.3"), true, "the release after its release candidates");
  assert.equal(isNewerVersion("0.27.0", "0.27.0"), false);
  assert.equal(isNewerVersion("1.2.3.4", "1.2.3"), false, "unordered versions never count as an update");
});

test("byNewestVersion sorts newest first, unordered versions last", () => {
  assert.deepEqual(
    ["0.27.0", "1.2.3.4", "0.28.0-rc.1", "0.28.0", "0.9.1"].sort(byNewestVersion),
    ["0.28.0", "0.28.0-rc.1", "0.27.0", "0.9.1", "1.2.3.4"],
  );
});
