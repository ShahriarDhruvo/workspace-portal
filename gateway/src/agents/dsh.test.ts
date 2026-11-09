import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AgentConfigError } from "./driver.ts";
import { DSH_COOKIE_NAME, dshDriver, jobSessionIds, mintDshCookie, parseJobRows, parseSessionList, pendingInput, rpcValue } from "./dsh.ts";
import { DSH_MIN_MESSAGE_BUDGET, dshPatchRows, fitDshModels, renderDshPatch } from "./dsh-settings.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, portalModels, type ModelCatalog } from "./models.ts";

const SERVICE = "http://172.29.0.1:4001";
const SECRET = crypto.randomBytes(32).toString("base64url");

// ------------------------------------------------------------------ models

test("portalModels reads Qwen Code's model list, with the same default model", () => {
  const catalog = portalModels({
    settings: {},
    systemDefaults: {
      model: { name: "big" },
      modelProviders: {
        openai: [
          {
            id: "small",
            name: "Small",
            generationConfig: { contextWindowSize: 32_768, samplingParams: { max_tokens: 4096 }, modalities: { image: false } },
          },
          {
            id: "big",
            name: "Big",
            capabilities: { reasoning: { efforts: ["low", "medium", "xhigh", "bad effort!", 3], defaultEffort: "xhigh" } },
            generationConfig: { contextWindowSize: 262_144, samplingParams: { max_tokens: 32_768 }, modalities: { image: true } },
          },
        ],
      },
    },
  });
  assert.deepEqual(catalog, {
    defaultModel: "big",
    models: [
      { id: "small", name: "Small", contextWindow: 32_768, maxTokens: 4096, image: false, efforts: [], defaultEffort: null },
      { id: "big", name: "Big", contextWindow: 262_144, maxTokens: 32_768, image: true, efforts: ["low", "medium", "xhigh"], defaultEffort: "xhigh" },
    ],
  });
});

test("portalModels: defaults, odd entries, duplicates, and settings.json's list replacing the defaults'", () => {
  const sparse = portalModels({ settings: {}, systemDefaults: { modelProviders: { openai: [{ id: " m " }, { name: "no id" }, "x", { id: "m" }] } } });
  assert.deepEqual(sparse, {
    defaultModel: "m",
    models: [{ id: "m", name: "m", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, image: false, efforts: [], defaultEffort: null }],
  });
  const tiny = portalModels({ settings: {}, systemDefaults: { modelProviders: { openai: [{ id: "t", generationConfig: { contextWindowSize: 2048 } }] } } });
  assert.equal(tiny.models[0]!.maxTokens, 2048, "never more output than the context window");
  const unknownEffort = portalModels({ settings: {}, systemDefaults: { modelProviders: { openai: [{ id: "r", capabilities: { reasoning: { efforts: ["low"], defaultEffort: "max" } } }] } } });
  assert.equal(unknownEffort.models[0]!.defaultEffort, null);

  const replaced = portalModels({
    settings: { modelProviders: { openai: [{ id: "admin-model" }] } },
    systemDefaults: { model: { name: "default-model" }, modelProviders: { openai: [{ id: "default-model" }] } },
  });
  assert.deepEqual(replaced.models.map((model) => model.id), ["admin-model"]);
  assert.equal(replaced.defaultModel, "admin-model", "a default that isn't offered falls back to the first model");
});

test("fitDshModels: output caps shrink to fit dsh's compaction budget; models too small for it are left out", () => {
  const model = (id: string, contextWindow: number, maxTokens: number) => ({ id, name: id, contextWindow, maxTokens, image: false, efforts: [], defaultEffort: null });
  const fitted = fitDshModels({
    defaultModel: "small",
    models: [model("big", 262_144, 32_768), model("tight", 131_072, 65_536), model("small", 65_536, 8192)],
  });
  assert.deepEqual(
    fitted.models.map((m) => [m.id, m.maxTokens]),
    [["big", 32_768], ["tight", 131_072 - DSH_MIN_MESSAGE_BUDGET]],
  );
  assert.equal(fitted.defaultModel, "big", "the default was left out: the first model that fits");
  assert.equal(fitDshModels({ defaultModel: "tight", models: [model("big", 262_144, 32_768), model("tight", 131_072, 65_536)] }).defaultModel, "tight");
  assert.throws(() => fitDshModels({ defaultModel: "small", models: [model("small", 65_536, 8192)] }), (error: unknown) => {
    assert.ok(error instanceof AgentConfigError);
    assert.match(error.message, /at least 82116 tokens/);
    return true;
  });
});

// ------------------------------------------------------------------ portal.patch.yml

const CATALOG: ModelCatalog = {
  defaultModel: "big",
  models: [
    { id: "small", name: "Small", contextWindow: 32_768, maxTokens: 4096, image: false, efforts: [], defaultEffort: null },
    { id: "big", name: 'Big "quoted" !!js process.exit()', contextWindow: 262_144, maxTokens: 32_768, image: true, efforts: ["low", "xhigh"], defaultEffort: "xhigh" },
  ],
};

test("the dsh patch: every model through the gateway, the default model, search and the browser", () => {
  assert.deepEqual(dshPatchRows({ catalog: CATALOG, serviceBaseUrl: SERVICE, browser: true }), [
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          portal: {
            displayName: "Workspace Portal",
            api: "openai-completions",
            baseURL: `${SERVICE}/llm/v1`,
            apiKeyEnv: "PORTAL_LLM_KEY",
            cacheRetention: "none",
            timeoutMs: 3_600_000,
            streamIdleTimeoutMs: 3_600_000,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: true,
              supportsUsageInStreaming: true,
              supportsStrictMode: false,
              supportsLongCacheRetention: false,
              maxTokensField: "max_tokens",
            },
            models: [
              { id: "small", name: "Small", contextWindow: 32_768, maxTokens: 4096, input: ["text"], reasoningEfforts: false },
              {
                id: "big",
                name: 'Big "quoted" !!js process.exit()',
                contextWindow: 262_144,
                maxTokens: 32_768,
                input: ["text", "image"],
                reasoningEfforts: { low: "low", xhigh: "xhigh" },
              },
            ],
          },
        },
      },
    },
    { id: "agent-default-model", config: { provider: "portal", model: "big", reasoningEffort: "xhigh" } },
    {
      insert: [
        { id: "mcp-search", name: "@deepseek-ai/dsh-mcp-client", config: { transport: "streamable-http", serverName: "search", url: `${SERVICE}/mcp/search`, toolCallTimeoutMs: 60_000 } },
        {
          id: "mcp-browser",
          name: "@deepseek-ai/dsh-mcp-client",
          config: {
            transport: "stdio",
            serverName: "browser",
            command: "/usr/local/bin/playwright-mcp",
            args: ["--headless", "--isolated", "--no-sandbox", "--executable-path=/usr/bin/chromium", "--output-dir=/workspace/.browser"],
            cwd: "/tmp",
            toolCallTimeoutMs: 120_000,
          },
        },
      ],
    },
  ]);
});

test("the dsh patch without the browser, and without a default effort", () => {
  const rows = dshPatchRows({ catalog: { ...CATALOG, defaultModel: "small" }, serviceBaseUrl: SERVICE, browser: false }) as Array<Record<string, any>>;
  assert.deepEqual(rows[1], { id: "agent-default-model", config: { provider: "portal", model: "small" } });
  assert.deepEqual(rows[2]!.insert.map((server: { id: string }) => server.id), ["mcp-search"]);
});

test("the rendered file is JSON under a comment: admin strings stay quoted scalars, never YAML tags", () => {
  const text = renderDshPatch({ catalog: CATALOG, serviceBaseUrl: SERVICE, browser: true });
  const [comments, json] = [text.split("\n").filter((line) => line.startsWith("#")), text.replace(/^#.*\n/gm, "")];
  assert.equal(comments.length, 3);
  assert.deepEqual(JSON.parse(json), dshPatchRows({ catalog: CATALOG, serviceBaseUrl: SERVICE, browser: true }));
  assert.ok(text.includes('"name": "Big \\"quoted\\" !!js process.exit()"'), "the tag-like text is inside a JSON string");
  assert.ok(!/^\s*[^"\s#].*!!js/m.test(text), "no unquoted tag anywhere");
});

// ------------------------------------------------------------------ cookie and headers

test("mintDshCookie: dsh's cookie format, for dsh's loopback authority, signed with the container's secret", () => {
  const now = 1_760_000_000_000;
  const cookie = mintDshCookie(SECRET, now);
  assert.equal(DSH_COOKIE_NAME, `dsh-auth-${crypto.createHash("sha256").update("localhost:3080").digest("base64url")}`);
  const [name, value] = cookie.split("=") as [string, string];
  assert.equal(name, DSH_COOKIE_NAME);
  const [version, body, signature] = value.split(".");
  assert.equal(version, "v1");
  assert.equal(signature, crypto.createHmac("sha256", Buffer.from(SECRET, "base64url")).update(body!).digest("base64url"));
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(claims, { version: 1, authority: "localhost:3080", issuedAt: now - 60_000, expiresAt: now + 10 * 60_000 });
  assert.notEqual(mintDshCookie(crypto.randomBytes(32).toString("base64url"), now), cookie, "another container's secret signs differently");
});

test("dsh request headers: loopback Host, the minted cookie instead of the browser's, Origin only if the browser sent one", () => {
  const endpoint = { host: "172.29.128.9", port: 3080, credential: SECRET };
  const incoming = {
    host: "h:3107",
    origin: "http://h:3107",
    cookie: "portal_session=secret-session; theme=dark",
    authorization: "Bearer browser-token",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const headers = dshDriver.requestHeaders(incoming, endpoint, { authorised: true });
  assert.equal(headers.host, "localhost:3080");
  assert.equal(headers.origin, "http://localhost:3080");
  assert.match(String(headers.cookie), new RegExp(`^${DSH_COOKIE_NAME}=v1\\.`));
  assert.ok(!String(headers.cookie).includes("portal_session"));
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["sec-fetch-site"], undefined);
  assert.equal(headers["content-type"], "application/json");
  assert.equal(dshDriver.requestHeaders({ host: "h:3107" }, endpoint, { authorised: true }).origin, undefined);
  const socket = dshDriver.requestHeaders({ ...incoming, "sec-websocket-key": "k", upgrade: "websocket", connection: "Upgrade" }, endpoint, { authorised: true, websocket: true });
  assert.equal(socket["sec-websocket-key"], undefined);
});

test("dsh container env carries only the cookie secret", () => {
  assert.deepEqual(dshDriver.containerEnv(SECRET, {} as never), [`DSH_COOKIE_SECRET=${SECRET}`]);
  assert.match(dshDriver.generateCredential(), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(dshDriver.generateCredential(), "base64url").length, 32);
});

// ------------------------------------------------------------------ activity

test("dsh user actions: prompts, approvals and changes; not what the UI sends on load or for a terminal", () => {
  for (const path of ["/api/session/prompt", "/api/$events/result", "/api/session/selectModel", "/api/settings/mutate", "/api/terminal/create"]) {
    assert.equal(dshDriver.isUserAction("POST", path), true, path);
  }
  for (const path of [
    "/api/session/list",
    "/api/session/create",
    "/api/session/modelCatalog",
    "/api/workspace/initializeDefault",
    "/api/settings/describe",
    "/api/dynamicCordisRunner/syncInspectManifest",
    "/api/permissionPresets/catalog",
    "/api/llm/listConfigurableProviders",
    "/api/terminal/shells",
  ]) {
    assert.equal(dshDriver.isUserAction("POST", path), false, path);
  }
  assert.equal(dshDriver.isUserAction("GET", "/"), false);
});

// ------------------------------------------------------------------ session API

test("rpcValue and parseSessionList read dsh's RPC answer", () => {
  const body = {
    type: "server-response",
    rpcId: "r",
    result: { ok: true, value: { items: [{ sessionId: "a", running: false, updatedAt: 5 }, { sessionId: "b", running: true }, null] } },
  };
  assert.deepEqual(parseSessionList(rpcValue(body)), [
    { id: "a", running: false, updatedAt: 5 },
    { id: "b", running: true, updatedAt: 0 },
    { id: null, running: false, updatedAt: 0 },
  ]);
  assert.equal(rpcValue({ result: { ok: false, error: { code: "x" } } }), undefined);
  for (const bad of [null, "x", {}, { items: "no" }, [1]]) assert.equal(parseSessionList(bad), null, JSON.stringify(bad));
});

test("pendingInput reads what a turn waits for in session/state", () => {
  assert.deepEqual(pendingInput({ running: true, active: true, pendingInput: ["approval"], queue: [] }), ["approval"]);
  assert.deepEqual(pendingInput({ running: true, pendingInput: [] }), []);
  for (const bad of [null, {}, { pendingInput: "approval" }, { pendingInput: [1, null] }]) assert.deepEqual(pendingInput(bad), [], JSON.stringify(bad));
});

test("background jobs are checked in the most recently used sessions", () => {
  const sessions = Array.from({ length: 40 }, (_, index) => ({ id: `s${index}`, running: false, updatedAt: index }));
  const ids = jobSessionIds([...sessions, { id: null, running: false, updatedAt: 99 }]);
  assert.equal(ids.length, 32);
  assert.deepEqual(ids.slice(0, 2), ["s39", "s38"]);
  assert.ok(!ids.includes("s7"));
});

test("parseJobRows reads job/list's first frame; anything else is not an answer", () => {
  const frame = {
    type: "item",
    streamId: "1",
    value: { type: "rows", jobs: [{ id: "bash-1", kind: "bash", status: "running" }, { id: "bash-2", kind: "bash", status: "exited" }] },
  };
  assert.deepEqual(parseJobRows(frame), [{ running: true }, { running: false }]);
  assert.deepEqual(parseJobRows({ type: "item", value: { type: "rows", jobs: [] } }), []);
  for (const bad of [{ type: "error", streamId: "1", error: { code: "gateway/input-invalid" } }, { type: "end" }, { type: "item", value: {} }, null]) {
    assert.equal(parseJobRows(bad), null, JSON.stringify(bad));
  }
});
