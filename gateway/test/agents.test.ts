// The choice of agent: which one a start runs, one at a time per workspace, and how the control
// API and the agent ports present it. Uses the same in-process gateway as integration.test.ts with
// both agents enabled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaces } from "@portal/db";
import { eq } from "drizzle-orm";
import { json, MIN, startGateway, type Gateway, type GatewayOptions } from "./harness.ts";
import { driverFor } from "../src/agents/index.ts";
import { WorkspaceManager, type WorkspaceInfo } from "../src/workspaces.ts";

const BOTH = { env: { WORKSPACE_AGENTS: "qwen,dsh" } } satisfies GatewayOptions;

async function withGateway(options: GatewayOptions, run: (gateway: Gateway) => Promise<void>): Promise<void> {
  const gateway = await startGateway(options);
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
}

const start = (g: Gateway, userId: number, body?: unknown) => g.control("POST", `/control/workspaces/${userId}/start`, body);

test("GET /control/agents lists the enabled agents in display order, with their versions", () =>
  withGateway({ env: { WORKSPACE_AGENTS: "dsh, qwen", DSH_VERSION: "0.2.3", QWEN_CODE_VERSION: "0.28.0" } }, async (g) => {
    assert.deepEqual(json(await g.control("GET", "/control/agents")), {
      agents: [
        { id: "dsh", name: "DeepSeek Harness", description: driverFor("dsh").description, version: "0.2.3" },
        { id: "qwen", name: "Qwen Code", description: driverFor("qwen").description, version: "0.28.0" },
      ],
    });
  }));

test("a fresh workspace with two agents needs a choice; the choice is remembered for later starts", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    const refused = await start(g, alice);
    assert.equal(refused.status, 400);
    assert.equal(json<{ error: string }>(refused).error, "agent_required");
    assert.equal(g.runtime.starts.length, 0);

    // The agent port doesn't guess either: it sends the user to the portal to choose.
    const page = await g.navigate(g.tokens.alice, alice);
    assert.equal(page.status, 503);
    assert.ok(page.body.includes("Choose an agent"), page.body);
    assert.equal(g.runtime.starts.length, 0);

    const started = json<WorkspaceInfo>(await start(g, alice, { agent: "qwen" }));
    assert.equal(started.agent, "qwen");
    assert.equal(g.runtime.startsFor(alice)[0]!.options.agent, "qwen");
    await g.waitReady(alice);
    assert.equal(g.workspaceRow(alice)?.agent, "qwen", "persisted");
    assert.deepEqual(g.auditActions(alice).find((entry) => entry.action === "workspace_started")?.details, { agent: "qwen" });

    await g.manager.stop(alice, "user");
    assert.equal(g.info(alice).agent, "qwen", "a stopped workspace still names the agent it ran last");
    // Without a choice, the next start (a page load on the agent port, or the portal) runs the same agent.
    const reload = await g.navigate(g.tokens.alice, alice);
    assert.ok(reload.body.includes("Starting your workspace"), reload.body);
    await g.waitReady(alice);
    assert.equal(g.runtime.startsFor(alice).at(-1)!.options.agent, "qwen");
  }));

test("one agent at a time: asking for the other one while it runs is refused, the same one is fine", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "qwen");
    const mismatch = await start(g, alice, { agent: "dsh" });
    assert.equal(mismatch.status, 409);
    assert.deepEqual(json(mismatch), { error: "agent_mismatch", message: "Qwen Code is already running in this workspace. Stop it to switch." });
    assert.equal(g.runtime.startsFor(alice).length, 1, "nothing else was started");
    assert.equal(g.runtime.runningUsers().length, 1);

    for (const body of [{ agent: "qwen" }, undefined, {}]) {
      const same = await start(g, alice, body);
      assert.equal(same.status, 200, JSON.stringify(body));
      assert.equal(json<WorkspaceInfo>(same).agent, "qwen");
    }
    assert.equal(g.runtime.startsFor(alice).length, 1);

    // While it is still starting, too.
    const { bob } = g.ids;
    const attempt = g.manager.requestStart(bob, "qwen");
    assert.ok(attempt.ok);
    const during = g.manager.requestStart(bob, "dsh");
    assert.equal(during.ok, false);
    assert.equal(!during.ok && during.error.name, "AgentMismatchError");
    await attempt.done;
  }));

test("start body validation: unknown and disabled agents", () =>
  withGateway({ env: { WORKSPACE_AGENTS: "qwen" } }, async (g) => {
    const { alice } = g.ids;
    for (const [body, code] of [
      [{ agent: "claude" }, "unknown_agent"],
      [{ agent: 1 }, "unknown_agent"],
      [{ agent: "dsh" }, "agent_unavailable"],
      [[], "bad_request"],
      ["qwen", "bad_request"],
    ] as const) {
      const reply = await start(g, alice, body);
      assert.equal(reply.status, 400, JSON.stringify(body));
      assert.equal(json<{ error: string }>(reply).error, code, JSON.stringify(body));
    }
    assert.equal(g.runtime.starts.length, 0);

    // With a single agent, a start without a choice runs it.
    const started = json<WorkspaceInfo>(await start(g, alice));
    assert.equal(started.agent, "qwen");
  }));

test("an agent that was disabled after its last run needs a new choice", () =>
  withGateway({ env: { WORKSPACE_AGENTS: "qwen" } }, async (g) => {
    const { alice } = g.ids;
    // A workspace that last ran dsh, on an install that now only offers Qwen Code (read at boot).
    g.db.insert(workspaces).values({ userId: alice, status: "stopped", agent: "dsh", updatedAt: Date.now() }).run();
    g.manager.shutdown();
    const restarted = new WorkspaceManager({ config: g.config, db: g.db, runtime: g.runtime, llm: g.llmQueue, connections: g.connections, log: g.log, now: () => g.clock.now });
    await restarted.init();
    g.useManager(restarted);

    assert.equal(g.info(alice).agent, "dsh");
    const reply = await start(g, alice);
    assert.equal(reply.status, 400);
    assert.equal(json<{ error: string }>(reply).error, "agent_unavailable");
    assert.equal(json<WorkspaceInfo>(await start(g, alice, { agent: "qwen" })).agent, "qwen");
  }));

test("the user may stop their own workspace (reason \"user\"), e.g. to switch agents", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "qwen");
    const stopped = json<WorkspaceInfo>(await g.control("POST", `/control/workspaces/${alice}/stop`, { reason: "user", actorUserId: alice }));
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.stopReason, "user");
    assert.equal(g.workspaceRow(alice)?.stopReason, "user");
    assert.equal(g.db.select().from(workspaces).where(eq(workspaces.userId, alice)).get()?.agent, "qwen");
  }));

// ------------------------------------------------------------------ DeepSeek Harness

test("a DeepSeek Harness workspace: its own image, credential and settings, the same sandbox paths", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "dsh");
    const [record] = g.runtime.startsFor(alice);
    assert.equal(record!.options.agent, "dsh");
    assert.match(record!.options.credential, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(g.runtime.dshFor(alice).secret, record!.options.credential);
    assert.deepEqual(Object.keys(record!.files), ["portal.patch.yml"]);

    // The patch: models from Qwen Code's system-defaults.json, all through the gateway, plus search.
    const patch = record!.files["portal.patch.yml"]!;
    const rows = JSON.parse(patch.replace(/^#.*\n/gm, "")) as Array<Record<string, any>>;
    const service = `http://${g.config.workspace.gatewayIp}:${g.config.servicePort}`;
    const provider = rows.find((row) => row.id === "llm-pi-ai")!.config.providers.portal;
    assert.equal(provider.baseURL, `${service}/llm/v1`);
    assert.equal(provider.apiKeyEnv, "PORTAL_LLM_KEY");
    assert.deepEqual(provider.models.map((model: { id: string }) => model.id), ["qwen3.8-flash-next"]);
    assert.deepEqual(rows.find((row) => row.id === "agent-default-model")!.config, { provider: "portal", model: "qwen3.8-flash-next" });
    const inserted = rows.find((row) => "insert" in row)!.insert as Array<{ id: string; config: { url?: string } }>;
    assert.equal(inserted.find((server) => server.id === "mcp-search")!.config.url, `${service}/mcp/search`);
    assert.ok(inserted.some((server) => server.id === "mcp-browser"));
    assert.equal(g.info(alice).agent, "dsh");
  }));

test("dsh: the gateway mints the cookie and presents dsh's loopback Host; no portal cookie or token goes upstream", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "dsh");
    const dsh = g.runtime.dshFor(alice);

    const page = await g.navigate(g.tokens.alice, alice);
    assert.equal(page.status, 200, page.body);
    assert.ok(page.body.includes("DeepSeek Harness"));
    assert.equal(page.headers["set-cookie"], undefined, "dsh's own cookies never reach the browser");
    const seen = dsh.requests.at(-1)!;
    assert.equal(seen.status, 200, "dsh accepted the minted cookie");
    assert.equal(seen.headers.host, "localhost:3080");
    assert.ok(!String(seen.headers.cookie).includes("portal_session"), "the portal session never reaches the workspace");
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(seen.headers["sec-fetch-site"], undefined);

    // An API call from the page: no bearer token needed (cookie agent), Origin rewritten to dsh's own.
    const api = await g.xhr(g.tokens.alice, alice, { method: "POST", path: "/api/session/create", bearer: null, body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(api.status, 200, api.body);
    assert.equal(dsh.requests.at(-1)!.headers.origin, "http://localhost:3080");
    // A token that is presented must still be the right one.
    assert.equal((await g.xhr(g.tokens.alice, alice, { bearer: "wrong" })).status, 401);
    // The cookie agent is still only this user's: another user's session gets nothing.
    assert.equal((await g.navigate(g.tokens.bob, alice)).status, 403);
    // A foreign Origin is refused before anything reaches dsh.
    const before = dsh.requests.length;
    const cross = await g.xhr(g.tokens.alice, alice, { method: "POST", path: "/api/session/create", bearer: null, headers: { origin: "http://evil.example" } });
    assert.equal(cross.status, 403);
    assert.equal(dsh.requests.length, before);
  }));

test("dsh: pairing, OAuth and open-in-app are refused in any spelling", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "dsh");
    const dsh = g.runtime.dshFor(alice);
    const before = dsh.requests.length;
    for (const path of ["/connect", "/connect?code=1", "/CONNECT", "/%63onnect", "//connect", "/x/../connect", "/oauth/callback?code=1", "/open-in-app/vscode", "/open-in-app%2Fvscode"]) {
      const reply = await g.xhr(g.tokens.alice, alice, { path, bearer: null });
      assert.equal(reply.status, 403, path);
    }
    assert.equal(dsh.requests.length, before, "none reached dsh");
    // Qwen Code's blocked paths are not dsh's business.
    assert.equal((await g.xhr(g.tokens.alice, alice, { path: "/web-shell/pairing", bearer: null })).status, 404);
  }));

test("dsh: only its own socket path, authorised by the session alone, with the minted cookie upstream", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "dsh");
    const dsh = g.runtime.dshFor(alice);

    const open = await g.openSocket(g.tokens.alice, alice, { path: "/api/remote.mux", protocols: [] });
    assert.ok("socket" in open, JSON.stringify(open));
    assert.equal((await open.next()).data.toString(), "hello from dsh");
    open.socket.send("ping");
    assert.equal((await open.next()).data.toString(), "ping");
    const handshake = dsh.sockets.filter((recorded) => !recorded.probe).at(-1)!;
    assert.equal(handshake.headers.host, "localhost:3080");
    assert.equal(handshake.headers.origin, "http://localhost:3080");
    assert.ok(!String(handshake.headers.cookie).includes("portal_session"));
    open.socket.close();

    for (const path of ["/terminal", "/acp", "/api/other"]) {
      const refused = await g.openSocket(g.tokens.alice, alice, { path, protocols: [] });
      assert.deepEqual(refused, { status: 404 }, path);
    }
    assert.deepEqual(await g.openSocket(null, alice, { path: "/api/remote.mux", protocols: [] }), { status: 401 });
    assert.deepEqual(await g.openSocket(g.tokens.bob, alice, { path: "/api/remote.mux", protocols: [] }), { status: 403 });
  }));

test("dsh: ready once its session API answers; a running turn or background job keeps the workspace up, an unanswered approval doesn't", () =>
  withGateway({ ...BOTH, readyAfterMs: 300 }, async (g) => {
    const { alice } = g.ids;
    await g.manager.start(alice, "dsh");
    assert.equal(g.info(alice).ready, false);
    await g.waitReady(alice);
    const dsh = g.runtime.dshFor(alice);

    dsh.sessions = [{ id: "a", running: false }, { id: "b", running: true }];
    await g.manager.refreshSamples();
    assert.deepEqual([g.info(alice).busy, g.info(alice).busyReason], [true, "task"]);
    g.clock.now += 45 * MIN;
    await g.manager.refreshSamples();
    await g.manager.reap();
    assert.equal(g.info(alice).status, "running", "never stopped while a dsh session runs");

    // A background job outlives the turn that started it; dsh's session list doesn't show it.
    dsh.sessions = [{ id: "a", running: false }, { id: "b", running: false }];
    dsh.jobs = [{ owner: "b", status: "running" }];
    await g.manager.refreshSamples();
    assert.deepEqual([g.info(alice).busy, g.info(alice).busyReason], [true, "task"]);
    assert.ok(dsh.jobCalls >= 2, "both sessions' jobs were checked");
    const probe = dsh.sockets.find((recorded) => recorded.probe)!;
    assert.equal(probe.headers.host, "localhost:3080");
    assert.match(String(probe.headers.cookie), /^dsh-auth-/);

    dsh.jobs = [{ owner: "b", status: "exited" }];
    await g.manager.refreshSamples();
    assert.equal(g.info(alice).busy, false);

    // A turn waiting for an approval nobody gives is not work (dsh never times it out).
    dsh.sessions = [{ id: "a", running: false }, { id: "b", running: true, pendingInput: ["approval"] }];
    await g.manager.refreshSamples();
    assert.equal(g.info(alice).busy, false);
    g.clock.now += 31 * MIN;
    await g.manager.reap();
    assert.equal(g.info(alice).status, "stopped");
    assert.equal(g.info(alice).stopReason, "idle");
  }));

test("switching agents: stop Qwen Code, start DeepSeek Harness on the same files", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "qwen");
    const qwenContainer = g.runtime.containerFor(alice).id;
    await g.control("POST", `/control/workspaces/${alice}/stop`, { reason: "user", actorUserId: alice });
    assert.equal(g.runtime.containers.has(qwenContainer), false);
    const started = json<WorkspaceInfo>(await start(g, alice, { agent: "dsh" }));
    assert.equal(started.agent, "dsh");
    await g.waitReady(alice);
    assert.equal(g.runtime.runningUsers().length, 1, "one container per user, whichever agent");
    assert.deepEqual(g.runtime.startsFor(alice).map((record) => record.options.agent), ["qwen", "dsh"]);
    assert.equal((await g.navigate(g.tokens.alice, alice)).status, 200);
    assert.deepEqual(g.auditActions(alice).filter((entry) => entry.action === "workspace_started").map((entry) => entry.details), [{ agent: "qwen" }, { agent: "dsh" }]);
  }));

test("after a gateway restart a running dsh container is adopted with its secret", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "dsh");
    const secret = g.runtime.dshFor(alice).secret;
    g.manager.shutdown();
    const restarted = new WorkspaceManager({ config: g.config, db: g.db, runtime: g.runtime, llm: g.llmQueue, connections: g.connections, log: g.log, now: () => g.clock.now });
    await restarted.init();
    g.useManager(restarted);
    await g.waitReady(alice);
    assert.equal(g.runtime.startsFor(alice).length, 1, "adopted, not restarted");
    assert.equal(restarted.upstream(alice)?.agent, "dsh");
    assert.equal(restarted.upstream(alice)?.credential, secret);
    assert.equal((await g.navigate(g.tokens.alice, alice)).status, 200);
  }));
