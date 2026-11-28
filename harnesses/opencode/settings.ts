// OpenCode's settings in a workspace: opencode.json, rendered before every start and mounted read-only at /etc/opencode,
// OpenCode's directory for managed settings, with the agent's instructions beside it (../instructions.ts). What that
// file names wins over a person's own settings (~/.config/opencode) and over any project's opencode.json; everything
// it leaves out stays theirs (agents, commands, their own MCP servers, plugins and skills, permissions for other
// tools). It holds what the portal depends on: the portal's models (../models.ts) through the gateway and no other
// provider, its image models (media.json's image and imageEdit) for OpenCode's generate_image tool, its media models
// (media.json, by kind and tier) for the portal's own media tools (image/media-tools), the gateway's search in place of OpenCode's own web
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
import { MEDIA_KINDS, MEDIA_TIERS, besideLlmIds, imageModels as imageModelIds, mediaModel, mediaModelIds, type MediaKind, type MediaRegistry, type MediaTier } from "../media.ts";
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
  const imageDefault = mediaModel(media, "image", "quality") ?? mediaModel(media, "imageEdit", "fast");
  const editors = new Set(mediaModelIds(media, "imageEdit"));
  const mediaKinds = MEDIA_KINDS.filter((kind) => !IMAGE_KINDS.includes(kind) && media[kind] !== undefined);
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
          ...imageModels.map((id) => [id, opencodeImageModel(id, editors.has(id), imageSizes(media, id))]),
        ]),
      },
    },
    // The model generate_image takes when the agent names none: the quality one, because the tool's own description
    // tells the agent to name no model unasked, so most images are made this way. With input images OpenCode keeps
    // it only if it edits, and otherwise takes an image model that does.
    ...(imageDefault === null ? {} : { experimental: { image_generate: { model: `${PROVIDER}/${imageDefault.model}` } } }),
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

/** The kinds OpenCode's own generate_image serves; the portal's media plugin has a tool for each of the others. */
const IMAGE_KINDS: readonly MediaKind[] = ["image", "imageEdit"];

/** The sizes an image model makes besides the server's default. A model both kinds name is one model to OpenCode: their sizes together. */
function imageSizes(media: MediaRegistry, id: string): string[] {
  const entries = IMAGE_KINDS.flatMap((kind) => MEDIA_TIERS.map((tier) => media[kind]?.[tier]));
  return [...new Set(entries.flatMap((entry) => (entry?.model === id ? (entry.sizes ?? []) : [])))];
}

/** Each kind's tool, and what it is for, as the agent is told; the skill (image/media-skill) says how to make a piece. */
const MEDIA_TOOLS: Record<MediaKind, { tool: string; does: string }> = {
  image: { tool: "generate_image", does: "makes a new image from a prompt" },
  imageEdit: { tool: "generate_image", does: "changes the images you give it as `images`" },
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
  if (media.image || media.imageEdit) facts.push(imageFact(media));
  const tools = kinds.filter((kind) => !IMAGE_KINDS.includes(kind));
  const lines = kinds.map((kind) => {
    const { tool } = MEDIA_TOOLS[kind];
    const tiers = MEDIA_TIERS.flatMap((tier) => {
      const entry = media[kind]?.[tier];
      if (!entry) return [];
      const about = [entry.bestFor && `for ${entry.bestFor}`, entry.time].filter(Boolean).join("; ");
      const model = IMAGE_KINDS.includes(kind) ? `${PROVIDER}/${entry.model}` : entry.model;
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
        "  - Go ahead when it is one simple asset the person described clearly (an image, a line spoken, a transcript, a short track): pick the tier yourself and say which you used. A single image is made by its quality model; anything else by the fast one unless they ask for the final or the best.",
        "  - Otherwise propose first: a piece with several assets, any video, anything that takes more than a few minutes, or when the tier is not clear. Call list_media_models, then show the plan as a table with the columns Step, Asset, Tier & model, Why, Est. time (from the times above, a model swap included), and end with: Reply **go** to start, or tell me what to change. Make nothing until they answer.",
        "  - For a piece that matters, make it twice: drafts with fast, shown to the person, then the final with quality once they approve.",
        "  - Several parts from one model (the lines of a narration, the clips of a film): call its tool for all of them in one message. They are made one after another and the model is loaded once; a call a message loads you again after every part.",
        "  - Load the media-production skill before making a video, a song or a narrated piece, and follow it: plan, batch by model, check every part.",
      ].join("\n"),
    );
  }
  return facts;
}

/**
 * How generate_image is called and comes to the right model. Since OpenCode 2.4.2 it is a Code Mode tool, reached
 * from a script for `execute`; a call by name still runs, with a note to the agent to use `execute`. Its own
 * description tells the agent never to name a model unasked, so the model is left out wherever OpenCode's choice is
 * the right one: the default for a new image, and for a call with input images the model that edits
 * (opencodeImageModel). The tool takes no size: a size is a variant of its model, so a call that wants one names the
 * model.
 */
function imageFact(media: MediaRegistry): string {
  const id = (kind: MediaKind, tier: MediaTier): string | null => {
    const entry = mediaModel(media, kind, tier);
    return entry === null ? null : `${PROVIDER}/${entry.model}`;
  };
  const [fast, quality] = [id("image", "fast"), id("image", "quality")];
  const [editFast, editQuality] = [id("imageEdit", "fast"), id("imageEdit", "quality")];
  const makes =
    fast === null
      ? []
      : fast === quality
        ? [`For a new image leave \`model\` out: ${fast} makes every one.`]
        : [`For a new image leave \`model\` out for the quality model (${quality}), or give ${fast} for the fast one: the tiers below say what each is for.`];
  const edits =
    editFast === null
      ? "No model here changes an existing image: describe what you want and make a new one."
      : editFast === editQuality
        ? `To change images, give them as \`images\` and leave \`model\` out: the tool takes ${editFast} for them itself.`
        : `To change images, give them as \`images\` with \`model\` ${editFast} for the fast edit or ${editQuality} for the quality one.`;
  const sized = imageModelIds(media).flatMap((model) => {
    const sizes = imageSizes(media, model);
    const [first] = sizes;
    return first === undefined ? [] : [{ id: `${PROVIDER}/${model}`, sizes, example: `${PROVIDER}/${model}#${first}` }];
  });
  // The example is the model a new image goes to, when it has sizes.
  const shown = sized.find(({ id }) => id === quality) ?? sized[0];
  const size =
    shown === undefined
      ? "Every new image is 1024x1024."
      : `A new image is 1024x1024 unless \`model\` ends in \`#\` and one of the model's sizes, as in ${shown.example}: ${sized.map(({ id, sizes }) => `${id} makes ${sizes.join(", ")}`).join("; ")}. For such a size you must give \`model\`, even where you would otherwise leave it out.`;
  return [
    "- Images: generate_image makes a new image, or changes existing ones. It is a tool of `execute`: call it in a script, as `return await tools.generate_image({ prompt: \"...\", path: \"images/<short-name>.png\" })`. Give it a `path` in the project, so the person finds the file there, and once the image is saved show it in your reply as ![<what it shows>](images/<short-name>.png). Start several images in one script (`await Promise.all([...])`): their model is then loaded once for all of them.",
    ...makes,
    edits,
    size,
  ].join(" ");
}

export function renderOpencodeConfig(options: OpencodeConfigOptions): string {
  return `${JSON.stringify(opencodeConfig(options), null, 2)}\n`;
}

/**
 * An image model: OpenCode keeps it out of the model picker, which offers chat models only, and offers it to its
 * generate_image tool, which posts to the provider's /images/generations, or /images/edits with images to change.
 * A call with input images goes only to a model whose input lists them: that is how an edit reaches the registry's
 * imageEdit model and never one that only makes new images. generate_image has no size parameter, so each size is a
 * variant named by it ("<provider>/<id>#1344x768"): OpenCode adds a variant's `body` to the request's.
 */
function opencodeImageModel(id: string, edits: boolean, sizes: readonly string[]): Record<string, unknown> {
  return {
    name: id,
    type: "image",
    // Part of OpenCode itself, like the provider's package.
    package: "@opencode/ai/providers/openai-compatible/images",
    capabilities: { input: edits ? ["text", "image"] : ["text"], output: ["image"] },
    ...(sizes.length === 0 ? {} : { variants: sizes.map((size) => ({ id: size, body: { size } })) }),
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
