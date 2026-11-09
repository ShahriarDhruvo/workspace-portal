import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ModelConfig } from "./config.ts";
import {
  agentActivity,
  fetchQwenHealth,
  generateServerToken,
  LLM_KEY_ENV,
  loadAdminQwenConfig,
  mergeSettings,
  parseQwenHealth,
  parseSettingsText,
  QwenConfigError,
  readSettingsFile,
  renderQwenSettings,
  stripJsonComments,
  type AdminQwenConfig,
  type QwenHealth,
  type SettingsObject,
} from "./qwen.ts";

const MIN = 60_000;
const SERVICE = "http://172.29.0.1:4001";
const MODEL: ModelConfig = {
  id: "qwen3.8-flash-next",
  name: "Qwen3.8 Flash-Next",
  contextWindow: 262144,
  maxTokens: 32768,
  input: ["text", "image"],
  reasoning: true,
};
const NO_ADMIN: AdminQwenConfig = { settings: {}, systemDefaults: {} };

/** A real `GET /health?deep=1` answer of `qwen serve`. */
const REAL_HEALTH = {
  status: "ok",
  workspaceCount: 1,
  sessions: 2,
  pendingPermissions: 1,
  activePrompts: 1,
  activeWork: true,
  activeWorkReporting: true,
  activeWorkStaleMs: 0,
  connectedClients: 3,
  channelAlive: true,
  lastActivityAt: 1_760_000_000_000,
  idleSinceMs: 4_200,
};

const quiet: QwenHealth = { activePrompts: 0, pendingPermissions: 0, activeWork: false, connectedClients: 0, channelAlive: true, idleSinceMs: null };

// ------------------------------------------------------------------ health

test("parseQwenHealth reads the deep health answer", () => {
  assert.deepEqual(parseQwenHealth(REAL_HEALTH), {
    activePrompts: 1,
    pendingPermissions: 1,
    activeWork: true,
    connectedClients: 3,
    channelAlive: true,
    idleSinceMs: 4_200,
  });
  assert.deepEqual(parseQwenHealth({ status: "ok" }), { ...quiet, channelAlive: false }, "missing fields are zero/false/null");
});

test("parseQwenHealth refuses odd answers and clamps odd figures", () => {
  for (const bad of [null, undefined, "ok", 1, [], { status: "error" }, { ...REAL_HEALTH, status: "degraded" }]) {
    assert.equal(parseQwenHealth(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(
    parseQwenHealth({
      status: "ok",
      activePrompts: -2,
      pendingPermissions: Number.NaN,
      activeWork: "yes",
      connectedClients: "3",
      channelAlive: 1,
      idleSinceMs: -5,
    }),
    { activePrompts: 0, pendingPermissions: 0, activeWork: false, connectedClients: 0, channelAlive: false, idleSinceMs: null },
  );
  assert.equal(parseQwenHealth({ status: "ok", idleSinceMs: 0 })?.idleSinceMs, 0);
  assert.equal(parseQwenHealth({ status: "ok", idleSinceMs: Number.POSITIVE_INFINITY })?.idleSinceMs, null);
});

test("agentActivity: prompts, approvals and reported work are work", () => {
  const after = 30 * MIN;
  assert.deepEqual(agentActivity(quiet, after), { working: false, abandoned: false });
  assert.deepEqual(agentActivity({ ...quiet, activePrompts: 1 }, after), { working: true, abandoned: false });
  assert.deepEqual(agentActivity({ ...quiet, activeWork: true, idleSinceMs: 2 * after }, after), { working: true, abandoned: false }, "a background task is not abandoned");
  assert.deepEqual(agentActivity({ ...quiet, pendingPermissions: 1, activePrompts: 1, connectedClients: 1, idleSinceMs: 2 * after }, after), {
    working: true,
    abandoned: false,
  }, "someone has the workspace open and can answer");
});

test("agentActivity: an approval nobody is there to give is abandoned once it has waited long enough", () => {
  const after = 30 * MIN;
  const waiting: QwenHealth = { ...quiet, activePrompts: 1, pendingPermissions: 1, activeWork: true, idleSinceMs: after };
  assert.deepEqual(agentActivity(waiting, after), { working: true, abandoned: true }, "exactly the limit counts");
  assert.deepEqual(agentActivity({ ...waiting, idleSinceMs: after - 1 }, after), { working: true, abandoned: false }, "not long enough");
  assert.deepEqual(agentActivity({ ...waiting, idleSinceMs: null }, after), { working: true, abandoned: false }, "unknown age");
  assert.deepEqual(agentActivity({ ...waiting, connectedClients: 1 }, after), { working: true, abandoned: false });
  assert.deepEqual(agentActivity({ ...waiting, activePrompts: 2 }, after), { working: true, abandoned: false }, "another prompt is still running");
  assert.deepEqual(agentActivity({ ...waiting, activePrompts: 0, activeWork: false }, after), { working: true, abandoned: true });
});

test("fetchQwenHealth sends the token to /health?deep=1 and gives up on odd answers", async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  let reply: (res: http.ServerResponse) => void = (res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(REAL_HEALTH));
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/health?deep=1");
    seen.push(req.headers);
    reply(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    assert.deepEqual(await fetchQwenHealth("127.0.0.1", port, "container-token"), parseQwenHealth(REAL_HEALTH));
    assert.equal(seen[0]!.authorization, "Bearer container-token");
    assert.equal(seen[0]!.accept, "application/json");

    reply = (res) => res.writeHead(401, { "content-type": "application/json" }).end('{"error":"Unauthorized"}');
    assert.equal(await fetchQwenHealth("127.0.0.1", port, "t"), null, "401");
    reply = (res) => res.writeHead(500).end(JSON.stringify(REAL_HEALTH));
    assert.equal(await fetchQwenHealth("127.0.0.1", port, "t"), null, "a 500 with a healthy-looking body");
    reply = (res) => res.writeHead(200).end("<html>");
    assert.equal(await fetchQwenHealth("127.0.0.1", port, "t"), null, "not JSON");
    reply = (res) => res.writeHead(200).end(JSON.stringify({ ...REAL_HEALTH, padding: "x".repeat(100 * 1024) }));
    assert.equal(await fetchQwenHealth("127.0.0.1", port, "t"), null, "too large");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await fetchQwenHealth("127.0.0.1", port, "t"), null, "connection refused");
});

test("generateServerToken is a fresh 256-bit base64url token", () => {
  const a = generateServerToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, generateServerToken());
});

// ------------------------------------------------------------------ settings files

test("stripJsonComments removes comments outside strings only", () => {
  assert.equal(stripJsonComments('{"a": 1} // trailing'), '{"a": 1} \n');
  assert.equal(stripJsonComments('{\n  // line\n  "a": /* inline */ 1\n}'), '{\n  \n  "a":   1\n}');
  assert.equal(stripJsonComments('{"url": "http://x/*y*/", "b": "//"}'), '{"url": "http://x/*y*/", "b": "//"}');
  assert.equal(stripJsonComments('{"q": "a\\"//b", "c": "\\\\"}// x'), '{"q": "a\\"//b", "c": "\\\\"}\n');
  assert.equal(stripJsonComments('{"a": 1 /* never closed'), '{"a": 1  ');
  assert.equal(stripJsonComments("/**/{}/***/"), " {} ");
  // A comment separates tokens, as in Qwen Code's own parser: 1/**/2 is not 12.
  assert.equal(stripJsonComments("1/**/2"), "1 2");
  assert.throws(() => JSON.parse(stripJsonComments('{"a": 1/**/2}')));
});

test("parseSettingsText accepts JSON with comments and reports anything else clearly", () => {
  assert.deepEqual(parseSettingsText('// admin settings\n{ "ui": { /* dark */ "theme": "Dracula" } }\n', "settings.json"), { ui: { theme: "Dracula" } });
  assert.deepEqual(parseSettingsText("", "x"), {});
  assert.deepEqual(parseSettingsText("  \n\t", "x"), {});

  const broken = (text: string): QwenConfigError => {
    try {
      parseSettingsText(text, "/data/config/qwen/settings.json");
    } catch (error) {
      assert.ok(error instanceof QwenConfigError, String(error));
      return error;
    }
    assert.fail(`expected ${JSON.stringify(text)} to be refused`);
  };
  assert.match(broken('{ "ui": ').message, /^the Qwen Code settings file \/data\/config\/qwen\/settings\.json is not valid JSON: /);
  assert.match(broken('{ "a": 1, }').message, /is not valid JSON/, "no trailing commas");
  for (const notObject of ["[]", "[1]", "null", "42", '"text"', "true"]) {
    assert.equal(broken(notObject).message, "the Qwen Code settings file /data/config/qwen/settings.json must contain a JSON object", notObject);
  }
  assert.equal(broken("{").name, "QwenConfigError");
});

test("loadAdminQwenConfig: missing files are empty, unreadable or invalid ones throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-admin-"));
  try {
    assert.deepEqual(loadAdminQwenConfig(path.join(dir, "missing")), NO_ADMIN);
    fs.writeFileSync(path.join(dir, "settings.json"), '{ "ui": { "theme": "Dracula" } } // ok');
    assert.deepEqual(loadAdminQwenConfig(dir), { settings: { ui: { theme: "Dracula" } }, systemDefaults: {} });
    fs.writeFileSync(path.join(dir, "system-defaults.json"), "{ nope");
    assert.throws(() => loadAdminQwenConfig(dir), (error: unknown) => {
      assert.ok(error instanceof QwenConfigError);
      assert.match(error.message, new RegExp(`^the Qwen Code settings file ${path.join(dir, "system-defaults.json").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is not valid JSON`));
      return true;
    });
    fs.mkdirSync(path.join(dir, "dir.json"));
    assert.throws(() => readSettingsFile(path.join(dir, "dir.json")), /^QwenConfigError: cannot read the Qwen Code settings file .*dir\.json: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ rendering

test("renderQwenSettings without admin files: the portal's keys and the default model", () => {
  const { settings, systemDefaults } = renderQwenSettings({ admin: NO_ADMIN, serviceBaseUrl: SERVICE, model: MODEL, browser: true });
  assert.deepEqual(settings, {
    $version: 4,
    general: { enableAutoUpdate: false, preventSystemSleep: false },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false, logPrompts: false },
    model: { catalogRefresh: false },
    security: { auth: { enforcedType: "openai", selectedType: "openai" } },
    permissions: { deny: ["web_fetch"] },
    tools: {},
    mcpServers: {
      search: {
        httpUrl: `${SERVICE}/mcp/search`,
        timeout: 60_000,
        trust: true,
        includeTools: ["web_search"],
        alwaysLoadTools: true,
        description: "Private web search. The workspace has no direct internet access, so use this for anything on the web.",
      },
      browser: {
        command: "/usr/local/bin/playwright-mcp",
        args: ["--headless", "--isolated", "--no-sandbox", "--executable-path=/usr/bin/chromium", "--output-dir=/workspace/.browser"],
        timeout: 120_000,
        trust: true,
        description: "Headless Chromium for pages served inside this workspace (for example a dev server). It has no internet access.",
      },
    },
  });
  assert.deepEqual(systemDefaults, {
    $version: 4,
    security: { auth: { selectedType: "openai" } },
    model: { name: MODEL.id },
    modelProviders: {
      openai: [
        {
          id: MODEL.id,
          name: MODEL.name,
          description: "Through the Workspace Portal gateway",
          envKey: LLM_KEY_ENV,
          baseUrl: `${SERVICE}/llm/v1`,
          generationConfig: {
            timeout: 3_600_000,
            streamIdleTimeoutMs: 3_600_000,
            streamMaxLifetimeMs: 3_600_000,
            maxRetries: 1,
            contextWindowSize: 262144,
            modalities: { image: true },
            samplingParams: { max_tokens: 32768 },
          },
          capabilities: { reasoning: { profile: "openai-effort", efforts: ["low", "medium", "xhigh"], defaultEffort: "medium" } },
        },
      ],
    },
  });

  const plain = renderQwenSettings({ admin: NO_ADMIN, serviceBaseUrl: SERVICE, model: { ...MODEL, input: ["text"], reasoning: false }, browser: false });
  const provider = (plain.systemDefaults.modelProviders as { openai: SettingsObject[] }).openai[0]!;
  assert.equal(provider.capabilities, undefined, "no reasoning profile for a non-thinking model");
  assert.deepEqual((provider.generationConfig as SettingsObject).modalities, { image: false });
  assert.deepEqual(Object.keys(plain.settings.mcpServers as SettingsObject), ["search"], "no browser tool when it is off");
});

test("renderQwenSettings keeps the admin's settings but forces the portal's keys", () => {
  const admin: AdminQwenConfig = {
    settings: {
      $version: 3,
      ui: { theme: "Dracula", hideTips: true },
      general: { enableAutoUpdate: true, vimMode: true },
      privacy: { usageStatisticsEnabled: true },
      telemetry: { enabled: true, logPrompts: true, target: "local" },
      model: { catalogRefresh: true, maxSessionTurns: 50 },
      security: { auth: { enforcedType: "qwen-oauth", selectedType: "gemini" }, folderTrust: { enabled: false } },
      permissions: { allow: ["run_shell_command(npm test)"], deny: ["run_shell_command(rm -rf /)", 42, "web_fetch"] },
      tools: { webSearch: { provider: [{ type: "tavily", apiKey: "tvly-secret" }] }, sandbox: false },
      mcpServers: {
        search: { httpUrl: "https://search.example/mcp" },
        browser: { command: "/usr/bin/evil" },
        notes: { command: "/usr/local/bin/notes-mcp" },
      },
    },
    systemDefaults: {},
  };
  const before = structuredClone(admin);
  const { settings } = renderQwenSettings({ admin, serviceBaseUrl: SERVICE, model: MODEL, browser: false });
  assert.deepEqual(admin, before, "the admin's objects are not modified");

  assert.equal(settings.$version, 3, "the admin's settings version is kept");
  assert.deepEqual(settings.ui, { theme: "Dracula", hideTips: true });
  assert.deepEqual(settings.general, { enableAutoUpdate: false, vimMode: true, preventSystemSleep: false });
  assert.deepEqual(settings.privacy, { usageStatisticsEnabled: false });
  assert.deepEqual(settings.telemetry, { enabled: false, logPrompts: false, target: "local" });
  assert.deepEqual(settings.model, { catalogRefresh: false, maxSessionTurns: 50 });
  assert.deepEqual(settings.security, { auth: { enforcedType: "openai", selectedType: "openai" }, folderTrust: { enabled: false } });
  assert.deepEqual(settings.permissions, {
    allow: ["run_shell_command(npm test)"],
    deny: ["run_shell_command(rm -rf /)", "web_fetch"],
  });
  assert.deepEqual(settings.tools, { sandbox: false }, "built-in web search providers need the internet");
  const servers = settings.mcpServers as Record<string, SettingsObject>;
  assert.deepEqual(Object.keys(servers).sort(), ["notes", "search"], "an admin browser entry is dropped when the browser is off");
  assert.equal(servers.search!.httpUrl, `${SERVICE}/mcp/search`);
  assert.deepEqual(servers.notes, { command: "/usr/local/bin/notes-mcp" });

  const withBrowser = renderQwenSettings({ admin, serviceBaseUrl: SERVICE, model: MODEL, browser: true });
  assert.equal((withBrowser.settings.mcpServers as Record<string, SettingsObject>).browser!.command, "/usr/local/bin/playwright-mcp");
  assert.deepEqual(renderQwenSettings({ admin, serviceBaseUrl: SERVICE, model: MODEL, browser: false }).settings, settings, "rendering is repeatable");
});

test("renderQwenSettings keeps the admin's OpenAI models but only through the gateway, without keys", () => {
  const admin: AdminQwenConfig = {
    settings: {},
    systemDefaults: {
      model: { name: "big" },
      security: { auth: { selectedType: "gemini" } },
      ui: { theme: "GitHub" },
      modelProviders: {
        openai: [
          { id: "big", name: "Big", baseUrl: "https://api.example.com/v1", envKey: "OPENAI_API_KEY", apiKey: "sk-secret", generationConfig: { timeout: 5 } },
          "not a provider",
          { id: "small", name: "Small" },
        ],
        anthropic: [{ id: "claude", baseUrl: "https://api.anthropic.com" }],
      },
    },
  };
  const { systemDefaults } = renderQwenSettings({ admin, serviceBaseUrl: SERVICE, model: MODEL, browser: true });
  assert.deepEqual(systemDefaults.model, { name: "big" }, "users may pick another default; the admin's choice wins over the portal's");
  assert.deepEqual(systemDefaults.ui, { theme: "GitHub" });
  assert.deepEqual(systemDefaults.security, { auth: { selectedType: "openai" } });
  assert.deepEqual(systemDefaults.modelProviders, {
    openai: [
      { id: "big", name: "Big", baseUrl: `${SERVICE}/llm/v1`, envKey: LLM_KEY_ENV, generationConfig: { timeout: 5 } },
      { id: "small", name: "Small", baseUrl: `${SERVICE}/llm/v1`, envKey: LLM_KEY_ENV },
    ],
  });
  assert.equal(JSON.stringify(systemDefaults).includes("sk-secret"), false, "no API key reaches a workspace");

  const empty = renderQwenSettings({
    admin: { settings: {}, systemDefaults: { modelProviders: { openai: [] } } },
    serviceBaseUrl: SERVICE,
    model: MODEL,
    browser: true,
  });
  assert.deepEqual(
    (empty.systemDefaults.modelProviders as { openai: SettingsObject[] }).openai.map((p) => p.id),
    [MODEL.id],
    "no admin models: the configured default model",
  );
});

test("mergeSettings merges objects deeply, replaces everything else, and ignores prototype keys", () => {
  assert.deepEqual(
    mergeSettings({ a: { b: 1, c: [1, 2] }, d: "x", e: { f: 1 } }, { a: { c: [3], g: true }, d: { now: "object" }, e: null }),
    { a: { b: 1, c: [3], g: true }, d: { now: "object" }, e: null },
  );
  const shared = { list: [1] };
  const merged = mergeSettings({}, { shared });
  shared.list.push(2);
  assert.deepEqual(merged, { shared: { list: [1] } }, "values are copied, not shared");

  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "a": {"__proto__": {"polluted": true}, "b": 1}, "constructor": {"prototype": {"polluted": true}}, "ok": 1}') as SettingsObject;
  const out = mergeSettings({ a: { c: 2 } }, hostile);
  assert.deepEqual(out, { a: { c: 2, b: 1 }, ok: 1 });
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.hasOwn(out, "__proto__"), false);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined, "Object.prototype is untouched");
  assert.equal((out.a as { polluted?: boolean }).polluted, undefined);
});
