import { test } from "node:test";
import assert from "node:assert/strict";
import { apiKeys, apiKeyUsage, users } from "@portal/core";
import { quiet, tempDb } from "../../test/fakes.ts";
import { KeyUsage } from "./key-usage.ts";
import type { FinishedLlmRequest } from "./llm-requests.ts";

test("a key's requests and energy add up per local day", () => {
  const db = tempDb();
  const userId = db.insert(users).values({ username: "ana", firstName: "Ana", lastName: "L", passwordHash: "x", createdAt: 1, updatedAt: 1 }).returning().get().id;
  const keyId = db.insert(apiKeys).values({ userId, name: "editor", tokenHash: "h", hint: "abcd", createdAt: 1 }).returning().get().id;
  const clock = { now: new Date(2026, 10, 18, 23, 59).getTime() };
  const usage = new KeyUsage({ db, log: quiet, now: () => clock.now });
  const finished = (changes: Partial<FinishedLlmRequest>): FinishedLlmRequest => ({
    id: 1,
    userId,
    keyId,
    forwardedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    queueMs: 0,
    ttftMs: null,
    timings: null,
    usage: { promptTokens: 100, completionTokens: 20 },
    ok: true,
    ...changes,
  });

  usage.addEnergy([{ keyId, joules: 30 }]);
  usage.finished(keyId, finished({}));
  usage.finished(keyId, finished({ ok: false, usage: null }));
  usage.addEnergy([{ keyId, joules: 12 }]);
  clock.now += 2 * 60_000;
  usage.finished(keyId, finished({}));
  usage.addEnergy([{ keyId: keyId + 1, joules: 1 }]); // a key that is gone: logged, nothing counted

  assert.deepEqual(db.select().from(apiKeyUsage).all(), [
    { keyId, day: "2026-11-18", requests: 2, failed: 1, promptTokens: 100, outputTokens: 20, energyJ: 42 },
    { keyId, day: "2026-11-19", requests: 1, failed: 0, promptTokens: 100, outputTokens: 20, energyJ: 0 },
  ]);
});
