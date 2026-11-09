import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentConfigError, LLM_KEY_ENV } from "./driver.ts";
import {
  loadAdminQwenConfig,
  mergeSettings,
  parseSettingsText,
  readSettingsFile,
  renderQwenSettings,
  stripJsonComments,
  type AdminQwenConfig,
  type SettingsObject,
} from "./qwen-settings.ts";

const SERVICE = "http://172.29.0.1:4001";
const DEFAULTS_FILE = "/data/config/qwen/system-defaults.json";
/** The smallest admin configuration a workspace can start with: one model. */
const ONE_MODEL: AdminQwenConfig = {
  settings: {},
  systemDefaults: { modelProviders: { openai: [{ id: "qwen3.8-flash-next", name: "Qwen3.8 Flash-Next" }] } },
  systemDefaultsFile: DEFAULTS_FILE,
};

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

  const broken = (text: string): AgentConfigError => {
    try {
      parseSettingsText(text, "/data/config/qwen/settings.json");
    } catch (error) {
      assert.ok(error instanceof AgentConfigError, String(error));
      return error;
    }
    assert.fail(`expected ${JSON.stringify(text)} to be refused`);
  };
  assert.match(broken('{ "ui": ').message, /^the Qwen Code settings file \/data\/config\/qwen\/settings\.json is not valid JSON: /);
  assert.match(broken('{ "a": 1, }').message, /is not valid JSON/, "no trailing commas");
  for (const notObject of ["[]", "[1]", "null", "42", '"text"', "true"]) {
    assert.equal(broken(notObject).message, "the Qwen Code settings file /data/config/qwen/settings.json must contain a JSON object", notObject);
  }
  assert.equal(broken("{").name, "AgentConfigError");
});

test("loadAdminQwenConfig: missing files are empty, unreadable or invalid ones throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-admin-"));
  try {
    const missing = path.join(dir, "missing");
    assert.deepEqual(loadAdminQwenConfig(missing), { settings: {}, systemDefaults: {}, systemDefaultsFile: path.join(missing, "system-defaults.json") });
    fs.writeFileSync(path.join(dir, "settings.json"), '{ "ui": { "theme": "Dracula" } } // ok');
    assert.deepEqual(loadAdminQwenConfig(dir), {
      settings: { ui: { theme: "Dracula" } },
      systemDefaults: {},
      systemDefaultsFile: path.join(dir, "system-defaults.json"),
    });
    fs.writeFileSync(path.join(dir, "system-defaults.json"), "{ nope");
    assert.throws(() => loadAdminQwenConfig(dir), (error: unknown) => {
      assert.ok(error instanceof AgentConfigError);
      assert.match(error.message, new RegExp(`^the Qwen Code settings file ${path.join(dir, "system-defaults.json").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is not valid JSON`));
      return true;
    });
    fs.mkdirSync(path.join(dir, "dir.json"));
    assert.throws(() => readSettingsFile(path.join(dir, "dir.json")), /^AgentConfigError: cannot read the Qwen Code settings file .*dir\.json: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ rendering

test("renderQwenSettings with one model and no other settings: the portal's keys", () => {
  const { settings, systemDefaults } = renderQwenSettings({ admin: ONE_MODEL, serviceBaseUrl: SERVICE, browser: true });
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
    model: { name: "qwen3.8-flash-next" },
    modelProviders: {
      openai: [{ id: "qwen3.8-flash-next", name: "Qwen3.8 Flash-Next", baseUrl: `${SERVICE}/llm/v1`, envKey: LLM_KEY_ENV }],
    },
  }, "the default model is the first one");

  const plain = renderQwenSettings({ admin: ONE_MODEL, serviceBaseUrl: SERVICE, browser: false });
  assert.deepEqual(Object.keys(plain.settings.mcpServers as SettingsObject), ["search"], "no browser tool when it is off");
});

test("renderQwenSettings refuses a system-defaults.json without a model, naming the file", () => {
  const expected = new AgentConfigError(
    `the Qwen Code settings file ${DEFAULTS_FILE} defines no model: add at least one entry with an "id" under modelProviders.openai`,
  );
  const without = (systemDefaults: SettingsObject): AdminQwenConfig => ({ settings: {}, systemDefaults, systemDefaultsFile: DEFAULTS_FILE });
  for (const systemDefaults of [
    {},
    { modelProviders: {} },
    { modelProviders: { openai: [] } },
    { modelProviders: { openai: [{ name: "No id" }, { id: "  " }, "not a provider"] } },
    { modelProviders: { anthropic: [{ id: "claude" }] } },
  ]) {
    assert.throws(() => renderQwenSettings({ admin: without(systemDefaults), serviceBaseUrl: SERVICE, browser: true }), expected, JSON.stringify(systemDefaults));
  }
  const settingsOnly: AdminQwenConfig = { ...without({}), settings: { modelProviders: { openai: [{ id: "big" }] } } };
  assert.throws(() => renderQwenSettings({ admin: settingsOnly, serviceBaseUrl: SERVICE, browser: true }), expected, "models in settings.json alone are not enough");
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
    systemDefaults: ONE_MODEL.systemDefaults,
    systemDefaultsFile: DEFAULTS_FILE,
  };
  const before = structuredClone(admin);
  const { settings } = renderQwenSettings({ admin, serviceBaseUrl: SERVICE, browser: false });
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

  const withBrowser = renderQwenSettings({ admin, serviceBaseUrl: SERVICE, browser: true });
  assert.equal((withBrowser.settings.mcpServers as Record<string, SettingsObject>).browser!.command, "/usr/local/bin/playwright-mcp");
  assert.deepEqual(renderQwenSettings({ admin, serviceBaseUrl: SERVICE, browser: false }).settings, settings, "rendering is repeatable");
});

test("renderQwenSettings keeps the admin's OpenAI models but only through the gateway, without keys", () => {
  const admin: AdminQwenConfig = {
    settings: {},
    systemDefaults: {
      model: { name: "small" },
      security: { auth: { selectedType: "gemini" } },
      ui: { theme: "GitHub" },
      modelProviders: {
        openai: [
          {
            id: "big",
            name: "Big",
            baseUrl: "https://api.example.com/v1",
            envKey: "OPENAI_API_KEY",
            apiKey: "sk-secret",
            generationConfig: { timeout: 5, extra_headers: { apiKey: "sk-nested" } },
            fallbacks: [{ apiKey: "sk-in-a-list", id: "spare" }],
          },
          "not a provider",
          { id: "small", name: "Small" },
        ],
        anthropic: [{ id: "claude", baseUrl: "https://api.anthropic.com" }],
      },
    },
    systemDefaultsFile: DEFAULTS_FILE,
  };
  const before = structuredClone(admin);
  const { systemDefaults } = renderQwenSettings({ admin, serviceBaseUrl: SERVICE, browser: true });
  assert.deepEqual(admin, before, "the admin's objects are not modified");
  assert.deepEqual(systemDefaults.model, { name: "small" }, "the admin's default model is kept");
  assert.deepEqual(systemDefaults.ui, { theme: "GitHub" });
  assert.deepEqual(systemDefaults.security, { auth: { selectedType: "openai" } });
  assert.deepEqual(systemDefaults.modelProviders, {
    openai: [
      { id: "big", name: "Big", baseUrl: `${SERVICE}/llm/v1`, envKey: LLM_KEY_ENV, generationConfig: { timeout: 5, extra_headers: {} }, fallbacks: [{ id: "spare" }] },
      { id: "small", name: "Small", baseUrl: `${SERVICE}/llm/v1`, envKey: LLM_KEY_ENV },
    ],
  });
  assert.equal(JSON.stringify(systemDefaults).includes("sk-"), false, "no API key reaches a workspace");

  const unnamed = renderQwenSettings({
    admin: { ...admin, systemDefaults: { ...admin.systemDefaults, model: { name: " ", maxSessionTurns: 9 } } },
    serviceBaseUrl: SERVICE,
    browser: true,
  });
  assert.deepEqual(unnamed.systemDefaults.model, { name: "big", maxSessionTurns: 9 }, "no default model named: the first one");
});

test("renderQwenSettings applies the same provider rules to models listed in settings.json", () => {
  const admin: AdminQwenConfig = {
    ...ONE_MODEL,
    settings: {
      ui: { theme: "Dracula" },
      modelProviders: {
        openai: [{ id: "extra", baseUrl: "https://api.example.com/v1", envKey: "OPENAI_API_KEY", apiKey: "sk-secret", auth: { apiKey: "sk-nested" } }, 7],
        gemini: [{ id: "gemini-pro", apiKey: "sk-gemini" }],
      },
    },
  };
  const { settings } = renderQwenSettings({ admin, serviceBaseUrl: SERVICE, browser: true });
  assert.deepEqual(settings.modelProviders, { openai: [{ id: "extra", auth: {}, baseUrl: `${SERVICE}/llm/v1`, envKey: LLM_KEY_ENV }] });
  assert.equal(JSON.stringify(settings).includes("sk-"), false, "no API key reaches a workspace");

  for (const modelProviders of [{ gemini: [{ id: "gemini-pro", apiKey: "sk-gemini" }] }, { openai: [] }, "nonsense"]) {
    const rendered = renderQwenSettings({ admin: { ...ONE_MODEL, settings: { modelProviders } }, serviceBaseUrl: SERVICE, browser: true });
    assert.equal("modelProviders" in rendered.settings, false, `nothing left of ${JSON.stringify(modelProviders)}: the key goes`);
  }
  assert.equal("modelProviders" in renderQwenSettings({ admin: ONE_MODEL, serviceBaseUrl: SERVICE, browser: true }).settings, false, "none listed: none added");
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
