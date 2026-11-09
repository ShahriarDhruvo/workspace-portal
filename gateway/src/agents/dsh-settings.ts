// DeepSeek Harness's per-user settings: portal.patch.yml, rendered before every start and mounted
// read-only at /etc/workspace-portal/dsh. It holds only what the gateway knows: the models (from Qwen
// Code's system-defaults.json, see models.ts), all reached through the gateway, and the gateway's
// search MCP server (plus the headless browser). Everything that locks dsh down (no DeepSeek account,
// no web tools, no plugin installs, no telemetry, one workspace) is static and version-specific, so it
// ships in the image (workspace-image/dsh/lockdown.patch.yml); start-dsh applies both, this one last.
//
// The file is JSON, which YAML 1.2 reads as it is: model names and ids come from the admin's file,
// and as JSON strings they can never become YAML tags (dsh evaluates `!!js` tags as code).
import { AgentConfigError, LLM_KEY_ENV } from "./driver.ts";
import type { ModelCatalog, PortalModel } from "./models.ts";

export const DSH_PATCH_FILE = "portal.patch.yml";

/**
 * dsh's compaction (@deepseek-ai/dsh-compaction-basic, default settings) rejects a model unless
 * floor(0.16 × (W − O)) < W − O − 65536 for its context window W and output cap O, i.e. unless
 * W − O ≥ 78020; a session can't even switch to such a model (MODEL_SWITCH_COMPACTION_FAILED).
 */
export const DSH_MIN_MESSAGE_BUDGET = 78_020;
/** The smallest output cap worth offering when a model's cap has to shrink to fit that rule. */
export const DSH_MIN_OUTPUT_TOKENS = 4096;

/** dsh's own timeouts, as long as Qwen Code's (generationConfig.timeout / streamIdleTimeoutMs). */
const LLM_TIMEOUT_MS = 3_600_000;
const SEARCH_TIMEOUT_MS = 60_000;
const BROWSER_TIMEOUT_MS = 120_000;
/** The provider name sessions see in the model picker. */
const PROVIDER = "portal";

export interface DshPatchOptions {
  catalog: ModelCatalog;
  /** http://<gateway bridge IP>:<service port>, the only address a workspace can reach. */
  serviceBaseUrl: string;
  /** Offer the Playwright MCP browser. */
  browser: boolean;
}

/**
 * The models dsh can use: each output cap lowered to fit dsh's compaction budget, and the models
 * whose context window is too small for it left out (Qwen Code still offers them). The default stays
 * unless it was left out. Throws AgentConfigError when no model is left.
 */
export function fitDshModels(catalog: ModelCatalog): ModelCatalog {
  const models = catalog.models.flatMap((model) => {
    const maxTokens = Math.min(model.maxTokens, model.contextWindow - DSH_MIN_MESSAGE_BUDGET);
    return maxTokens >= DSH_MIN_OUTPUT_TOKENS ? [{ ...model, maxTokens }] : [];
  });
  if (models.length === 0) {
    const smallest = DSH_MIN_MESSAGE_BUDGET + DSH_MIN_OUTPUT_TOKENS;
    throw new AgentConfigError(
      `DeepSeek Harness needs a model with a context window of at least ${smallest} tokens, and none of the configured models has one.`,
    );
  }
  const defaultModel = models.some((model) => model.id === catalog.defaultModel) ? catalog.defaultModel : models[0]!.id;
  return { models, defaultModel };
}

/** The rows of portal.patch.yml (a dsh `--patch` file: a list of plugin rows), for a fitted catalog. */
export function dshPatchRows(options: DshPatchOptions): unknown[] {
  const { catalog, serviceBaseUrl, browser } = options;
  const defaultModel = catalog.models.find((model) => model.id === catalog.defaultModel)!;
  const servers: unknown[] = [
    {
      id: "mcp-search",
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        transport: "streamable-http",
        serverName: "search",
        url: `${serviceBaseUrl}/mcp/search`,
        toolCallTimeoutMs: SEARCH_TIMEOUT_MS,
      },
    },
  ];
  if (browser) {
    servers.push({
      id: "mcp-browser",
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        transport: "stdio",
        serverName: "browser",
        command: "/usr/local/bin/playwright-mcp",
        // dsh gives MCP children a scrubbed environment, so the browser's path goes on the command line.
        args: ["--headless", "--isolated", "--no-sandbox", "--executable-path=/usr/bin/chromium", "--output-dir=/workspace/.browser"],
        cwd: "/tmp",
        toolCallTimeoutMs: BROWSER_TIMEOUT_MS,
      },
    });
  }
  return [
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          [PROVIDER]: {
            displayName: "Workspace Portal",
            api: "openai-completions",
            baseURL: `${serviceBaseUrl}/llm/v1`,
            // A placeholder in the container; the gateway's LLM proxy sends the real key upstream.
            apiKeyEnv: LLM_KEY_ENV,
            cacheRetention: "none",
            timeoutMs: LLM_TIMEOUT_MS,
            streamIdleTimeoutMs: LLM_TIMEOUT_MS,
            // An OpenAI-compatible server such as llama.cpp's llama-server.
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: true,
              supportsUsageInStreaming: true,
              supportsStrictMode: false,
              supportsLongCacheRetention: false,
              maxTokensField: "max_tokens",
            },
            models: catalog.models.map(dshModel),
          },
        },
      },
    },
    {
      id: "agent-default-model",
      config: {
        provider: PROVIDER,
        model: defaultModel.id,
        ...(defaultModel.defaultEffort === null ? {} : { reasoningEffort: defaultModel.defaultEffort }),
      },
    },
    { insert: servers },
  ];
}

export function renderDshPatch(options: DshPatchOptions): string {
  const header = [
    "# Rendered by the Workspace Portal gateway before every start; edits here are overwritten.",
    "# The models come from Qwen Code's system-defaults.json (deploy/qwen-config.sh); the rest of dsh's",
    "# portal configuration is in the image (/usr/local/share/workspace-portal/dsh/lockdown.patch.yml).",
  ];
  return `${header.join("\n")}\n${JSON.stringify(dshPatchRows(options), null, 2)}\n`;
}

function dshModel(model: PortalModel): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.image ? ["text", "image"] : ["text"],
    reasoningEfforts: model.efforts.length === 0 ? false : Object.fromEntries(model.efforts.map((effort) => [effort, effort])),
  };
}
