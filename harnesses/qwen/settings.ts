// Qwen Code's settings files, rendered per workspace before every start: the admin's settings.json and
// system-defaults.json with their models settled (../models.ts), every model routed through the gateway, and the keys
// the portal depends on forced on top.
import type { WorkspaceKind } from "@portal/core";
import type { HarnessConfig } from "../harness.ts";
import { asObject, effectiveModels, listedModels, loadAdminSettings, mergeSettings, resolveModels, type AdminSettings, type ModelSettings, type SettingsObject } from "../models.ts";
import { BROWSER_MCP, BROWSER_TIMEOUT_MS, LLM_KEY_ENV, SEARCH_TIMEOUT_MS, serviceBaseUrl } from "../shared.ts";

interface RenderOptions {
  admin: AdminSettings;
  /** http://<gateway bridge IP>:<service port>, the only address a workspace can reach. */
  serviceBaseUrl: string;
  /** Offer the Playwright MCP browser. */
  browser: boolean;
  /** The portal has a page reader, so its MCP server also offers read_page. Default: no. */
  reader?: boolean;
  /** The reasoning effort every new session starts with (DEFAULT_REASONING_EFFORT); null keeps the admin's defaultEffort. */
  defaultEffort?: string | null;
}

/** The settings of a workspace of `kind`, from the admin's files and the gateway's configuration. */
export function qwenSettingsFor(config: HarnessConfig, kind: WorkspaceKind): ModelSettings {
  return renderQwenSettings({
    admin: loadAdminSettings(config.modelsDir),
    serviceBaseUrl: serviceBaseUrl(config, kind),
    browser: config.workspace.browser,
    reader: config.reader.url !== "",
    defaultEffort: config.workspace.defaultEffort,
  });
}

/**
 * The two system settings files of a workspace: the admin's files, with the keys the portal depends on (model
 * endpoint, search, no internet features, no telemetry) forced on top.
 */
export function renderQwenSettings(options: RenderOptions): ModelSettings {
  const { admin, serviceBaseUrl, browser, reader = false, defaultEffort = null } = options;
  const resolved = resolveModels(admin, defaultEffort);
  // The gateway is the only route to a model: its URL, and the variable that holds the placeholder key.
  for (const model of [...listedModels(resolved.settings), ...listedModels(resolved.systemDefaults)]) Object.assign(model, { baseUrl: `${serviceBaseUrl}/llm/v1`, envKey: LLM_KEY_ENV });

  const defaults = resolved.systemDefaults;
  defaults.security = mergeSettings(asObject(defaults.security), { auth: { selectedType: "openai" } });
  defaults.$version ??= 4;

  const settings = mergeSettings(resolved.settings, {
    general: { enableAutoUpdate: false, preventSystemSleep: false },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false, logPrompts: false },
    model: { catalogRefresh: false },
    security: { auth: { enforcedType: "openai", selectedType: "openai" } },
  });
  settings.$version ??= 4;
  const permissions = asObject(settings.permissions);
  const deny = Array.isArray(permissions.deny) ? permissions.deny.filter((rule): rule is string => typeof rule === "string") : [];
  settings.permissions = { ...permissions, deny: [...new Set([...deny, "web_fetch"])] };
  const tools = asObject(settings.tools);
  delete tools.webSearch; // built-in web search providers need the internet; search goes through the portal
  settings.tools = tools;

  const servers: SettingsObject = { ...asObject(settings.mcpServers) };
  servers.search = {
    httpUrl: `${serviceBaseUrl}/mcp/search`,
    timeout: SEARCH_TIMEOUT_MS,
    trust: true,
    includeTools: reader ? ["web_search", "read_page"] : ["web_search"],
    alwaysLoadTools: true,
    description: reader
      ? "Private web search and page reader. The workspace has no direct internet access, so use these for anything on the web."
      : "Private web search. The workspace has no direct internet access, so use this for anything on the web.",
  };
  if (browser) {
    servers.browser = {
      ...BROWSER_MCP,
      timeout: BROWSER_TIMEOUT_MS,
      trust: true,
      description: "Headless Chromium for pages served inside this workspace (for example a dev server). It has no internet access.",
    };
  } else {
    delete servers.browser;
  }
  settings.mcpServers = servers;

  const rendered = { settings, systemDefaults: defaults };
  if (defaultEffort !== null) sessionEffort(rendered, defaultEffort);
  return rendered;
}

/**
 * Every new session starts at `effort`, while a person can still pick another one inside a session. The Web Shell
 * saves a pick to the user's own settings (model.reasoningEffort, user scope) and builds each new session from the
 * merged settings, so the effort goes into the system scope, which beats the user's: their pick lasts for that
 * session only. This session-wide key also applies after a switch to another model, so it is set only when every
 * model that lists efforts offers this one; resolveModels has made it the default of each model that does, which the
 * Web Shell shows as the default.
 */
function sessionEffort(rendered: ModelSettings, effort: string): void {
  const listed = effectiveModels(rendered)
    .map((model) => asObject(asObject(model.capabilities).reasoning).efforts)
    .filter((efforts): efforts is unknown[] => Array.isArray(efforts));
  if (listed.length > 0 && listed.every((efforts) => efforts.includes(effort))) {
    rendered.settings.model = { ...asObject(rendered.settings.model), reasoningEffort: effort };
  }
}
