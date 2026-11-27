// The portal's models, the same for every harness. The admin defines them once, in the format of Qwen Code's settings
// (PORTAL_DATA_DIR/config/models): system-defaults.json lists them under modelProviders.openai, and settings.json,
// Qwen Code's system settings, may list them again and then wins, as Qwen Code merges the two. Qwen Code gets both
// files, with its own keys added (qwen/settings.ts); every other harness gets the catalog below in its own format.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@portal/core";
import type { HarnessConfig } from "./harness.ts";
import { AgentConfigError } from "./shared.ts";

export type SettingsObject = Record<string, unknown>;

/** The admin's two files, as they are. Missing files are empty objects. */
export interface AdminSettings {
  settings: SettingsObject;
  systemDefaults: SettingsObject;
  /** Where systemDefaults came from, for error messages. */
  systemDefaultsFile: string;
}

/** The two files with their models settled (resolveModels). */
export interface ModelSettings {
  /** System scope: overrides user and project settings. */
  settings: SettingsObject;
  /** Lowest precedence: users may change these in their own settings. */
  systemDefaults: SettingsObject;
}

export function loadAdminSettings(dir: string): AdminSettings {
  const systemDefaultsFile = path.join(dir, "system-defaults.json");
  return { settings: readSettingsFile(path.join(dir, "settings.json")), systemDefaults: readSettingsFile(systemDefaultsFile), systemDefaultsFile };
}

/** Reads a settings file: JSON, optionally with // and /* comments as Qwen Code allows. */
export function readSettingsFile(file: string): SettingsObject {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new AgentConfigError(`cannot read the settings file ${file}: ${(error as Error).message}`);
  }
  return parseSettingsText(text, file);
}

export function parseSettingsText(text: string, label: string): SettingsObject {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new AgentConfigError(`the settings file ${label} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(value)) throw new AgentConfigError(`the settings file ${label} must contain a JSON object`);
  return value;
}

/**
 * Removes // line and /* block comments outside strings (the first alternative steps over a string). A block comment
 * becomes a space: like Qwen Code's own parser, it separates tokens, it doesn't join them.
 */
export function stripJsonComments(text: string): string {
  return text.replace(/"(?:\\[\s\S]|[^"\\])*"?|\/\/[^\n]*\n?|\/\*[\s\S]*?(?:\*\/|$)/g, (match) => (match[0] === '"' ? match : match[1] === "/" ? "\n" : " "));
}

/**
 * The admin's files with their models settled: only OpenAI-compatible ones and no API key at any depth (a workspace
 * reaches a model through the gateway alone, which holds the key), a default model named, and `defaultEffort` (the
 * gateway's DEFAULT_REASONING_EFFORT; null: none) as the default of every model that offers it. The models come from
 * system-defaults.json; without one there is nothing to offer, so that is an AgentConfigError. A list in
 * settings.json without a model is dropped, so it can't hide them.
 */
export function resolveModels(admin: AdminSettings, defaultEffort: string | null): ModelSettings {
  const systemDefaults = mergeSettings({}, admin.systemDefaults);
  const models = listedModels(systemDefaults).map(withoutApiKeys);
  const firstId = models.map((model) => model.id).find((id): id is string => typeof id === "string" && id.trim() !== "");
  if (firstId === undefined) {
    throw new AgentConfigError(`the settings file ${admin.systemDefaultsFile} defines no model: add at least one entry with an "id" under modelProviders.openai`);
  }
  systemDefaults.modelProviders = { openai: models };
  const model = asObject(systemDefaults.model);
  if (typeof model.name !== "string" || model.name.trim() === "") systemDefaults.model = { ...model, name: firstId };

  const settings = mergeSettings({}, admin.settings);
  if (settings.modelProviders !== undefined) {
    const listed = listedModels(settings).map(withoutApiKeys);
    if (listed.length > 0) settings.modelProviders = { openai: listed };
    else delete settings.modelProviders;
  }

  if (defaultEffort !== null) {
    for (const entry of [...listedModels(settings), ...listedModels(systemDefaults)]) {
      const capabilities = asObject(entry.capabilities);
      const reasoning = asObject(capabilities.reasoning);
      if (Array.isArray(reasoning.efforts) && reasoning.efforts.includes(defaultEffort)) entry.capabilities = { ...capabilities, reasoning: { ...reasoning, defaultEffort } };
    }
  }
  return { settings, systemDefaults };
}

/** The models one file lists: the entries themselves, not copies. */
export function listedModels(file: SettingsObject): SettingsObject[] {
  const { openai } = asObject(file.modelProviders);
  return Array.isArray(openai) ? openai.filter(isRecord) : [];
}

/** The models in effect: settings.json's when it lists any, else system-defaults.json's. */
export function effectiveModels({ settings, systemDefaults }: ModelSettings): SettingsObject[] {
  const listed = listedModels(settings);
  return listed.length > 0 ? listed : listedModels(systemDefaults);
}

function withoutApiKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutApiKeys) as T;
  if (!isRecord(value)) return value;
  const out: SettingsObject = {};
  for (const [key, item] of Object.entries(value)) if (key !== "apiKey") out[key] = withoutApiKeys(item);
  return out as T;
}

/** Used when an entry doesn't say (generationConfig.contextWindowSize / samplingParams.max_tokens). */
export const DEFAULT_CONTEXT_WINDOW = 131_072;
/** What Qwen Code asks of a qwen3 model when its entry doesn't say. */
export const DEFAULT_MAX_TOKENS = 64_000;

export interface PortalModel {
  /** What the AI server serves (the request's `model`). */
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /** Accepts images (generationConfig.modalities.image). */
  image: boolean;
  /** Reasoning efforts it takes (capabilities.reasoning.efforts); empty: no reasoning control. */
  efforts: string[];
  /** One of `efforts`, or null. */
  defaultEffort: string | null;
}

export interface ModelCatalog {
  /** At least one; ids are unique. */
  models: PortalModel[];
  /** The id of the model sessions start with. */
  defaultModel: string;
}

const EFFORT = /^[A-Za-z0-9_-]{1,32}$/;

/** The portal's models as the gateway's settings give them; AgentConfigError when the admin's files are unusable. */
export function modelCatalog(config: HarnessConfig): ModelCatalog {
  return portalModels(resolveModels(loadAdminSettings(config.modelsDir), config.workspace.defaultEffort));
}

export function portalModels(resolved: ModelSettings): ModelCatalog {
  const models: PortalModel[] = [];
  for (const entry of effectiveModels(resolved)) {
    const model = toModel(entry);
    if (model && !models.some((known) => known.id === model.id)) models.push(model);
  }
  if (models.length === 0) throw new Error("no model with an id: resolveModels should have refused these settings");
  const named = [asObject(resolved.settings.model).name, asObject(resolved.systemDefaults.model).name];
  const defaultModel = named.find((name): name is string => typeof name === "string" && models.some((model) => model.id === name)) ?? models[0]!.id;
  return { models, defaultModel };
}

function toModel(entry: SettingsObject): PortalModel | null {
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (id === "") return null;
  const name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : id;
  const generation = asObject(entry.generationConfig);
  const contextWindow = positiveInt(generation.contextWindowSize) ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = Math.min(positiveInt(asObject(generation.samplingParams).max_tokens) ?? DEFAULT_MAX_TOKENS, contextWindow);
  const reasoning = asObject(asObject(entry.capabilities).reasoning);
  const efforts = Array.isArray(reasoning.efforts)
    ? [...new Set(reasoning.efforts.filter((effort): effort is string => typeof effort === "string" && EFFORT.test(effort)))]
    : [];
  const defaultEffort = typeof reasoning.defaultEffort === "string" && efforts.includes(reasoning.defaultEffort) ? reasoning.defaultEffort : null;
  return { id, name, contextWindow, maxTokens, image: asObject(generation.modalities).image === true, efforts, defaultEffort };
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Deep merge for settings: objects merge key by key, anything else (arrays included) is replaced. */
export function mergeSettings(base: SettingsObject, override: SettingsObject): SettingsObject {
  const out: SettingsObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? mergeSettings(current, value) : clone(value);
  }
  return out;
}

function clone(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

export function asObject(value: unknown): SettingsObject {
  return isRecord(value) ? { ...value } : {};
}
