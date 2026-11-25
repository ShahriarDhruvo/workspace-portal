import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  loadAdminSettings,
  mergeSettings,
  parseSettingsText,
  portalModels,
  readSettingsFile,
  resolveModels,
  stripJsonComments,
  type SettingsObject,
} from "./models.ts";
import { AgentConfigError } from "./shared.ts";

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
  // Inside a comment, quotes and the other kind's marker mean nothing; "/*/" does not close itself.
  assert.equal(stripJsonComments('1 // "a /* b\n2 /* // " */3'), "1 \n2  3");
  assert.equal(stripJsonComments("/*/ still open */1"), " 1");
  assert.equal(stripJsonComments("// x\r\n1"), "\n1");
  assert.equal(stripJsonComments('{"a": "never closed // x'), '{"a": "never closed // x');
  assert.equal(stripJsonComments('"a\\'), '"a\\');
});

test("parseSettingsText accepts JSON with comments and reports anything else clearly", () => {
  assert.deepEqual(parseSettingsText('// admin settings\n{ "ui": { /* dark */ "theme": "Dracula" } }\n', "settings.json"), { ui: { theme: "Dracula" } });
  assert.deepEqual(parseSettingsText("", "x"), {});
  assert.deepEqual(parseSettingsText("  \n\t", "x"), {});

  const broken = (text: string): AgentConfigError => {
    try {
      parseSettingsText(text, "/data/config/models/settings.json");
    } catch (error) {
      assert.ok(error instanceof AgentConfigError, String(error));
      return error;
    }
    assert.fail(`expected ${JSON.stringify(text)} to be refused`);
  };
  assert.match(broken('{ "ui": ').message, /^the settings file \/data\/config\/models\/settings\.json is not valid JSON: /);
  assert.match(broken('{ "a": 1, }').message, /is not valid JSON/, "no trailing commas");
  for (const notObject of ["[]", "[1]", "null", "42", '"text"', "true"]) {
    assert.equal(broken(notObject).message, "the settings file /data/config/models/settings.json must contain a JSON object", notObject);
  }
  assert.equal(broken("{").name, "AgentConfigError");
});

test("loadAdminSettings: missing files are empty, unreadable or invalid ones throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-admin-"));
  try {
    const missing = path.join(dir, "missing");
    assert.deepEqual(loadAdminSettings(missing), { settings: {}, systemDefaults: {}, systemDefaultsFile: path.join(missing, "system-defaults.json") });
    fs.writeFileSync(path.join(dir, "settings.json"), '{ "ui": { "theme": "Dracula" } } // ok');
    assert.deepEqual(loadAdminSettings(dir), {
      settings: { ui: { theme: "Dracula" } },
      systemDefaults: {},
      systemDefaultsFile: path.join(dir, "system-defaults.json"),
    });
    fs.writeFileSync(path.join(dir, "system-defaults.json"), "{ nope");
    assert.throws(() => loadAdminSettings(dir), (error: unknown) => {
      assert.ok(error instanceof AgentConfigError);
      assert.match(error.message, new RegExp(`^the settings file ${path.join(dir, "system-defaults.json").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is not valid JSON`));
      return true;
    });
    fs.mkdirSync(path.join(dir, "dir.json"));
    assert.throws(() => readSettingsFile(path.join(dir, "dir.json")), /^AgentConfigError: cannot read the settings file .*dir\.json: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("resolveModels: no API key at any depth, and the default effort on each model that offers it", () => {
  const reasoning = (efforts: string[]) => ({ reasoning: { efforts, defaultEffort: efforts[0] } });
  const admin = {
    settings: { modelProviders: { openai: [] } },
    systemDefaults: {
      modelProviders: {
        openai: [
          { id: "a", apiKey: "secret", generationConfig: { apiKey: "nested" }, capabilities: reasoning(["high", "low"]) },
          { id: "b", capabilities: reasoning(["high"]) },
        ],
        anthropic: [{ id: "c" }],
      },
    },
    systemDefaultsFile: "/data/config/models/system-defaults.json",
  };
  const resolved = resolveModels(admin, "low");
  assert.equal(JSON.stringify(resolved).includes("apiKey"), false);
  assert.deepEqual(resolved.systemDefaults.modelProviders, {
    openai: [
      { id: "a", generationConfig: {}, capabilities: { reasoning: { efforts: ["high", "low"], defaultEffort: "low" } } },
      { id: "b", capabilities: reasoning(["high"]) },
    ],
  });
  assert.deepEqual(resolved.systemDefaults.model, { name: "a" }, "the first model is the default unless one is named");
  assert.equal("modelProviders" in resolved.settings, false, "an empty list in settings.json hides nothing");
  assert.deepEqual(portalModels(resolved).models.map((model) => [model.id, model.defaultEffort]), [["a", "low"], ["b", "high"]]);
  assert.equal(admin.systemDefaults.modelProviders.openai[0]!.apiKey, "secret", "the admin's own object is not changed");
});
