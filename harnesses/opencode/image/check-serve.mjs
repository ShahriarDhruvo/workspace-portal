// Fails the image build when this OpenCode version no longer does what the portal relies on. The gateway changes none
// of OpenCode's files: it only gives it settings (../settings.ts) and talks to its API
// (../driver.ts), and an OpenCode that read either differently would start all the same, with
// another provider, its own web tools, or a status the gateway misreads. So this starts the real `opencode serve`
// once, with settings as the gateway renders them (check-settings.json; a gateway test keeps it that) and a stand-in
// for the gateway's service API, and checks each thing by name:
//   * it serves its page, and its API to nobody without OPENCODE_PASSWORD;
//   * /etc/opencode/opencode.json is read and wins over a person's and a project's own settings, under their older
//     names too: the one provider, its models and default, no fetching from the workspace;
//   * a turn asks the stand-in, with the placeholder key, the model's output limit and default effort, the search and
//     browser tools, the instructions file the settings name, and without OpenCode's own web tools;
//   * the routes of the gateway's status check answer as it reads them: a running turn, one that waits for an
//     approval, and a command left running in the background;
//   * a terminal's ticket and socket are given to requests without an Origin, as the gateway sends them;
//   * its native libraries are unpacked where the start script points it (BUN_TMPDIR).
// Run as: node check-serve.mjs check-settings.json, with env.sh's environment and without a network, as a Private
// workspace is without a route out. Nothing it writes stays in the image.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const MANAGED_SETTINGS = "/etc/opencode/opencode.json";
const INSTRUCTIONS = "The build check's instructions: answer in one word.";
const SERVICE_PLACEHOLDER = "http://service.invalid:4001";
const PASSWORD = "build-check-password";
const BASIC = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
const START_TIMEOUT_MS = 90_000;
const STEP_TIMEOUT_MS = 60_000;

class CheckError extends Error {}
/** `what`: what the portal needs, as a sentence that is false now. */
function expect(condition, what, seen) {
  if (!condition) throw new CheckError(seen === undefined ? what : `${what} (got ${typeof seen === "string" ? seen : JSON.stringify(seen)})`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now();
const passed = (what) => console.log(`check-serve: ${what} (${((Date.now() - startedAt) / 1000).toFixed(1)} s)`);
async function until(what, probe, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new CheckError(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const settingsText = fs.readFileSync(process.argv[2], "utf8");
const sample = JSON.parse(settingsText);
const [, modelId] = /^portal\/(.+)$/.exec(sample.model);
const model = sample.providers.portal.models[modelId];

// The stand-in for the gateway's service API: /mcp/search, and /llm/v1, whose model takes three steps in a turn. It
// holds its first answer back until `release`, then fetches a page with OpenCode's `execute` tool, then runs a shell
// command, which the project's own settings make OpenCode ask about. Asked to (BACKGROUND_PROMPT), it instead leaves
// a command running in the background and ends its turn.
const BACKGROUND_PROMPT = "Leave a command running in the background.";
const llmRequests = [];
let release;
const held = new Promise((resolve) => (release = resolve));
let serviceUrl = "";
const sse = (res, data) => res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
const chunk = (delta, finish = null) => ({ id: "chatcmpl-check", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] });
const toolCall = (name, args) => ({ tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
function mcpAnswer(message) {
  if (message.id === undefined) return null;
  const result = (value) => ({ jsonrpc: "2.0", id: message.id, result: value });
  if (message.method === "initialize") return result({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "search", version: "1.0.0" } });
  if (message.method === "tools/list") {
    return result({ tools: [{ name: "web_search", description: "Search the web.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] });
  }
  if (message.method === "ping") return result({});
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found." } };
}
const service = http.createServer((req, res) => {
  serve(req, res).catch((error) => {
    console.error(`check-serve: the stand-in service failed on ${req.method} ${req.url}: ${error?.message ?? error}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
async function serve(req, res) {
  let body = "";
  for await (const part of req) body += part;
  const message = body === "" ? null : JSON.parse(body);
  if (req.url === "/mcp/search") {
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST", "content-length": 0 }).end();
    const answers = [message].flat().map(mcpAnswer).filter(Boolean);
    if (answers.length === 0) return void res.writeHead(202, { "content-length": 0 }).end();
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(message) ? answers : answers[0]));
  }
  if (req.url === "/fetched") return void res.writeHead(200, { "content-type": "text/plain" }).end("fetched from the workspace");
  if (req.url !== "/llm/v1/chat/completions" || req.method !== "POST") return void res.writeHead(404).end();
  // The turn offers tools; the request that names the session offers none and is answered at once.
  const turn = (message.tools ?? []).length > 0;
  const results = message.messages.filter((entry) => entry.role === "tool");
  const background = message.messages.some((entry) => entry.role === "user" && JSON.stringify(entry.content).includes(BACKGROUND_PROMPT));
  llmRequests.push({ turn, background, step: results.length, authorization: req.headers.authorization, body: message });
  let call = null;
  if (turn && background) {
    if (results.length === 0) call = toolCall("shell", { command: "sleep 300", background: true });
  } else if (turn) {
    if (results.length === 0) {
      await held;
      call = toolCall("execute", { code: `const answer = await fetch(${JSON.stringify(`${serviceUrl}/fetched`)}); return await answer.text();` });
    } else if (results.length === 1) call = toolCall("shell", { command: "true" });
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sse(res, chunk({ role: "assistant", ...(call ?? { content: turn ? "Checked." : "Build check" }) }));
  sse(res, chunk({}, call === null ? "stop" : "tool_calls"));
  sse(res, { ...chunk({}), choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
  sse(res, "[DONE]");
  res.end();
}

let opencode = null;
let output = "";
let home = null;
let shutdown = async () => {};
async function main() {
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  serviceUrl = `http://127.0.0.1:${service.address().port}`;
  expect(settingsText.includes(SERVICE_PLACEHOLDER), `${process.argv[2]} names the service as ${SERVICE_PLACEHOLDER}`);
  fs.mkdirSync(path.dirname(MANAGED_SETTINGS), { recursive: true });
  fs.writeFileSync(MANAGED_SETTINGS, settingsText.replaceAll(SERVICE_PLACEHOLDER, serviceUrl));
  expect(sample.instructions?.length === 1 && path.dirname(sample.instructions[0]) === path.dirname(MANAGED_SETTINGS), `${process.argv[2]} names one instructions file, beside ${MANAGED_SETTINGS}`, sample.instructions);
  fs.writeFileSync(sample.instructions[0], `${INSTRUCTIONS}\n`);

  // Not under /tmp, which may be noexec here as it is in a workspace: OpenCode loads its native libraries from BUN_TMPDIR.
  home = fs.mkdtempSync("/var/tmp/opencode-check-");
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  // A person's own settings and a project's must not undo the managed ones, under the older names OpenCode still
  // reads either, nor move its server; a rule for another tool (the shell) is theirs to make.
  const own = JSON.stringify({
    share: "auto",
    update: "auto",
    model: "opencode/big-pickle",
    websearch: { provider: "random" },
    policies: [
      { action: "provider.use", resource: "*", effect: "allow" },
      { action: "websearch.use", resource: "*", effect: "allow" },
    ],
    permissions: [
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "ask" },
    ],
    autoshare: true,
    autoupdate: true,
    enabled_providers: ["opencode"],
    permission: { webfetch: "allow" },
    tools: { webfetch: true, websearch: true },
    server: { port: 1, hostname: "0.0.0.0" },
  });
  fs.mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
  for (const file of [path.join(home, ".config/opencode/opencode.json"), path.join(project, "opencode.json")]) fs.writeFileSync(file, own);
  const env = { ...process.env, HOME: home, BUN_TMPDIR: path.join(home, "native"), OPENCODE_PASSWORD: PASSWORD, PORTAL_LLM_KEY: "portal" };
  fs.mkdirSync(env.BUN_TMPDIR);
  const version = spawnSync("opencode", ["--version"], { env, encoding: "utf8", timeout: STEP_TIMEOUT_MS });
  console.log(`check-serve: ${version.stdout?.trim() || "?"}`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  opencode = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let exited = false;
  opencode.on("exit", () => (exited = true));
  opencode.on("error", (error) => {
    exited = true;
    output += `\n${error.message}`;
  });
  for (const stream of [opencode.stdout, opencode.stderr]) stream.on("data", (data) => (output = (output + data).slice(-4000)));

  // A request as the gateway sends one: plain HTTP with the password, and none of the headers a browser adds (the
  // gateway passes on no Origin and no Sec-Fetch-*).
  const api = (method, target, { body, headers = {}, authorization = BASIC, timeoutMs = STEP_TIMEOUT_MS } = {}) =>
    new Promise((resolve, reject) => {
      const sent = { ...(authorization === null ? {} : { authorization }), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers };
      const request = http.request(`${base}${target}`, { method, headers: sent, agent: false, timeout: timeoutMs }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (part) => (text += part));
        response.on("error", reject);
        response.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON: `json` stays null
          }
          resolve({ status: response.statusCode, type: response.headers["content-type"] ?? "", json, text: text.slice(0, 300) });
        });
      });
      request.on("timeout", () => request.destroy(new Error(`${method} ${target} was not answered within ${timeoutMs} ms`)));
      request.on("error", reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  // The terminals OpenCode's page opens are kept by a helper that outlives `opencode serve`.
  shutdown = () => api("POST", "/api/experimental/persistent-pty/shutdown", { timeoutMs: 5000 }).catch(() => {});

  // Sign-in.
  await until(
    "`opencode serve` to answer GET /api/info with its version",
    async () => {
      if (exited) throw new CheckError("`opencode serve` exited");
      // A request that arrives while OpenCode is still starting may never be answered: ask again soon, as the gateway does.
      return api("GET", "/api/info", { timeoutMs: 2000 }).then((answer) => typeof answer.json?.version === "string", () => false);
    },
    START_TIMEOUT_MS,
  );
  const page = await api("GET", "/");
  expect(page.status === 200 && page.type.startsWith("text/html"), "GET / is OpenCode's page", { status: page.status, type: page.type });
  passed("it serves, wherever a person's settings would put its server");
  for (const [who, authorization] of [["nobody", null], ["another password", `Basic ${Buffer.from("opencode:wrong").toString("base64")}`]]) {
    for (const target of ["/api/info", "/api/session/active", "/api/session"]) {
      const { status } = await api("GET", target, { authorization });
      expect(status === 401, `OPENCODE_PASSWORD protects ${target}: ${who} gets a 401`, status);
    }
  }
  passed("its password protects its API");

  // The managed settings, over a person's and the project's. While OpenCode loads a folder its list of providers is
  // not the settings' yet: empty, then for a moment its own hosted provider.
  const providerIds = async () => {
    const answer = (await api("GET", "/api/provider")).json?.data;
    return Array.isArray(answer) ? answer.map((provider) => provider.id) : [];
  };
  const offered = await until("GET /api/provider to list the settings' provider", async () => {
    const ids = await providerIds();
    return ids.includes("portal") ? ids : null;
  });
  expect(JSON.stringify(offered) === '["portal"]', "the managed `policies` leave the portal's provider and no other, whatever a person's or a project's own allow", offered);
  // GET /api/config lists the settings OpenCode read, from the weakest to the strongest.
  const sources = (await api("GET", "/api/config")).json;
  const documents = Array.isArray(sources) ? sources.filter((source) => source?.type === "document") : [];
  const managed = documents.filter((source) => source.path === MANAGED_SETTINGS).map((source) => source.info ?? {});
  expect(managed.length > 0, `GET /api/config lists ${MANAGED_SETTINGS} among the settings it read`, sources);
  const read = Object.assign({}, ...managed);
  expect(read.update === "disable" && read.share === "disabled", "the managed `update` and `share` are read as written", { update: read.update, share: read.share });
  expect(Array.isArray(read.policies) && read.policies.length === sample.policies.length, "the managed `policies` are read as written", read.policies);
  const paths = documents.map((source) => source.path);
  expect(paths.at(-1) === MANAGED_SETTINGS && paths.length > managed.length, "the managed settings are the strongest: the last of those GET /api/config lists, after a person's and a project's", paths);
  const models = (await api("GET", "/api/model")).json?.data;
  const offeredModels = Array.isArray(models) ? models.map((entry) => `${entry.providerID}/${entry.id}`).sort() : models;
  const wanted = Object.keys(sample.providers.portal.models).map((id) => `portal/${id}`).sort();
  expect(JSON.stringify(offeredModels) === JSON.stringify(wanted), "the provider offers the settings' models and there is no other model", offeredModels);
  const defaultModel = (await api("GET", "/api/model/default")).json?.data;
  expect(defaultModel?.providerID === "portal" && defaultModel?.id === modelId, "the managed `model` is the default model, whatever a person or a project names", { providerID: defaultModel?.providerID, id: defaultModel?.id });
  const efforts = (models.find((entry) => entry.id === modelId)?.variants ?? []).map((variant) => variant.id);
  expect(JSON.stringify(efforts) === JSON.stringify(model.capabilities.reasoning.effort), "a model's efforts are its variants", efforts);
  passed("the managed settings win");

  // The turn's tools are also the MCP servers': on a slow machine they are still connecting now. (Should this route
  // change, nothing waits here, and the tools the turn offers are checked below all the same.)
  await until("the MCP servers of the settings to connect (GET /api/mcp)", async () => {
    const servers = (await api("GET", "/api/mcp")).json?.data;
    if (!Array.isArray(servers)) return true;
    return Object.keys(sample.mcp.servers).every((name) => servers.some((server) => server?.name === name && server.status?.status === "connected"));
  });

  // A turn, held back by the stand-in while the status routes are read.
  const session = (await api("POST", "/api/session", { body: { location: { directory: project } } })).json?.data;
  expect(typeof session?.id === "string", "POST /api/session creates a session with an id", session);
  const prompted = await api("POST", `/api/session/${session.id}/prompt`, { body: { text: "Say that the check passed." } });
  expect(prompted.status === 200, "POST /api/session/<id>/prompt starts a turn", prompted);
  const turn = await until("the turn's request to <service>/llm/v1/chat/completions", async () => {
    if (exited) throw new CheckError("`opencode serve` exited");
    return llmRequests.find((request) => request.turn);
  });
  expect(turn.authorization === "Bearer portal", "the provider's key is the value of PORTAL_LLM_KEY (`env`)", turn.authorization);
  expect(turn.body.model === modelId, "the request names the default model", turn.body.model);
  expect(turn.body.max_tokens === model.limit.output, `the request asks for the model's output limit, ${model.limit.output} tokens, as max_tokens (compatibility.maxTokensField)`, { max_tokens: turn.body.max_tokens, max_completion_tokens: turn.body.max_completion_tokens });
  expect(turn.body.reasoning_effort === model.settings.reasoningEffort, `the request carries the model's default effort, ${model.settings.reasoningEffort}`, turn.body.reasoning_effort);
  const tools = turn.body.tools.map((tool) => tool.function?.name);
  expect(!tools.some((name) => /^web_?(fetch|search)$/i.test(name)), "OpenCode's own webfetch and websearch tools are not offered", tools);
  expect(tools.includes("search_web_search"), "the search MCP server's tools are offered by name (search_web_search; codemode false)", tools);
  expect(tools.some((name) => name.startsWith("browser_")), "the browser MCP server's tools are offered by name (browser_*)", tools);
  expect(tools.includes("execute") && tools.includes("shell"), "OpenCode offers its `execute` and `shell` tools, which the rest of this check uses", tools);
  const told = JSON.stringify(turn.body.messages).split(INSTRUCTIONS).length - 1;
  expect(told === 1, "the request carries the text of the managed `instructions` file, once", told);
  passed("a turn asks the service as the portal needs it to");

  const running = async () => (await api("GET", "/api/session/active")).json;
  const pending = async (kind, id = session.id) => (await api("GET", `/api/session/${id}/${kind}`)).json;
  const jobs = async () => (await api("GET", "/api/experimental/job")).json;
  await until("GET /api/session/active to list the running turn as {data: {<session id>: …}}", async () => Boolean((await running())?.data?.[session.id]));
  for (const kind of ["permission", "form"]) {
    const answer = await pending(kind);
    expect(Array.isArray(answer?.data) && answer.data.length === 0, `GET /api/session/<id>/${kind} answers {data: []} while nothing waits for the person`, answer);
  }
  const idleJobs = await jobs();
  expect(Array.isArray(idleJobs?.data) && idleJobs.data.length === 0, "GET /api/experimental/job answers {data: []} while nothing runs in the background", idleJobs);
  release();

  // The model fetches a page with `execute`, which the managed settings forbid, then runs a command the project's
  // settings ask about.
  const afterFetch = await until("the turn's request that follows its `execute` call", async () => {
    if (exited) throw new CheckError("`opencode serve` exited");
    return llmRequests.find((request) => request.turn && request.step === 1);
  });
  const fetched = JSON.stringify(afterFetch.body.messages.filter((entry) => entry.role === "tool").at(-1)?.content ?? null);
  expect(!fetched.includes("fetched from the workspace") && /denied/i.test(fetched), "the managed `permissions` deny webfetch, the `fetch` of `execute` included, whatever a person or a project allows", fetched.slice(0, 300));
  const asked = await until("GET /api/session/<id>/permission to list the approval the turn waits for", async () => {
    const answer = await pending("permission");
    return answer?.data?.length > 0 ? answer.data : null;
  });
  expect(asked[0]?.sessionID === session.id && asked[0]?.action === "shell", "a pending approval names its session and action", asked[0]);
  const interrupted = await api("POST", `/api/session/${session.id}/interrupt`);
  expect(interrupted.status === 200, "POST /api/session/<id>/interrupt stops the turn", interrupted);
  const ended = (id) => async () => {
    const answer = await running();
    return answer?.data && !(id in answer.data);
  };
  await until("GET /api/session/active to leave out the stopped turn", ended(session.id));

  // A turn that leaves a command running in the background and ends: the command is a job, listed as running.
  const second = (await api("POST", "/api/session", { body: { location: { directory: project } } })).json?.data;
  expect(typeof second?.id === "string", "POST /api/session creates a second session", second);
  await api("POST", `/api/session/${second.id}/prompt`, { body: { text: BACKGROUND_PROMPT } });
  const approval = await until("the approval of the background command", async () => (await pending("permission", second.id))?.data?.[0]);
  const approved = await api("POST", `/api/session/${second.id}/permission/${approval.id}/reply`, { body: { decision: "once" } });
  expect(approved.status === 204, "POST /api/session/<id>/permission/<request>/reply approves a command", approved);
  await until("the turn that started the background command to end", async () => llmRequests.some((request) => request.background && request.step === 1) && (await ended(second.id)()));
  const left = (await jobs())?.data;
  const job = Array.isArray(left) ? left.find((entry) => entry?.sessionID === second.id) : undefined;
  expect(job?.kind === "shell" && job.status === "running", "GET /api/experimental/job lists a command left running in the background as {kind: \"shell\", status: \"running\"}", left);
  await api("POST", `/api/experimental/job/${job.id}/cancel`).catch(() => {});
  passed("the status routes answer as the gateway reads them");
  const settled = await providerIds();
  expect(JSON.stringify(settled) === '["portal"]', "the portal's provider is still the only one after a turn", settled);

  // A terminal, as OpenCode's page opens one and the gateway forwards its requests: the password, and no Origin.
  const terminal = (await api("POST", `/api/experimental/session/${session.id}/terminal`, { body: { args: [], title: "check", env: {}, cwd: project } })).json?.data;
  expect(typeof terminal?.id === "string", "POST /api/experimental/session/<id>/terminal opens a terminal", terminal);
  const ticket = (await api("POST", `/api/experimental/persistent-pty/${terminal.id}/connect-token`, { headers: { "x-opencode-ticket": "1" } })).json?.data;
  expect(typeof ticket?.ticket === "string", "POST /api/experimental/persistent-pty/<id>/connect-token gives a ticket to a request without an Origin", ticket);
  const upgraded = await new Promise((resolve) => {
    const request = http.request(`${base}/api/experimental/persistent-pty/${terminal.id}/connect?ticket=${encodeURIComponent(ticket.ticket)}`, {
      headers: { authorization: BASIC, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": crypto.randomBytes(16).toString("base64") },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", (error) => resolve(error.message));
    request.setTimeout(STEP_TIMEOUT_MS, () => request.destroy(new Error("timed out")));
    request.end();
  });
  expect(upgraded === 101, "GET /api/experimental/persistent-pty/<id>/connect accepts a WebSocket with the password, its ticket and no Origin", upgraded);
  passed("a terminal opens as the gateway opens one");

  // /tmp forbids execution in a workspace, so start.sh points OpenCode at a folder that allows it.
  const unpacked = fs.readdirSync(env.BUN_TMPDIR);
  expect(unpacked.some((name) => /\.(?:so|node)$/.test(name)), "OpenCode unpacks its native libraries into BUN_TMPDIR", unpacked);
  passed("its native libraries are where the start script expects them");
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  const reason = error instanceof CheckError ? error.message : (error?.stack ?? String(error));
  // The reason goes last: a failed build's error is its step's last lines of output.
  if (output !== "") console.error(`--- the end of opencode's output\n${output}\n---`);
  console.error(`check-serve: this OpenCode version does not fit the portal: ${reason}`);
} finally {
  release();
  await shutdown();
  if (opencode !== null && opencode.exitCode === null && opencode.signalCode === null) {
    const gone = new Promise((resolve) => opencode.once("exit", resolve));
    opencode.kill("SIGTERM");
    const killed = setTimeout(() => opencode.kill("SIGKILL"), 5000);
    await gone;
    clearTimeout(killed);
  }
  service.closeAllConnections();
  service.close();
  fs.rmSync(MANAGED_SETTINGS, { force: true });
  // Retried: a process OpenCode started may still be writing there as it ends.
  if (home !== null) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  // The browser MCP server's output folder, should it have made it.
  fs.rmSync("/workspace/.browser", { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
