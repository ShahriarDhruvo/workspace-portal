// The portal's models, for agents that don't read Qwen Code's settings themselves (DeepSeek Harness).
// The admin defines them once, in Qwen Code's system-defaults.json (modelProviders.openai[]); this
// reads the effective list from the rendered Qwen settings, so every agent offers the same models
// with the same default.
import { asObject, isPlainObject, type RenderedSettings } from "./qwen-settings.ts";

/** Used when an entry doesn't say (generationConfig.contextWindowSize / samplingParams.max_tokens). */
export const DEFAULT_CONTEXT_WINDOW = 131_072;
export const DEFAULT_MAX_TOKENS = 32_768;

export interface PortalModel {
  /** What the LLM server serves (the request's `model`). */
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

/**
 * The models Qwen Code offers with these settings: system-scope settings.json's list replaces
 * system-defaults.json's, as Qwen Code merges them. renderQwenSettings has already refused
 * settings without any model.
 */
export function portalModels(rendered: RenderedSettings): ModelCatalog {
  const fromSettings = providerEntries(rendered.settings);
  const entries = fromSettings.length > 0 ? fromSettings : providerEntries(rendered.systemDefaults);
  const models: PortalModel[] = [];
  for (const entry of entries) {
    const model = toModel(entry);
    if (model && !models.some((known) => known.id === model.id)) models.push(model);
  }
  if (models.length === 0) throw new Error("no model with an id: renderQwenSettings should have refused these settings");
  const named = [asObject(rendered.settings.model).name, asObject(rendered.systemDefaults.model).name];
  const defaultModel = named.find((name): name is string => typeof name === "string" && models.some((model) => model.id === name)) ?? models[0]!.id;
  return { models, defaultModel };
}

function providerEntries(settings: Record<string, unknown>): Record<string, unknown>[] {
  const { openai } = asObject(settings.modelProviders);
  return Array.isArray(openai) ? openai.filter(isPlainObject) : [];
}

function toModel(entry: Record<string, unknown>): PortalModel | null {
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
