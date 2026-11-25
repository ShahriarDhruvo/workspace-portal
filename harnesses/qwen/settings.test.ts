import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdminSettings, SettingsObject } from "../models.ts";
import { AgentConfigError, LLM_KEY_ENV } from "../shared.ts";
import { renderQwenSettings } from "./settings.ts";

const SERVICE = "http://172.29.0.1:4001";
const DEFAULTS_FILE = "/data/config/models/system-defaults.json";
/** The smallest admin configuration a workspace can start with: one model. */
const ONE_MODEL: AdminSettings = {
  settings: {},
  systemDefaults: { modelProviders: { openai: [{ id: "qwen3.8-flash-next", name: "Qwen3.8 Flash-Next" }] } },
  systemDefaultsFile: DEFAULTS_FILE,
};

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
    `the settings file ${DEFAULTS_FILE} defines no model: add at least one entry with an "id" under modelProviders.openai`,
  );
  const without = (systemDefaults: SettingsObject): AdminSettings => ({ settings: {}, systemDefaults, systemDefaultsFile: DEFAULTS_FILE });
  for (const systemDefaults of [
    {},
    { modelProviders: {} },
    { modelProviders: { openai: [] } },
    { modelProviders: { openai: [{ name: "No id" }, { id: "  " }, "not a provider"] } },
    { modelProviders: { anthropic: [{ id: "claude" }] } },
  ]) {
    assert.throws(() => renderQwenSettings({ admin: without(systemDefaults), serviceBaseUrl: SERVICE, browser: true }), expected, JSON.stringify(systemDefaults));
  }
  const settingsOnly: AdminSettings = { ...without({}), settings: { modelProviders: { openai: [{ id: "big" }] } } };
  assert.throws(() => renderQwenSettings({ admin: settingsOnly, serviceBaseUrl: SERVICE, browser: true }), expected, "models in settings.json alone are not enough");
});

test("renderQwenSettings keeps the admin's settings but forces the portal's keys", () => {
  const admin: AdminSettings = {
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
  const admin: AdminSettings = {
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
  const admin: AdminSettings = {
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

const REASONING = (efforts: string[], defaultEffort: string) => ({ reasoning: { profile: "openai-effort", efforts, defaultEffort } });
const EFFORT_MODELS: AdminSettings = {
  settings: {},
  systemDefaults: {
    model: { name: "big" },
    modelProviders: {
      openai: [
        { id: "small", capabilities: REASONING(["medium", "xhigh"], "xhigh") },
        { id: "big", capabilities: REASONING(["low", "medium", "xhigh"], "xhigh") },
        { id: "plain" },
      ],
    },
  },
  systemDefaultsFile: DEFAULTS_FILE,
};

const EFFORT_ALL: AdminSettings = {
  ...EFFORT_MODELS,
  systemDefaults: {
    ...EFFORT_MODELS.systemDefaults,
    modelProviders: { openai: [{ id: "big", capabilities: REASONING(["low", "medium", "xhigh"], "xhigh") }, { id: "plain" }] },
  },
};

test("defaultEffort: every new session starts there (system scope) when every model offers it", () => {
  const rendered = renderQwenSettings({ admin: EFFORT_ALL, serviceBaseUrl: SERVICE, browser: false, defaultEffort: "low" });
  // System scope beats the user's own saved pick, so a pick lasts for one session only.
  assert.equal((rendered.settings.model as SettingsObject).reasoningEffort, "low");
  assert.equal((rendered.settings.model as SettingsObject).catalogRefresh, false, "merged with the forced keys");
  const [big, plain] = (rendered.systemDefaults.modelProviders as SettingsObject).openai as SettingsObject[];
  assert.deepEqual((big!.capabilities as SettingsObject).reasoning, { profile: "openai-effort", efforts: ["low", "medium", "xhigh"], defaultEffort: "low" });
  assert.equal(plain!.capabilities, undefined, "a model without efforts is left alone");
});

test("defaultEffort: with a model that lacks it, each model that offers it defaults to it, and nothing is forced", () => {
  const rendered = renderQwenSettings({ admin: EFFORT_MODELS, serviceBaseUrl: SERVICE, browser: false, defaultEffort: "low" });
  // A session-wide "low" would also apply after a switch to "small", which doesn't offer it.
  assert.equal((rendered.settings.model as SettingsObject).reasoningEffort, undefined);
  const byId = Object.fromEntries(
    ((rendered.systemDefaults.modelProviders as SettingsObject).openai as SettingsObject[]).map((entry) => [entry.id, entry]),
  );
  assert.deepEqual((byId.big!.capabilities as SettingsObject).reasoning, { profile: "openai-effort", efforts: ["low", "medium", "xhigh"], defaultEffort: "low" });
  assert.deepEqual((byId.small!.capabilities as SettingsObject).reasoning, { profile: "openai-effort", efforts: ["medium", "xhigh"], defaultEffort: "xhigh" }, "a model without it keeps its own");

  // System scope's model list replaces system-defaults' (as Qwen Code merges them), and decides.
  const listed: AdminSettings = {
    ...EFFORT_MODELS,
    settings: { modelProviders: { openai: [{ id: "big", capabilities: REASONING(["low"], "low") }] } },
  };
  const fromSettings = renderQwenSettings({ admin: listed, serviceBaseUrl: SERVICE, browser: false, defaultEffort: "low" });
  assert.equal((fromSettings.settings.model as SettingsObject).reasoningEffort, "low");
});

test("defaultEffort: unset leaves the admin's settings as they are", () => {
  const untouched = renderQwenSettings({ admin: EFFORT_MODELS, serviceBaseUrl: SERVICE, browser: false, defaultEffort: null });
  assert.equal((untouched.settings.model as SettingsObject).reasoningEffort, undefined);
  const big = ((untouched.systemDefaults.modelProviders as SettingsObject).openai as SettingsObject[]).find((entry) => entry.id === "big")!;
  assert.equal(((big.capabilities as SettingsObject).reasoning as SettingsObject).defaultEffort, "xhigh");
});
