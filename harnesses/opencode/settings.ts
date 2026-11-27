// OpenCode's settings in a workspace: opencode.json, rendered before every start and mounted read-only at /etc/opencode,
// OpenCode's directory for managed settings, with the agent's instructions beside it (../instructions.ts). What that
// file names wins over a person's own settings (~/.config/opencode) and over any project's opencode.json; everything
// it leaves out stays theirs (agents, commands, their own MCP servers, plugins and skills, permissions for other
// tools). It holds what the portal depends on: the portal's models (../models.ts) through the gateway and no other
// provider, its image models (media.json) for OpenCode's generate_image tool, its media models (media.json, by kind
// and tier) for the portal's own media tools (image/media-tools), the gateway's search in place of OpenCode's own web
// tools, and no update or session sharing, which a workspace could not reach or must not use. And what a workspace
// starts with: the plugins and skills of the image (image/install.sh), formatting after edits, and for an Online
// workspace two public MCP servers. The keys are OpenCode 2's (`providers`, `policies`, `permissions`, `mcp.servers`,
// `plugins`, `skills`).
//
// OpenCode replaces `{env:NAME}` and `{file:path}` in the file's text before it parses it. Nothing here uses them; a
// model name or id of the admin's that held such a marker would be replaced, so a start with one is refused. So is
// one with a model id that has a `#`, where OpenCode's name for a model ("<provider>/<id>#<variant>") ends the id.
import type { WorkspaceKind } from "@portal/core";
import { INSTRUCTIONS_FILE } from "../instructions.ts";
import { MEDIA_KINDS, MEDIA_TIERS, besideLlmIds, imageModels as imageModelIds, mediaModel, type MediaKind, type MediaRegistry } from "../media.ts";
import type { ModelCatalog, PortalModel } from "../models.ts";
import { AgentConfigError, BROWSER_MCP, BROWSER_TIMEOUT_MS, LLM_KEY_ENV, LLM_TIMEOUT_MS, LLM_WAIT_MS, SEARCH_TIMEOUT_MS } from "../shared.ts";

export const OPENCODE_SETTINGS_DIR = "/etc/opencode";
export const OPENCODE_CONFIG_FILE = "opencode.json";

/** The provider's id: models are `portal/<id>` in OpenCode's settings and URLs. */
const PROVIDER = "portal";
/** Where image/install.sh puts the plugins and skills: in the image, so that a start downloads nothing. */
const SHARE = "/usr/local/share/workspace-portal/opencode";
/**
 * Public MCP servers that need no account, for a workspace that reaches the internet: the current documentation of a
 * library (Context7) and code search over public GitHub repositories (grep.app). What the agent asks them leaves the
 * portal.
 */
const ONLINE_MCP = { context7: "https://mcp.context7.com/mcp", grep: "https://mcp.grep.app" };

interface OpencodeConfigOptions {
  catalog: ModelCatalog;
  /** The AI server's image and media models (media.json): generate_image and the portal's media tools use them. */
  media: MediaRegistry;
  /** http://<gateway bridge IP>:<service port>, the only address a Private workspace can reach. */
  serviceBaseUrl: string;
  /** Offer the Playwright MCP browser. */
  browser: boolean;
  kind: WorkspaceKind;
}

/** Every string in `value`, keys included. */
function textsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => [key, ...textsOf(item)]);
  return [];
}

/** The managed opencode.json of a workspace, as an object. Throws AgentConfigError for a model OpenCode would misread. */
export function opencodeConfig(options: OpencodeConfigOptions): Record<string, unknown> {
  const { catalog, media, serviceBaseUrl, browser, kind } = options;
  const imageModels = imageModelIds(media);
  const mediaKinds = MEDIA_KINDS.filter((kind) => kind !== "image" && media[kind] !== undefined);
  const mediaIds = MEDIA_KINDS.flatMap((kind) => MEDIA_TIERS.flatMap((tier) => {
    const entry = media[kind]?.[tier];
    return entry ? [entry.model, entry.clone ?? "", entry.design ?? ""].filter(Boolean) : [];
  }));
  // The whole registry goes into the settings (the media plugin's options), its every text with it.
  const marker = [...catalog.models.flatMap((model) => [model.id, model.name]), ...textsOf(media)].find((text) => /\{(?:env|file):/.test(text));
  if (marker !== undefined) {
    throw new AgentConfigError(`OpenCode would replace "${marker}" in its settings: a model's id and name, and media.json's text, must not contain {env: or {file:.`);
  }
  const variant = [...catalog.models.map((model) => model.id), ...mediaIds].find((id) => id.includes("#"));
  if (variant !== undefined) {
    throw new AgentConfigError(`OpenCode reads the "#" in "${variant}" as the start of a variant's name: a model's id must not contain one.`);
  }
  const both = imageModels.find((id) => catalog.models.some((model) => model.id === id));
  if (both !== undefined) throw new AgentConfigError(`"${both}" is both a chat model and an image model (media.json): OpenCode takes a model as one or the other.`);
  // codemode false: the model calls these tools itself (search_web_search, search_read_page), as with the other
  // agents, not through a script it would have to write for OpenCode's `execute` tool.
  const servers: Record<string, unknown> = {
    search: { type: "remote", url: `${serviceBaseUrl}/mcp/search`, oauth: false, codemode: false, timeout: { execution: SEARCH_TIMEOUT_MS } },
  };
  if (browser) {
    servers.browser = { type: "local", command: [BROWSER_MCP.command, ...BROWSER_MCP.args], codemode: false, timeout: { execution: BROWSER_TIMEOUT_MS } };
  }
  if (kind === "online") {
    for (const [name, url] of Object.entries(ONLINE_MCP)) servers[name] = { type: "remote", url, oauth: false, codemode: false };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    update: "disable",
    share: "disabled",
    model: `${PROVIDER}/${catalog.defaultModel}`,
    // Added to every session's prompt, after the AGENTS.md files of the person and the project.
    instructions: [`${OPENCODE_SETTINGS_DIR}/${INSTRUCTIONS_FILE}`],
    plugins: [
      `${SHARE}/plugins/superpowers`,
      `${SHARE}/plugins/safety-net`,
      // generate_video, generate_music, synthesize_speech and transcribe_audio, for the kinds there are models of,
      // and list_media_models.
      ...(mediaKinds.length === 0 ? [] : [{ package: `${SHARE}/plugins/media`, options: { baseURL: `${serviceBaseUrl}/llm/v1`, media } }]),
    ],
    skills: [`${SHARE}/skills`],
    // Files are formatted after an edit, by the formatters OpenCode knows and the image has (gofmt, rustfmt, ruff,
    // shfmt) or the project installed (prettier, biome). {} keeps a person's own formatters; `true` would drop them.
    formatter: {},
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
          // A request may wait in the gateway's queue for hours before its headers come (LLM_WAIT_MS); once the
          // answer streams, an hour without a chunk ends it.
          timeout: false,
          headerTimeout: LLM_WAIT_MS,
          chunkTimeout: LLM_TIMEOUT_MS,
        },
        models: Object.fromEntries([
          ...catalog.models.map((model) => [model.id, opencodeModel(model)]),
          ...imageModels.map((id) => [id, opencodeImageModel(id)]),
        ]),
      },
    },
    // The image model generate_image uses unless the agent names another: the fast tier's.
    ...(imageModels.length === 0 ? {} : { experimental: { image_generate: { model: `${PROVIDER}/${imageModels[0]}` } } }),
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

/** Each kind's tool, and what it is for, as the agent is told; the skill (image/media-skill) says how to make a piece. */
const MEDIA_TOOLS: Record<MediaKind, { tool: string; does: string }> = {
  image: { tool: "generate_image", does: "makes and edits images" },
  video: { tool: "generate_video", does: "makes a short clip with its own sound" },
  music: { tool: "generate_music", does: "makes music, instrumental or sung" },
  speech: { tool: "synthesize_speech", does: "reads text aloud in a built-in, described or cloned voice" },
  transcription: { tool: "transcribe_audio", does: "writes down what an audio or video file says" },
};

/**
 * What the agent is told about the image and media tools, with the workspace's other facts (../instructions.ts): each
 * kind's fast and quality model and what each is for, and when to go ahead and when to propose a plan first. Without
 * a path OpenCode saves an image in its temp folder, which the person does not see and a restart empties.
 */
export function opencodeFacts(media: MediaRegistry): string[] {
  const kinds = MEDIA_KINDS.filter((kind) => media[kind] !== undefined);
  if (kinds.length === 0) return [];
  const facts: string[] = [];
  const beside = besideLlmIds(media);
  const image = media.image;
  if (image) {
    const fast = mediaModel(media, "image", "fast")!;
    facts.push(
      `- Images: generate_image makes and edits images. Give it a \`path\` in the project, such as images/<short-name>.png, so the person finds the file there, and once the image is saved show it in your reply as ![<what it shows>](images/<short-name>.png). Its \`model\` is the tier: leave it out for the fast one (${PROVIDER}/${fast.model})${image.quality && image.quality.model !== fast.model ? `, or give ${PROVIDER}/${image.quality.model} for the quality one` : ""}.`,
    );
  }
  const tools = kinds.filter((kind) => kind !== "image");
  const lines = kinds.map((kind) => {
    const { tool } = MEDIA_TOOLS[kind];
    const tiers = MEDIA_TIERS.flatMap((tier) => {
      const entry = media[kind]?.[tier];
      if (!entry) return [];
      const about = [entry.bestFor && `for ${entry.bestFor}`, entry.time].filter(Boolean).join("; ");
      const model = kind === "image" ? `${PROVIDER}/${entry.model}` : entry.model;
      return [`${tier}: ${entry.name} (${model})${about ? `, ${about}` : ""}${beside.has(entry.model) ? ", runs beside you" : ""}`];
    });
    return `  - ${tool} ${MEDIA_TOOLS[kind].does}. ${tiers.join(". ")}.${tiers.length === 1 ? " Both tiers use it." : ""}`;
  });
  facts.push(
    [
      `- Media models, by tier: \`fast\` for drafts, tries and everyday work, \`quality\` for the final version or when the person asks for the best.${tools.length > 0 ? " The media tools take the tier as `tier`, save the file at the `path` in the project you give them, and answer with JSON facts about it (file_path, tier, model_used, elapsed_sec), never the file." : ""}`,
      ...lines,
      `  Every model not marked as running beside you shares the GPU with you, one at a time: while it works no LLM request is answered, anyone's or yours, and a video holds the server for minutes. list_media_models says which are loaded now and whether a video holds the server.`,
    ].join("\n"),
  );
  if (tools.length > 0) {
    facts.push(
      [
        "- Media requests:",
        "  - Go ahead when it is one simple asset the person described clearly (an image, a line spoken, a transcript, a short track): pick the tier yourself, fast unless they ask for the final or the best, and say which you used.",
        "  - Otherwise propose first: a piece with several assets, any video, anything that takes more than a few minutes, or when the tier is not clear. Call list_media_models, then show the plan as a table with the columns Step, Asset, Tier & model, Why, Est. time (from the times above, a model swap included), and end with: Reply **go** to start, or tell me what to change. Make nothing until they answer.",
        "  - For a piece that matters, make it twice: drafts with fast, shown to the person, then the final with quality once they approve.",
        "  - Load the media-production skill before making a video, a song or a narrated piece, and follow it: plan, batch by model, check every part.",
      ].join("\n"),
    );
  }
  return facts;
}

export function renderOpencodeConfig(options: OpencodeConfigOptions): string {
  return `${JSON.stringify(opencodeConfig(options), null, 2)}\n`;
}

/**
 * An image model: OpenCode keeps it out of the model picker, which offers chat models only, and offers it to its
 * generate_image tool, which posts to the provider's /images/generations, or /images/edits with images to change.
 */
function opencodeImageModel(id: string): Record<string, unknown> {
  return {
    name: id,
    type: "image",
    // Part of OpenCode itself, like the provider's package.
    package: "@opencode/ai/providers/openai-compatible/images",
    capabilities: { input: ["text", "image"], output: ["image"] },
  };
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
