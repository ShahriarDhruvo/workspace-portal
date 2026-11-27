import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { HeaderMap } from "../harness.ts";
import { parseMediaRegistry, type MediaRegistry } from "../media.ts";
import type { ModelCatalog } from "../models.ts";
import { AgentConfigError } from "../shared.ts";
import { closeServer, listenLocal } from "../testing.ts";
import { opencodeAuthorization, opencodeDriver, parsePendingCount, parseRunningJobs, parseRunningSessions } from "./driver.ts";
import { opencodeConfig, opencodeFacts, renderOpencodeConfig } from "./settings.ts";

const SERVICE = "http://172.29.0.1:4001";
const NO_MEDIA: MediaRegistry = {};
const registry = (value: unknown): MediaRegistry => parseMediaRegistry(JSON.stringify(value), "test");
const images = (fast: string, quality?: string): MediaRegistry => registry({ image: { fast: { model: fast }, ...(quality ? { quality: { model: quality } } : {}) } });
/** The reference AI server's, shortened. */
const STUDIO = registry({
  image: { fast: { model: "Image-Turbo", name: "Image Turbo", time: "about 25 s an image", bestFor: "drafts" }, quality: { model: "Image", name: "Image", time: "about 95 s an image", bestFor: "final images" } },
  video: { fast: { model: "minimax-h3", name: "H3 fast", request: { gufo: { preset: "fast" } }, sizes: ["512x512"], seconds: { min: 5, max: 14.375 } }, quality: { model: "minimax-h3", name: "H3", sizes: ["512x512", "1344x768"], seconds: { min: 5, max: 14.375 } } },
  speech: {
    fast: { model: "qwen3-tts-1.7b", name: "Qwen3-TTS", besideLlm: true, api: "qwen3-tts", voices: { ryan: "male, English" }, clone: "qwen3-tts-1.7b-clone", design: "qwen3-tts-1.7b-design" },
    quality: { model: "fish-s2-pro", name: "Fish", api: "fish-speech" },
  },
  transcription: { quality: { model: "sov-transcribe-1", name: "SOV", subtitles: true } },
});
const PASSWORD = "container-password";

const CATALOG: ModelCatalog = {
  defaultModel: "big",
  models: [
    { id: "small", name: "Small", contextWindow: 32_768, maxTokens: 4096, image: false, efforts: [], defaultEffort: null },
    { id: "big", name: "Big", contextWindow: 262_144, maxTokens: 64_000, image: true, efforts: ["low", "medium", "xhigh"], defaultEffort: "low" },
    { id: "org/free-choice", name: "Free choice", contextWindow: 131_072, maxTokens: 8192, image: false, efforts: ["low", "high"], defaultEffort: null },
  ],
};

test("opencodeConfig: one provider through the gateway, the portal's models and default, search in place of OpenCode's web tools", () => {
  const config = opencodeConfig({ catalog: CATALOG, media: NO_MEDIA, serviceBaseUrl: SERVICE, browser: true, kind: "private" }) as Record<string, any>;
  assert.equal(config.update, "disable");
  assert.equal(config.share, "disabled");
  assert.equal(config.model, "portal/big");
  assert.deepEqual(
    config.policies,
    [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "portal", effect: "allow" },
      { action: "websearch.use", resource: "*", effect: "deny" },
    ],
    "no other provider, OpenCode's own hosted models included; the later rule wins",
  );
  assert.equal(config.websearch, false);
  assert.deepEqual(config.permissions, [{ action: "webfetch", resource: "*", effect: "deny" }]);
  assert.deepEqual(config.instructions, ["/etc/opencode/AGENTS.md"], "the file the driver renders beside the settings");

  const { portal } = config.providers;
  assert.equal(portal.package, "@opencode/ai/providers/openai-compatible", "part of OpenCode: nothing to download");
  assert.deepEqual(portal.env, ["PORTAL_LLM_KEY"]);
  assert.deepEqual(portal.compatibility, { maxTokensField: "max_tokens" });
  assert.deepEqual(portal.settings, { baseURL: `${SERVICE}/llm/v1`, timeout: false, headerTimeout: 86_400_000, chunkTimeout: 3_600_000 });
  assert.deepEqual(Object.keys(portal.models), ["small", "big", "org/free-choice"]);
  assert.deepEqual(portal.models.small, {
    name: "Small",
    capabilities: { tools: true, input: ["text"], output: ["text"], reasoning: { supported: false } },
    limit: { context: 32_768, output: 4096 },
  });
  assert.deepEqual(portal.models.big, {
    name: "Big",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"], reasoning: { supported: true, effort: ["low", "medium", "xhigh"] } },
    limit: { context: 262_144, output: 64_000 },
    // Sent with every request no variant overrides: the portal's default effort.
    settings: { reasoningEffort: "low" },
  });
  assert.equal("settings" in portal.models["org/free-choice"], false, "no default effort: the model's own");

  const { servers } = config.mcp;
  assert.deepEqual(servers.search, { type: "remote", url: `${SERVICE}/mcp/search`, oauth: false, codemode: false, timeout: { execution: 60_000 } });
  assert.equal(servers.browser.type, "local");
  assert.equal(servers.browser.command[0], "/usr/local/bin/playwright-mcp");
  assert.equal(servers.browser.codemode, false, "the model calls the browser's tools itself");
  assert.deepEqual(servers.browser.timeout, { execution: 120_000 });
  assert.deepEqual(Object.keys((opencodeConfig({ catalog: CATALOG, media: NO_MEDIA, serviceBaseUrl: SERVICE, browser: false, kind: "private" }) as Record<string, any>).mcp.servers), ["search"]);
});

test("opencodeConfig: a workspace starts with the image's plugins and skills and with formatting; an Online one with the public MCP servers too", () => {
  const config = opencodeConfig({ catalog: CATALOG, media: NO_MEDIA, serviceBaseUrl: SERVICE, browser: true, kind: "private" }) as Record<string, any>;
  const share = "/usr/local/share/workspace-portal/opencode";
  assert.deepEqual(config.plugins, [`${share}/plugins/superpowers`, `${share}/plugins/safety-net`], "folders of the image: nothing to download");
  assert.deepEqual(config.skills, [`${share}/skills`]);
  assert.deepEqual(config.formatter, {}, "on, and a person's own formatters stay");
  assert.deepEqual(Object.keys(config.mcp.servers), ["search", "browser"], "a Private workspace reaches no public server");

  const online = opencodeConfig({ catalog: CATALOG, media: NO_MEDIA, serviceBaseUrl: SERVICE, browser: true, kind: "online" }) as Record<string, any>;
  assert.deepEqual(Object.keys(online.mcp.servers), ["search", "browser", "context7", "grep"]);
  assert.deepEqual(online.mcp.servers.context7, { type: "remote", url: "https://mcp.context7.com/mcp", oauth: false, codemode: false });
  assert.deepEqual(online.mcp.servers.grep, { type: "remote", url: "https://mcp.grep.app", oauth: false, codemode: false });
  assert.deepEqual({ ...online, mcp: null }, { ...config, mcp: null }, "the kinds differ in the MCP servers only");
});

test("the image build checks OpenCode against settings as the gateway renders them (image/check-settings.json)", () => {
  // The default model's id has slashes, as a model server names a model from a hub: OpenCode's name for a model is
  // "<provider>/<id>", and the build checks that it takes the whole id.
  const catalog: ModelCatalog = {
    defaultModel: "models/Check/Check-Model",
    models: [
      { id: "models/Check/Check-Model", name: "Check model", contextWindow: 262_144, maxTokens: 48_000, image: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { id: "plain-model", name: "Plain model", contextWindow: 65_536, maxTokens: 8192, image: false, efforts: [], defaultEffort: null },
    ],
  };
  const media = registry({
    image: { fast: { model: "Check-Image" } },
    video: { fast: { model: "Check-Video", sizes: ["512x512"], seconds: { min: 1, max: 5 } } },
    music: { fast: { model: "Check-Music" } },
    speech: { fast: { model: "Check-Speech", api: "qwen3-tts", voices: { check: "a test voice" } } },
    transcription: { fast: { model: "Check-Transcription", subtitles: true } },
  });
  const rendered = renderOpencodeConfig({ catalog, media, serviceBaseUrl: "http://service.invalid:4001", browser: true, kind: "private" });
  const checked = fs.readFileSync(new URL("image/check-settings.json", import.meta.url), "utf8");
  // When the renderer changes, the file changes with it (to `rendered`), so that the build checks what workspaces get.
  assert.equal(checked, rendered);
});

test("opencodeConfig: the AI server's image models are the provider's, for generate_image, the fast one its default", () => {
  const config = opencodeConfig({ catalog: CATALOG, media: images("Image-Turbo", "Image"), serviceBaseUrl: SERVICE, browser: false, kind: "private" }) as Record<string, any>;
  const { models } = config.providers.portal;
  assert.deepEqual(Object.keys(models), ["small", "big", "org/free-choice", "Image-Turbo", "Image"]);
  assert.deepEqual(models.Image, {
    name: "Image",
    type: "image",
    package: "@opencode/ai/providers/openai-compatible/images",
    capabilities: { input: ["text", "image"], output: ["image"] },
  });
  assert.deepEqual(config.experimental, { image_generate: { model: "portal/Image-Turbo" } });
  assert.equal(config.model, "portal/big", "the chat model stays the default");
  const without = opencodeConfig({ catalog: CATALOG, media: NO_MEDIA, serviceBaseUrl: SERVICE, browser: false, kind: "private" }) as Record<string, any>;
  assert.equal("experimental" in without, false, "no image models: OpenCode offers no generate_image");

  // A "#" in a model id the registry refuses already (media.test.ts).
  for (const [model, message] of [["big", /"big" is both a chat model and an image model/]] as const) {
    assert.throws(() => renderOpencodeConfig({ catalog: CATALOG, media: images(model), serviceBaseUrl: SERVICE, browser: false, kind: "private" }), (error: unknown) => {
      assert.ok(error instanceof AgentConfigError);
      assert.match(error.message, message);
      return true;
    });
  }
});

test("opencodeFacts: where to save an image and how to show it, and its model by tier; nothing without image or media models", () => {
  assert.deepEqual(opencodeFacts(NO_MEDIA), []);
  const [fact, tiers, protocol] = opencodeFacts(images("Image-Turbo", "Image"));
  assert.match(fact!, /^- Images: generate_image makes and edits images\./);
  assert.match(fact!, /`path` in the project, such as images\/<short-name>\.png/);
  assert.match(fact!, /!\[<what it shows>\]\(images\/<short-name>\.png\)/);
  assert.match(fact!, /leave it out for the fast one \(portal\/Image-Turbo\), or give portal\/Image for the quality one\.$/);
  assert.match(opencodeFacts(images("Image"))[0]!, /leave it out for the fast one \(portal\/Image\)\.$/);
  assert.match(tiers!, /^- Media models, by tier: `fast` for drafts/);
  assert.doesNotMatch(tiers!, /The media tools take the tier/, "images alone: no media tools");
  assert.equal(protocol, undefined, "no media tools: nothing about plans");
});

test("opencodeFacts: each kind's fast and quality model, which run beside the LLM, and when to propose a plan", () => {
  const [, tiers, protocol, ...rest] = opencodeFacts(STUDIO);
  assert.equal(rest.length, 0);
  const lines = tiers!.split("\n");
  assert.match(lines[0]!, /The media tools take the tier as `tier`, save the file at the `path`.*\(file_path, tier, model_used, elapsed_sec\), never the file\.$/);
  assert.equal(lines[1], "  - generate_image makes and edits images. fast: Image Turbo (portal/Image-Turbo), for drafts; about 25 s an image. quality: Image (portal/Image), for final images; about 95 s an image.");
  assert.equal(lines[2], "  - generate_video makes a short clip with its own sound. fast: H3 fast (minimax-h3). quality: H3 (minimax-h3).");
  assert.equal(lines[3], "  - synthesize_speech reads text aloud in a built-in, described or cloned voice. fast: Qwen3-TTS (qwen3-tts-1.7b), runs beside you. quality: Fish (fish-s2-pro).");
  assert.equal(lines[4], "  - transcribe_audio writes down what an audio or video file says. quality: SOV (sov-transcribe-1). Both tiers use it.");
  assert.match(lines[5]!, /^  Every model not marked as running beside you shares the GPU with you/);
  assert.match(protocol!, /Go ahead when it is one simple asset/);
  assert.match(protocol!, /the columns Step, Asset, Tier & model, Why, Est\. time/);
  assert.match(protocol!, /Reply \*\*go\*\* to start, or tell me what to change\. Make nothing until they answer\./);
  assert.match(protocol!, /drafts with fast, shown to the person, then the final with quality/);
  assert.match(protocol!, /Load the media-production skill/);
});

test("opencodeConfig: the media registry is the media plugin's, with the gateway's address; no plugin without a media model", () => {
  const config = opencodeConfig({ catalog: CATALOG, media: STUDIO, serviceBaseUrl: SERVICE, browser: false, kind: "private" }) as Record<string, any>;
  assert.deepEqual(config.plugins.at(-1), {
    package: "/usr/local/share/workspace-portal/opencode/plugins/media",
    options: { baseURL: `${SERVICE}/llm/v1`, media: STUDIO },
  });
  assert.equal(config.providers.portal.models["minimax-h3"], undefined, "a media model is no model of the provider's");
  for (const media of [NO_MEDIA, images("Image-Turbo")]) {
    const without = opencodeConfig({ catalog: CATALOG, media, serviceBaseUrl: SERVICE, browser: false, kind: "private" }) as Record<string, any>;
    assert.equal(without.plugins.length, 2, "superpowers and safety-net only");
  }
  for (const fast of [{ model: "music", name: "{env:HOME}" }, { model: "music", bestFor: "x {file:/etc/opencode/opencode.json}" }, { model: "music", request: { style: "{env:LLM_KEY}" } }]) {
    assert.throws(
      () => renderOpencodeConfig({ catalog: CATALOG, media: registry({ music: { fast } }), serviceBaseUrl: SERVICE, browser: false, kind: "private" }),
      /must not contain \{env: or \{file:/,
      JSON.stringify(fast),
    );
  }
  const named = opencodeConfig({ catalog: CATALOG, media: registry({ music: { fast: { model: "music", name: "Take #2" } } }), serviceBaseUrl: SERVICE, browser: false, kind: "private" });
  assert.ok(named, "a name may have a #: only an id is read for a variant");
});

test("renderOpencodeConfig is JSON; a model OpenCode would rewrite is refused", () => {
  const text = renderOpencodeConfig({ catalog: CATALOG, media: NO_MEDIA, serviceBaseUrl: SERVICE, browser: true, kind: "private" });
  assert.deepEqual(JSON.parse(text), opencodeConfig({ catalog: CATALOG, media: NO_MEDIA, serviceBaseUrl: SERVICE, browser: true, kind: "private" }));
  assert.ok(text.endsWith("}\n"));
  assert.equal(text.match(/\{(env|file):/g), null, "nothing for OpenCode to substitute");

  for (const [id, name] of [["m", "Model {env:OPENCODE_PASSWORD}"], ["{file:/etc/passwd}", "M"]] as const) {
    const catalog = { defaultModel: id, models: [{ ...CATALOG.models[0]!, id, name }] };
    assert.throws(() => renderOpencodeConfig({ catalog, media: NO_MEDIA, serviceBaseUrl: SERVICE, browser: false, kind: "private" }), (error: unknown) => {
      assert.ok(error instanceof AgentConfigError);
      assert.match(error.message, /must not contain \{env: or \{file:/);
      return true;
    });
  }
  // "portal/m#high" is model "m" at its variant "high" to OpenCode.
  const marked = { defaultModel: "small", models: [CATALOG.models[0]!, { ...CATALOG.models[0]!, id: "m#high" }] };
  assert.throws(() => renderOpencodeConfig({ catalog: marked, media: NO_MEDIA, serviceBaseUrl: SERVICE, browser: false, kind: "private" }), (error: unknown) => {
    assert.ok(error instanceof AgentConfigError);
    assert.equal(error.message, 'OpenCode reads the "#" in "m#high" as the start of a variant\'s name: a model\'s id must not contain one.');
    return true;
  });
});

test("opencode request signing: Host is the container, its password as HTTP Basic on every request", () => {
  const endpoint = { host: "172.29.128.9", port: 4096, credential: PASSWORD };
  const basic = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
  assert.equal(opencodeAuthorization(PASSWORD), basic);
  // The same whether the browser's request was "authorised": OpenCode's UI has nothing of its own to present.
  for (const authorised of [true, false]) {
    const headers: HeaderMap = { "content-type": "application/json" };
    opencodeDriver.signRequest(headers, endpoint, { authorised, origin: true });
    assert.deepEqual(headers, { "content-type": "application/json", host: "172.29.128.9:4096", authorization: basic });
  }
});

test("opencode container env carries only the password; a fresh 256-bit one per start", () => {
  assert.deepEqual(opencodeDriver.containerEnv(PASSWORD, {} as never), [`OPENCODE_PASSWORD=${PASSWORD}`]);
  assert.equal(opencodeDriver.credentialEnv, "OPENCODE_PASSWORD");
  assert.match(opencodeDriver.generateCredential(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(opencodeDriver.generateCredential(), opencodeDriver.generateCredential());
});

test("opencode sockets and user actions", () => {
  for (const path of ["/api/experimental/persistent-pty/pty_persistent_5005401935434722/connect", "/api/experimental/persistent-pty/pty_20b9d98de001xTnGn5VmgXyiXn/connect"]) {
    assert.equal(opencodeDriver.isSocketPath(path), true, path);
  }
  for (const path of [
    "/api/experimental/persistent-pty//connect",
    "/api/experimental/persistent-pty/connect",
    "/api/experimental/persistent-pty/a/b/connect",
    "/api/experimental/persistent-pty/a/connect/",
    "/api/experimental/persistent-pty/a/connect-token",
    "/api/experimental/persistent-pty/a/snapshot",
    "/persistent-pty/a/connect",
    // No terminal's id: what a server might read as another path.
    "/api/experimental/persistent-pty/../connect",
    "/api/experimental/persistent-pty/..%2f..%2fmachine%2flink/connect",
    "/api/experimental/persistent-pty/a\\b/connect",
    "/api/experimental/persistent-pty/a#b/connect",
    // OpenCode's other kind of terminal, which its page does not open.
    "/api/pty/pty_1/connect",
    // Sockets OpenCode has that its page does not need: a remote machine's link, an MCP server hosted by the client.
    "/api/experimental/machine/link",
    "/api/experimental/client-mcp",
    "/api/event",
    "/",
  ]) {
    assert.equal(opencodeDriver.isSocketPath(path), false, path);
  }

  for (const [method, path] of [
    ["POST", "/api/session"],
    ["POST", "/api/session/ses_1/prompt"],
    ["POST", "/api/session/ses_1/interrupt"],
    ["POST", "/api/session/ses_1/model"],
    ["POST", "/api/session/ses_1/permission/per_1/reply"],
    ["POST", "/api/session/ses_1/form/frm_1/reply"],
    ["PATCH", "/api/session/ses_1"],
    ["DELETE", "/api/session/ses_1"],
    ["PATCH", "/api/experimental/config"],
    ["POST", "/api/experimental/session/ses_1/terminal"],
    ["POST", "/api/pty"],
    ["DELETE", "/api/pty/pty_1"],
    ["POST", "/api/rpc/opencode.goal/set"],
  ] as const) {
    assert.equal(opencodeDriver.isUserAction(method, path), true, `${method} ${path}`);
  }
  for (const [method, path] of [
    ["GET", "/api/session/active"],
    ["GET", "/api/event"],
    ["GET", "/api/info"],
    ["HEAD", "/"],
    ["OPTIONS", "/api/session"],
    // What an open tab sends by itself: a terminal's ticket when its socket connects again, the note that it has
    // seen a turn end, and what it reads again when it loads.
    ["POST", "/api/experimental/persistent-pty/pty_1/connect-token"],
    ["POST", "/api/session/ses_1/view"],
    ["POST", "/api/worktree/refresh"],
    ["POST", "/api/rpc/opencode.goal/get"],
  ] as const) {
    assert.equal(opencodeDriver.isUserAction(method, path), false, `${method} ${path}`);
  }
});

test("the answers of OpenCode's API, as the status check reads them", () => {
  // GET /api/session/active, as 2.4.1 answers it.
  assert.deepEqual(parseRunningSessions({ data: { ses_1: { type: "running" }, ses_2: { type: "running" } } }), ["ses_1", "ses_2"]);
  assert.deepEqual(parseRunningSessions({ data: {} }), []);
  assert.deepEqual(parseRunningSessions({ data: { ses_9: { type: "something new" } } }), ["ses_9"], "a state OpenCode adds counts as a turn rather than as nothing");
  for (const odd of [null, undefined, [], "{}", 3, {}, { data: [] }, { data: null }, { ses_1: { type: "running" } }]) assert.equal(parseRunningSessions(odd), null);

  // GET /api/session/<id>/permission and /form.
  assert.equal(parsePendingCount({ data: [{ id: "per_1", sessionID: "ses_1", action: "shell", resources: ["rm -r build"] }] }), 1);
  assert.equal(parsePendingCount({ data: [{ id: "frm_1", sessionID: "ses_1", title: "Questions", fields: [] }, { id: "frm_2" }] }), 2);
  assert.equal(parsePendingCount({ data: [] }), 0);
  for (const odd of [null, undefined, [], {}, "[]", { data: {} }, { _tag: "NotFoundError" }]) assert.equal(parsePendingCount(odd), null);

  // GET /api/experimental/job: a command left running in the background, as 2.4.1 lists one, and a subagent.
  const shell = { kind: "shell", id: "sh_1", sessionID: "ses_1", status: "running", title: "sleep 100", time: { started: 1 }, shellID: "sh_1", command: "sleep 100" };
  const subagent = { kind: "subagent", id: "ses_2", sessionID: "ses_1", status: "running", title: "t", time: { started: 1 }, childSessionID: "ses_2", agent: "General", description: "t" };
  assert.equal(parseRunningJobs({ data: [shell, subagent, { ...shell, id: "sh_2", status: "completed" }] }), 1);
  assert.equal(parseRunningJobs({ data: [{ ...shell, kind: "something new" }] }), 1, "a kind OpenCode adds counts as work rather than as nothing");
  assert.equal(parseRunningJobs({ data: [subagent] }), 0, "a subagent is a session, asked about as one");
  assert.equal(parseRunningJobs({ data: [] }), 0);
  for (const odd of [null, undefined, [], {}, "[]", { data: {} }, { _tag: "NotFoundError" }]) assert.equal(parseRunningJobs(odd), null);
});

test("the status check: the running sessions and background jobs, with the password; a session that only waits for the person is no work; no answer where OpenCode gives none", async () => {
  const seen: Array<{ url: string; authorization: string | undefined }> = [];
  const answers: Record<string, unknown> = {};
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
    const key = req.url ?? "";
    if (!(key in answers)) return void res.writeHead(404).end("{}");
    const answer = answers[key];
    if (typeof answer === "number") return void res.writeHead(answer).end("{}");
    res.writeHead(200, { "content-type": "application/json" }).end(typeof answer === "string" ? answer : JSON.stringify(answer));
  });
  const port = await listenLocal(server);
  const endpoint = { host: "127.0.0.1", port, credential: PASSWORD };
  const urls = (): string[] => seen.map((request) => request.url).sort();
  try {
    answers["/api/info"] = { version: "2.4.1", pid: 1, urls: [] };
    assert.equal(await opencodeDriver.probeReady(endpoint), true);
    assert.deepEqual(seen.at(-1), { url: "/api/info", authorization: opencodeAuthorization(PASSWORD) });
    answers["/api/info"] = {};
    assert.equal(await opencodeDriver.probeReady(endpoint), false);
    answers["/api/info"] = 401;
    assert.equal(await opencodeDriver.probeReady(endpoint), false);

    // No session runs: the background jobs are asked for, and nothing more.
    answers["/api/session/active"] = { data: {} };
    answers["/api/experimental/job"] = { data: [] };
    seen.length = 0;
    assert.deepEqual(await opencodeDriver.fetchStatus(endpoint), { working: false, idleSinceMs: null });
    assert.deepEqual(urls(), ["/api/experimental/job", "/api/session/active"]);
    // A command a turn left running is work; a subagent's job is its session, which is not listed here.
    answers["/api/experimental/job"] = { data: [{ kind: "subagent", status: "running" }, { kind: "shell", status: "running" }] };
    assert.deepEqual(await opencodeDriver.fetchStatus(endpoint), { working: true, idleSinceMs: null });
    answers["/api/experimental/job"] = { data: [{ kind: "subagent", status: "running" }, { kind: "shell", status: "completed" }] };
    assert.deepEqual(await opencodeDriver.fetchStatus(endpoint), { working: false, idleSinceMs: null });
    answers["/api/experimental/job"] = { data: [] };

    // A turn runs.
    answers["/api/session/active"] = { data: { ses_a: { type: "running" } } };
    answers["/api/session/ses_a/permission"] = { data: [] };
    answers["/api/session/ses_a/form"] = { data: [] };
    seen.length = 0;
    assert.deepEqual(await opencodeDriver.fetchStatus(endpoint), { working: true, idleSinceMs: null });
    assert.deepEqual(urls(), ["/api/session/active", "/api/session/ses_a/form", "/api/session/ses_a/permission"]);
    assert.ok(seen.every((request) => request.authorization === opencodeAuthorization(PASSWORD)));

    // It waits for an approval, or for an answer to its question.
    answers["/api/session/ses_a/permission"] = { data: [{ id: "per_1", sessionID: "ses_a" }] };
    assert.deepEqual(await opencodeDriver.fetchStatus(endpoint), { working: false, idleSinceMs: null });
    answers["/api/session/ses_a/permission"] = { data: [] };
    answers["/api/session/ses_a/form"] = { data: [{ id: "frm_1", sessionID: "ses_a" }] };
    assert.deepEqual(await opencodeDriver.fetchStatus(endpoint), { working: false, idleSinceMs: null });

    // A subagent is a session of its own: while one session waits, another works.
    answers["/api/session/active"] = { data: { ses_a: { type: "running" }, ses_sub: { type: "running" } } };
    answers["/api/session/ses_sub/permission"] = { data: [] };
    answers["/api/session/ses_sub/form"] = { data: [] };
    assert.deepEqual(await opencodeDriver.fetchStatus(endpoint), { working: true, idleSinceMs: null });
    answers["/api/session/ses_sub/permission"] = { data: [{ id: "per_2", sessionID: "ses_sub" }] };
    assert.deepEqual(await opencodeDriver.fetchStatus(endpoint), { working: false, idleSinceMs: null }, "both wait for the person");

    // Any answer OpenCode owes leaves the state unknown, never "idle".
    const owed = [["/api/session/active", 500], ["/api/session/active", "<html>"], ["/api/session/active", {}], ["/api/session/ses_a/permission", 404], ["/api/session/ses_a/form", { error: "x" }], ["/api/experimental/job", 404], ["/api/experimental/job", {}]] as const;
    for (const [key, broken] of owed) {
      const before = answers[key];
      answers[key] = broken;
      assert.equal(await opencodeDriver.fetchStatus(endpoint), null, `${key}: ${JSON.stringify(broken)}`);
      answers[key] = before;
    }
    // ...but hides no work: a session that ended between two questions beside one that works, or beside a running job.
    answers["/api/session/ses_a/permission"] = 404;
    answers["/api/session/ses_sub/permission"] = { data: [] };
    assert.deepEqual(await opencodeDriver.fetchStatus(endpoint), { working: true, idleSinceMs: null });
    answers["/api/session/ses_sub/permission"] = { data: [{ id: "per_2", sessionID: "ses_sub" }] };
    answers["/api/experimental/job"] = { data: [{ kind: "shell", status: "running" }] };
    assert.deepEqual(await opencodeDriver.fetchStatus(endpoint), { working: true, idleSinceMs: null });
    answers["/api/experimental/job"] = { data: [] };

    // More sessions running than the check asks about: working, without asking.
    answers["/api/session/active"] = { data: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`ses_${index}`, { type: "running" }])) };
    seen.length = 0;
    assert.deepEqual(await opencodeDriver.fetchStatus(endpoint), { working: true, idleSinceMs: null });
    assert.deepEqual(urls(), ["/api/session/active"]);
  } finally {
    await closeServer(server);
  }
  assert.equal(await opencodeDriver.fetchStatus(endpoint), null, "connection refused");
  assert.equal(await opencodeDriver.probeReady(endpoint), false);
});
