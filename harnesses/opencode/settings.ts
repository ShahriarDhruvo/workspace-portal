// OpenCode's settings in a workspace: opencode.json, rendered before every start and mounted read-only at /etc/opencode,
// OpenCode's directory for managed settings, with the agent's instructions beside it (../instructions.ts). What that file names wins over a person's own settings
// (~/.config/opencode) and over any project's opencode.json; everything it leaves out stays theirs (agents, commands,
// their own MCP servers, permissions for other tools). So it holds only what the portal depends on: the portal's
// models (../models.ts) through the gateway and no other provider, the gateway's search in place of OpenCode's own web
// tools, and no update or session sharing, which a workspace could not reach or must not use. The keys are OpenCode
// 2's (`providers`, `policies`, `permissions`, `mcp.servers`).
//
// OpenCode replaces `{env:NAME}` and `{file:path}` in the file's text before it parses it. Nothing here uses them; a
// model name or id of the admin's that held such a marker would be replaced, so a start with one is refused. So is
// one with a model id that has a `#`, where OpenCode's name for a model ("<provider>/<id>#<variant>") ends the id.
import { INSTRUCTIONS_FILE } from "../instructions.ts";
import type { ModelCatalog, PortalModel } from "../models.ts";
import { AgentConfigError, BROWSER_MCP, BROWSER_TIMEOUT_MS, LLM_KEY_ENV, LLM_TIMEOUT_MS, SEARCH_TIMEOUT_MS } from "../shared.ts";

export const OPENCODE_SETTINGS_DIR = "/etc/opencode";
export const OPENCODE_CONFIG_FILE = "opencode.json";

/** The provider's id: models are `portal/<id>` in OpenCode's settings and URLs. */
const PROVIDER = "portal";

interface OpencodeConfigOptions {
  catalog: ModelCatalog;
  /** http://<gateway bridge IP>:<service port>, the only address a Private workspace can reach. */
  serviceBaseUrl: string;
  /** Offer the Playwright MCP browser. */
  browser: boolean;
}

/** The managed opencode.json of a workspace, as an object. Throws AgentConfigError for a model OpenCode would misread. */
export function opencodeConfig(options: OpencodeConfigOptions): Record<string, unknown> {
  const { catalog, serviceBaseUrl, browser } = options;
  for (const model of catalog.models) {
    const marker = [model.id, model.name].find((text) => /\{(?:env|file):/.test(text));
    if (marker !== undefined) {
      throw new AgentConfigError(`OpenCode would replace "${marker}" in its settings: a model's id and name must not contain {env: or {file:.`);
    }
    if (model.id.includes("#")) {
      throw new AgentConfigError(`OpenCode reads the "#" in "${model.id}" as the start of a variant's name: a model's id must not contain one.`);
    }
  }
  // codemode false: the model calls these tools itself (search_web_search, search_read_page), as with the other
  // agents, not through a script it would have to write for OpenCode's `execute` tool.
  const servers: Record<string, unknown> = {
    search: { type: "remote", url: `${serviceBaseUrl}/mcp/search`, oauth: false, codemode: false, timeout: { execution: SEARCH_TIMEOUT_MS } },
  };
  if (browser) {
    servers.browser = { type: "local", command: [BROWSER_MCP.command, ...BROWSER_MCP.args], codemode: false, timeout: { execution: BROWSER_TIMEOUT_MS } };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    update: "disable",
    share: "disabled",
    model: `${PROVIDER}/${catalog.defaultModel}`,
    // Added to every session's prompt, after the AGENTS.md files of the person and the project.
    instructions: [`${OPENCODE_SETTINGS_DIR}/${INSTRUCTIONS_FILE}`],
    providers: {
      [PROVIDER]: {
        name: "Workspace Portal",
        // Part of OpenCode itself: nothing is fetched for it.
        package: "@opencode/ai/providers/openai-compatible",
        // A placeholder in the container; the gateway's LLM proxy sends the real key upstream.
        env: [LLM_KEY_ENV],
        compatibility: { maxTokensField: "max_tokens" },
        settings: {
          baseURL: `${serviceBaseUrl}/llm/v1`,
          // A request may wait in the gateway's queue for longer than OpenCode's own limits (LLM_TIMEOUT_MS).
          timeout: false,
          headerTimeout: LLM_TIMEOUT_MS,
          chunkTimeout: LLM_TIMEOUT_MS,
        },
        models: Object.fromEntries(catalog.models.map((model) => [model.id, opencodeModel(model)])),
      },
    },
    // No provider but this one, whatever a person or a project configures or signs in to: OpenCode would otherwise
    // offer its own hosted models (it lists them even without a route to them). The later rule wins.
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: PROVIDER, effect: "allow" },
      { action: "websearch.use", resource: "*", effect: "deny" },
    ],
    // The built-in web tools fetch from the workspace itself; the web goes through the gateway's search. Web search
    // is off twice, here and as a policy above: either keeps the tool from the model. Denying webfetch also stops
    // the `fetch` of OpenCode's `execute` tool.
    websearch: false,
    permissions: [{ action: "webfetch", resource: "*", effect: "deny" }],
    mcp: { servers },
  };
}

export function renderOpencodeConfig(options: OpencodeConfigOptions): string {
  return `${JSON.stringify(opencodeConfig(options), null, 2)}\n`;
}

/**
 * A model as OpenCode's settings describe one. Its efforts become the variants a person picks from, and its default
 * effort goes with every request no variant overrides, so "Default" in OpenCode's picker is the portal's default.
 */
function opencodeModel(model: PortalModel): Record<string, unknown> {
  return {
    name: model.name,
    capabilities: {
      tools: true,
      input: model.image ? ["text", "image"] : ["text"],
      output: ["text"],
      reasoning: model.efforts.length > 0 ? { supported: true, effort: model.efforts } : { supported: false },
    },
    limit: { context: model.contextWindow, output: model.maxTokens },
    ...(model.defaultEffort === null ? {} : { settings: { reasoningEffort: model.defaultEffort } }),
  };
}
