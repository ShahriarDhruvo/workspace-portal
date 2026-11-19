// The LLM API behind a user's API keys (service/llm-api.ts), on the control API's port as the web app reaches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { eq } from "drizzle-orm";
import { apiKeys, apiKeyUsage, hashSessionToken, llmUsage, users, workspaceSessions } from "@portal/core";
import { CONTROL_SECRET, json, request, waitFor, withGateway, type Gateway, type Reply, type RequestOptions } from "./harness.ts";

const KEY = "sk-0123456789abcdef0123456789abcdef0123456789abcdef";

function addKey(g: Gateway, userId: number, key = KEY): number {
  return g.db.insert(apiKeys).values({ userId, name: "editor", tokenHash: hashSessionToken(key), hint: key.slice(-4), createdAt: 1 }).returning().get().id;
}

const api = (g: Gateway, path: string, options: RequestOptions & { key?: string | null } = {}): Promise<Reply> => {
  const { key = KEY, headers, ...rest } = options;
  return request(g.ports.control, { ...rest, path: `/llm/api${path}`, headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...headers } });
};

test("only a working key of an account that may use the portal opens the API", async () => {
  await withGateway({}, async (g) => {
    const alice = g.ids.alice;
    const keyId = addKey(g, alice);
    assert.equal((await api(g, "/v1/models")).status, 200);

    const refused = async (what: string, options: Parameters<typeof api>[2] = {}): Promise<void> => {
      const sent = g.llm.requests.length;
      const reply = await api(g, "/v1/models", options);
      assert.equal(reply.status, 401, what);
      assert.equal(json<{ error: { code: string } }>(reply).error.code, "invalid_api_key");
      assert.equal(reply.headers["www-authenticate"], "Bearer");
      assert.equal(reply.headers["access-control-allow-origin"], "*", "a page of another site can read why");
      assert.equal(g.llm.requests.length, sent, "nothing reached the LLM server");
    };
    await refused("no key", { key: null });
    await refused("a key nobody has", { key: "sk-none" });
    await refused("the control secret", { key: CONTROL_SECRET });
    await refused("the LLM server's own key", { key: "test-llm-key" });

    const account = (values: Partial<typeof users.$inferInsert>) => g.db.update(users).set(values).where(eq(users.id, alice)).run();
    account({ active: false });
    await refused("a deactivated account");
    account({ active: true, mustChangePassword: true });
    await refused("an account with a temporary password");
    account({ mustChangePassword: false });
    assert.equal((await api(g, "/v1/models")).status, 200);

    g.db.update(apiKeys).set({ revokedAt: 2 }).where(eq(apiKeys.id, keyId)).run();
    await refused("a revoked key");
  });
});

test("every path, method, header and body reaches the LLM server as it was sent, but for the key", async () => {
  await withGateway({}, async (g) => {
    addKey(g, g.ids.alice);
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] });
    for (const [method, path, upstream] of [
      ["GET", "/v1/models", "/v1/models"],
      ["GET", "/slots?fail_on_no_slot=1", "/slots?fail_on_no_slot=1"],
      ["GET", "", "/"],
      ["POST", "/v1/responses", "/v1/responses"],
      ["POST", "/tokenize", "/tokenize"],
      ["DELETE", "/v1/videos/video%201", "/v1/videos/video%201"],
    ] as const) {
      const reply = await api(g, path, { method, headers: { "content-type": "application/json", "x-trace": "abc", cookie: "portal_session=x" }, body: method === "POST" ? body : undefined });
      assert.equal(reply.status, 200, `${method} ${path}`);
      const seen = g.llm.requests.at(-1)!;
      assert.deepEqual([seen.method, seen.url], [method, upstream]);
      assert.equal(seen.headers.authorization, "Bearer test-llm-key", "the user's key stays in the portal");
      assert.equal(seen.headers["x-trace"], "abc");
      if (method === "POST") assert.equal(seen.headers["content-length"], String(Buffer.byteLength(body)), "not chunked: the engine reads no chunked bodies");
    }

    // Anthropic's clients send the key as x-api-key.
    const messages = await api(g, "/v1/messages", { method: "POST", key: null, headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" }, body });
    assert.equal(messages.status, 200);
    assert.equal(g.llm.requests.at(-1)!.headers["x-api-key"], undefined);
    assert.equal(g.llm.requests.at(-1)!.headers["anthropic-version"], "2023-06-01");

    // A browser's preflight carries no key.
    assert.equal((await api(g, "/v1/chat/completions", { method: "OPTIONS", key: null, headers: { origin: "https://example.org" } })).status, 200);
    assert.equal(g.llm.requests.at(-1)!.method, "OPTIONS");

    const sent = g.llm.requests.length;
    assert.equal((await api(g, "/v1/../../control/health")).status, 400);
    assert.equal((await api(g, "/%2e%2e/props")).status, 400);
    assert.equal((await request(g.ports.control, { path: "/llm/apis" })).status, 401, "another path is the control API's, which wants its secret");
    assert.equal(g.llm.requests.length, sent);
  });
});

test("a key's generations are counted for the key and its user, wait their turn, and are no workspace's", async () => {
  await withGateway({}, async (g) => {
    const alice = g.ids.alice;
    const keyId = addKey(g, alice);
    await g.startReady(alice);
    const post = (path: string, body: unknown): Promise<Reply> => api(g, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    assert.equal((await post("/v1/chat/completions", { model: "m", messages: [] })).status, 200);
    const streamed = await post("/v1/chat/completions", { model: "m", stream: true, messages: [] });
    assert.ok(streamed.body.endsWith("data: [DONE]\n\n"));
    assert.equal((await post("/v1/chat/completions", { fail: true })).status, 500);
    // Counting a prompt's tokens is no generation.
    assert.equal((await post("/v1/chat/completions/input_tokens", { model: "m", messages: [] })).status, 200);

    const usage = g.db.select().from(apiKeyUsage).where(eq(apiKeyUsage.keyId, keyId)).all();
    assert.equal(usage.length, 1);
    assert.deepEqual({ ...usage[0], day: "" }, { keyId, day: "", requests: 3, failed: 1, promptTokens: 11 + 12, outputTokens: 22 + 34, energyJ: 0 });
    assert.deepEqual(g.finishedRequests.map((finished) => finished.keyId), [keyId, keyId, keyId]);
    const day = g.db.select().from(llmUsage).where(eq(llmUsage.userId, alice)).get()!;
    assert.deepEqual([day.requests, day.promptTokens, day.completionTokens], [2, 23, 56], "the user's day counts what the LLM server answered");
    assert.equal(g.db.select().from(workspaceSessions).where(eq(workspaceSessions.userId, alice)).get()!.requests, 0);
    assert.equal(g.info(alice).llmInFlight, 0);

    // The user's limit (1 here) is one for the keys and the workspace together.
    const held = http.request({ host: "127.0.0.1", port: g.ports.control, method: "POST", path: "/llm/api/v1/chat/completions", headers: { authorization: `Bearer ${KEY}` }, agent: false });
    held.on("error", () => undefined);
    held.end(JSON.stringify({ hold: true }));
    await waitFor(() => g.llmQueue.inFlight === 1, "the key's request to reach the LLM server");
    g.caller.userId = alice;
    const queued = http.request({ host: "127.0.0.1", port: g.ports.service, method: "POST", path: "/llm/v1/chat/completions", agent: false });
    queued.on("error", () => undefined);
    queued.end(JSON.stringify({ stream: false }));
    await waitFor(() => g.llmQueue.queued === 1, "the workspace's request to queue behind it");
    const abandoned = g.llm.abandoned;
    queued.destroy();
    held.destroy();
    await waitFor(() => g.llmQueue.inFlight === 0 && g.llmQueue.queued === 0, "both to leave");
    await waitFor(() => g.llm.abandoned === abandoned + 1, "the upstream request to be aborted");
    assert.deepEqual(g.errors(), []);
  });
});
