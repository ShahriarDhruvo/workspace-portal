import { test } from "node:test";
import assert from "node:assert/strict";
import { hashSessionToken, type SessionContext } from "@portal/db";
import { SessionCache } from "./session-cache.ts";

function context(userId: number, targetId = userId): SessionContext {
  const user = { id: userId } as SessionContext["user"];
  const target = { id: targetId } as SessionContext["target"];
  return { session: { id: `s${userId}` } as SessionContext["session"], user, target, actingAs: userId !== targetId };
}

test("lookups are cached for the TTL, including misses", () => {
  let now = 0;
  const loads: string[] = [];
  const known = new Map([[hashSessionToken("tok-a"), context(1)]]);
  const cache = new SessionCache(
    (hash) => {
      loads.push(hash);
      return known.get(hash) ?? null;
    },
    { ttlMs: 5_000, now: () => now },
  );

  assert.equal(cache.fromCookieHeader("x=1; portal_session=tok-a")?.user.id, 1);
  assert.equal(cache.fromCookieHeader("portal_session=tok-a")?.user.id, 1);
  assert.equal(cache.fromCookieHeader("portal_session=nope"), null);
  assert.equal(cache.fromCookieHeader("portal_session=nope"), null);
  assert.equal(cache.fromCookieHeader(undefined), null);
  assert.equal(loads.length, 2);

  now = 5_000;
  cache.fromCookieHeader("portal_session=tok-a");
  assert.equal(loads.length, 3, "expired entries are reloaded");
});

test("a cached session is not served past its own expiry", () => {
  let now = 0;
  const ctx = context(1);
  ctx.session.expiresAt = 2_000;
  let loads = 0;
  const cache = new SessionCache(
    () => {
      loads += 1;
      return now < 2_000 ? ctx : null;
    },
    { ttlMs: 5_000, now: () => now },
  );
  assert.equal(cache.fromCookieHeader("portal_session=tok")?.user.id, 1);
  now = 2_000;
  assert.equal(cache.fromCookieHeader("portal_session=tok"), null, "reloaded at expiry, not after the TTL");
  assert.equal(loads, 2);
});

test("invalidation by session and by user", () => {
  const loads: string[] = [];
  const contexts = new Map([
    ["h-alice", context(1)],
    ["h-admin", context(9, 1)],
    ["h-bob", context(2)],
  ]);
  const cache = new SessionCache((hash) => {
    loads.push(hash);
    return contexts.get(hash) ?? null;
  });
  for (const hash of contexts.keys()) cache.get(hash);
  assert.equal(loads.length, 3);

  cache.invalidateSession("h-bob");
  cache.get("h-bob");
  assert.equal(loads.length, 4);

  cache.invalidateUser(1);
  cache.get("h-alice");
  cache.get("h-admin");
  cache.get("h-bob");
  assert.deepEqual(loads.slice(4), ["h-alice", "h-admin"], "the admin viewing user 1 is dropped too");
});
