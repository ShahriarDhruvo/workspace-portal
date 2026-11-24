// Which agent a start runs (the user's choice from Settings), one at a time per workspace, and how
// the control API and the agent ports present it. Uses the same in-process gateway as integration.test.ts with
// more than one agent enabled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { users, workspaces, type WorkspaceInfo } from "@portal/core";
import { eq } from "drizzle-orm";
import { ALL, BOTH, cookie, json, MIN, request, upgradeStatus, withGateway, type Gateway } from "./harness.ts";
import { driverFor } from "../src/agents/index.ts";
import { workspaceImage } from "../src/docker/image-names.ts";

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

test("GET /control/models lists the admin's model ids", () =>
  withGateway({}, async (g) => {
    assert.deepEqual(json(await g.control("GET", "/control/models")), { models: ["qwen3.8-flash-next"] });
  }));

test("a start without an agent runs the user's choice from Settings, else the first enabled agent", () =>
  withGateway(BOTH, async (g) => {
    const { alice, bob } = g.ids;
    // No choice saved: the install's default, the first of WORKSPACE_AGENTS.
    const started = json<WorkspaceInfo>(await start(g, alice));
    assert.equal(started.agent, "qwen");
    assert.equal(g.runtime.startsFor(alice)[0]!.options.agent, "qwen");
    await g.waitReady(alice);
    assert.equal(g.workspaceRow(alice)?.agent, "qwen", "persisted");
    assert.deepEqual(g.auditActions(alice).find((entry) => entry.action === "workspace_started")?.details, { agent: "qwen", version: "0.27.0", kind: "private" });

    // A saved choice wins, on the control API and on the agent port's "Try again" alike (a page load starts nothing).
    g.db.update(users).set({ agent: "dsh" }).where(eq(users.id, bob)).run();
    const page = await g.navigate(g.tokens.bob, bob);
    assert.ok(page.body.includes("Your Private workspace is stopped"), page.body);
    assert.equal(g.runtime.startsFor(bob).length, 0);
    const retry = await request(g.agentPort(bob), {
      method: "POST",
      path: "/__portal/start",
      headers: { cookie: cookie(g.tokens.bob), origin: g.agentOrigin(bob), "sec-fetch-site": "same-origin" },
    });
    assert.equal(retry.status, 303);
    await g.waitReady(bob);
    assert.equal(g.runtime.startsFor(bob)[0]!.options.agent, "dsh");

    // Changing the choice applies from the next start; a start without an agent attaches to what runs.
    g.db.update(users).set({ agent: "dsh" }).where(eq(users.id, alice)).run();
    assert.equal(json<WorkspaceInfo>(await start(g, alice)).agent, "qwen");
    await g.manager.stop(alice, "user");
    assert.equal(json<WorkspaceInfo>(await start(g, alice)).agent, "dsh");
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
    const attempt = g.manager.requestStart(bob, { agent: "qwen" });
    assert.ok(attempt.ok);
    const during = g.manager.requestStart(bob, { agent: "dsh" });
    assert.equal(during.ok, false);
    assert.equal(!during.ok && during.error.code, "agent_mismatch");
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

test("a saved choice that is no longer enabled falls back to the first enabled agent", () =>
  withGateway({ env: { WORKSPACE_AGENTS: "qwen" } }, async (g) => {
    const { alice } = g.ids;
    g.db.update(users).set({ agent: "dsh" }).where(eq(users.id, alice)).run();
    g.db.insert(workspaces).values({ userId: alice, status: "stopped", agent: "dsh", updatedAt: Date.now() }).run();
    await g.restart();

    assert.equal(g.info(alice).agent, "dsh", "the last run is still reported");
    assert.equal(json<WorkspaceInfo>(await start(g, alice)).agent, "qwen");
    // Naming a disabled agent explicitly is still refused.
    await g.manager.stop(alice, "user");
    const reply = await start(g, alice, { agent: "dsh" });
    assert.equal(reply.status, 400);
    assert.equal(json<{ error: string }>(reply).error, "agent_unavailable");
  }));

test("the user may stop their own workspace (reason \"user\")", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "qwen");
    const stopped = json<WorkspaceInfo>(await g.control("POST", `/control/workspaces/${alice}/stop`, { reason: "user", actorUserId: alice }));
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.stopReason, "user");
    assert.equal(g.workspaceRow(alice)?.stopReason, "user");
    assert.equal(g.db.select().from(workspaces).where(eq(workspaces.userId, alice)).get()?.agent, "qwen");
  }));

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
    const service = `http://${g.config.workspace.kinds.private.gatewayIp}:${g.config.servicePort}`;
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
    for (const path of ["/connect", "/connect?code=1", "/CONNECT", "/%63onnect", "//connect", "/x/../connect", "/oauth/callback?code=1", "/open-in-app/vscode", "/open-in-app%2Fvscode", "/%ff/../%63onnect"]) {
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
    await g.manager.start(alice, { agent: "dsh" });
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
    assert.deepEqual(g.auditActions(alice).filter((entry) => entry.action === "workspace_started").map((entry) => entry.details), [
      { agent: "qwen", version: "0.27.0", kind: "private" },
      { agent: "dsh", version: "0.2.2-rc.1", kind: "private" },
    ]);
  }));

test("after a gateway restart a running dsh container is adopted with its secret", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "dsh");
    const secret = g.runtime.dshFor(alice).secret;
    const restarted = await g.restart();
    await g.waitReady(alice);
    assert.equal(g.runtime.startsFor(alice).length, 1, "adopted, not restarted");
    assert.equal(restarted.upstream(alice, "private")?.agent, "dsh");
    assert.equal(restarted.upstream(alice, "private")?.credential, secret);
    assert.equal((await g.navigate(g.tokens.alice, alice)).status, 200);
  }));

test("an OpenCode workspace: its own image, password and managed settings, the same sandbox paths", () =>
  withGateway(ALL, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "opencode");
    const [record] = g.runtime.startsFor(alice);
    assert.equal(record!.options.agent, "opencode");
    assert.equal(record!.options.image, workspaceImage("opencode", "2.4.1"));
    assert.match(record!.options.credential, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(g.runtime.opencodeFor(alice).password, record!.options.credential);
    assert.deepEqual(Object.keys(record!.files), ["opencode.json"]);

    // The managed settings: the models from Qwen Code's system-defaults.json, all through the gateway, plus search.
    const settings = JSON.parse(record!.files["opencode.json"]!) as Record<string, any>;
    const service = `http://${g.config.workspace.kinds.private.gatewayIp}:${g.config.servicePort}`;
    assert.deepEqual(settings.policies.slice(0, 2), [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "portal", effect: "allow" }]);
    assert.equal(settings.model, "portal/qwen3.8-flash-next");
    assert.equal(settings.providers.portal.settings.baseURL, `${service}/llm/v1`);
    assert.deepEqual(settings.providers.portal.env, ["PORTAL_LLM_KEY"]);
    assert.deepEqual(Object.keys(settings.providers.portal.models), ["qwen3.8-flash-next"]);
    assert.equal(settings.mcp.servers.search.url, `${service}/mcp/search`);
    assert.ok("browser" in settings.mcp.servers);
    assert.ok(!JSON.stringify(settings).includes(record!.options.credential), "the password is in the container's environment only");
    assert.equal(g.info(alice).agent, "opencode");
    assert.deepEqual(g.auditActions(alice).find((entry) => entry.action === "workspace_started")?.details, { agent: "opencode", version: "2.4.1", kind: "private" });
  }));

test("opencode: the gateway adds the password to every request; no portal cookie, token or Origin goes upstream", () =>
  withGateway(ALL, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "opencode");
    const opencode = g.runtime.opencodeFor(alice);
    const basic = `Basic ${Buffer.from(`opencode:${opencode.password}`).toString("base64")}`;

    const page = await g.navigate(g.tokens.alice, alice);
    assert.equal(page.status, 200, page.body);
    assert.ok(page.body.includes("OpenCode"));
    const seen = opencode.requests.at(-1)!;
    assert.equal(seen.headers.authorization, basic);
    assert.equal(seen.headers.host, `${opencode.host}:${opencode.port}`);
    assert.equal(seen.headers.cookie, undefined, "the portal session never reaches the workspace");
    assert.equal(seen.headers["sec-fetch-site"], undefined);

    // An API call from the page: no bearer token needed (session agent), and no Origin upstream.
    const api = await g.xhr(g.tokens.alice, alice, { method: "POST", path: "/api/session", bearer: null, body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(api.status, 200, api.body);
    assert.equal(api.headers["www-authenticate"], undefined, "the browser is never asked for a password");
    const forwarded = opencode.requests.at(-1)!;
    assert.deepEqual([forwarded.status, forwarded.headers.origin, forwarded.headers.authorization], [200, undefined, basic], "OpenCode accepted the password");
    // What the browser presents never replaces the gateway's credential: a token must be this session's, a password is no token.
    assert.equal((await g.xhr(g.tokens.alice, alice, { bearer: "wrong" })).status, 401);
    assert.equal((await g.xhr(g.tokens.alice, alice, { bearer: null, headers: { authorization: basic } })).status, 401);
    // Still only this user's: another user's session gets nothing, and nobody's gets nothing either.
    assert.equal((await g.navigate(g.tokens.bob, alice)).status, 403);
    assert.equal((await g.navigate(null, alice)).status, 401);
    // A foreign Origin is refused before anything reaches OpenCode.
    const before = opencode.requests.length;
    const cross = await g.xhr(g.tokens.alice, alice, { method: "POST", path: "/api/session", bearer: null, headers: { origin: "http://evil.example" } });
    assert.equal(cross.status, 403);
    assert.equal(opencode.requests.length, before);
  }));

test("opencode: pairing another browser and a remote machine's link are refused in any spelling", () =>
  withGateway(ALL, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "opencode");
    const opencode = g.runtime.opencodeFor(alice);
    const before = opencode.requests.length;
    const spellings = [
      "/api/pair", "/api/pair?x=1", "/API/Pair", "/api/%70air", "//api//pair", "/x/../api/pair", "/api%2Fpair",
      "/auth/connect/pairing-code", "/api/experimental/machine", "/api/experimental/machine/link",
      // An escape that is no character must not keep the others from being read (OpenCode's router decodes them).
      "/%ff/../api/%70air", "/%/../auth/%63onnect/pairing-code", "/%c0%af/../api/experimental/%6dachine",
    ];
    for (const path of spellings) {
      const reply = await g.xhr(g.tokens.alice, alice, { method: "POST", path, bearer: null, body: "{}" });
      assert.deepEqual([reply.status, json<{ error: string }>(reply).error], [403, "not_available"], path);
    }
    assert.equal((await g.navigate(g.tokens.alice, alice, "/auth/connect/pairing-code")).status, 403);
    assert.equal(opencode.requests.length, before, "none reached OpenCode");
    // OpenCode would open the machine link to anyone; it is no socket of its page.
    assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { path: "/api/experimental/machine/link", protocols: [] }), { status: 404 });
    assert.equal(opencode.sockets.length, 0);
    // The other agents' blocked paths are not OpenCode's business.
    assert.equal((await g.xhr(g.tokens.alice, alice, { path: "/connect", bearer: null })).status, 404);
  }));

test("opencode: a terminal's socket, at its own path only, authorised by the session alone", () =>
  withGateway(ALL, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "opencode");
    const opencode = g.runtime.opencodeFor(alice);
    const basic = `Basic ${Buffer.from(`opencode:${opencode.password}`).toString("base64")}`;
    const terminal = "/api/experimental/persistent-pty/pty_persistent_1";

    // As OpenCode's page does: a ticket first (OpenCode gives one to its own page only), then the socket with it.
    const asked = await g.xhr(g.tokens.alice, alice, { method: "POST", path: `${terminal}/connect-token`, bearer: null, headers: { "x-opencode-ticket": "1" } });
    assert.equal(asked.status, 200, asked.body);
    const { ticket } = json<{ data: { ticket: string } }>(asked).data;
    const open = await g.openSocket(g.tokens.alice, alice, { path: `${terminal}/connect?cursor=0&ticket=${ticket}`, protocols: [] });
    assert.ok("socket" in open, JSON.stringify(open));
    assert.equal((await open.next()).data.toString(), "hello from opencode");
    open.socket.send("ls\n");
    assert.equal((await open.next()).data.toString(), "ls\n");
    const handshake = opencode.sockets.at(-1)!;
    assert.deepEqual([handshake.headers.authorization, handshake.headers.origin, handshake.headers.cookie], [basic, undefined, undefined]);
    assert.equal(handshake.headers.host, `${opencode.host}:${opencode.port}`);
    open.socket.close();

    // No other socket: not the other agents', not OpenCode's other kind of terminal (its page opens none), not its
    // socket for a browser's own MCP servers.
    const accepted = opencode.sockets.length;
    for (const path of ["/terminal", "/acp", "/api/remote.mux", "/api/pty/pty_1/connect", `${terminal}`, "/api/experimental/persistent-pty/connect", `/x${terminal}/connect`, "/api/event", "/api/experimental/client-mcp"]) {
      assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { path, protocols: [] }), { status: 404 }, path);
    }
    // Nor a target as no browser writes one, which the workspace's server would read as another path.
    for (const target of ["/api/experimental/persistent-pty/../connect", "/api/experimental/persistent-pty/..%2f..%2fmachine%2flink/connect", "/api/experimental/persistent-pty/a\\b/connect"]) {
      assert.equal(await upgradeStatus(g, g.tokens.alice, alice, target), 404, target);
    }
    // A target with a "#" is refused, not connected to.
    assert.equal(await upgradeStatus(g, g.tokens.alice, alice, `${terminal}/connect?ticket=${ticket}#x`), 400);
    assert.equal(opencode.sockets.length, accepted);
    assert.deepEqual(await g.openSocket(null, alice, { path: `${terminal}/connect`, protocols: [] }), { status: 401 });
    assert.deepEqual(await g.openSocket(g.tokens.bob, alice, { path: `${terminal}/connect`, protocols: [] }), { status: 403 });
    assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { path: `${terminal}/connect`, protocols: [], headers: { origin: "http://evil.example" } }), { status: 403 });
    // A ticket OpenCode doesn't know is its refusal to make.
    assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { path: `${terminal}/connect?ticket=made-up`, protocols: [] }), { status: 403 });
  }));

test("opencode: ready once it answers; a running turn keeps the workspace up, an unanswered approval or question doesn't", () =>
  withGateway({ ...ALL, readyAfterMs: 300 }, async (g) => {
    const { alice } = g.ids;
    await g.manager.start(alice, { agent: "opencode" });
    assert.equal(g.info(alice).ready, false);
    await g.waitReady(alice);
    const opencode = g.runtime.opencodeFor(alice);
    const busy = (): [boolean, string | null] => [g.info(alice).busy, g.info(alice).busyReason];

    // Nothing runs: two questions to OpenCode, whatever sessions it keeps.
    opencode.sessions = [{ id: "ses_old" }, { id: "ses_a" }];
    opencode.polls.length = 0;
    await g.manager.refreshSamples();
    assert.equal(g.info(alice).busy, false);
    assert.deepEqual(opencode.polls, ["/api/session/active", "/api/experimental/job"]);

    // A turn, in whatever project folder.
    opencode.sessions.find((session) => session.id === "ses_a")!.running = true;
    opencode.polls.length = 0;
    await g.manager.refreshSamples();
    assert.deepEqual(busy(), [true, "task"]);
    assert.deepEqual([...opencode.polls].sort(), ["/api/session/active", "/api/session/ses_a/form", "/api/session/ses_a/permission"]);
    g.clock.now += 45 * MIN;
    await g.manager.refreshSamples();
    await g.manager.reap();
    assert.equal(g.info(alice).status, "running", "never stopped while an OpenCode session runs");

    // A subagent is a session of its own. One that waits for an approval is no work...
    opencode.sessions = [{ id: "ses_a" }, { id: "ses_sub", running: true }];
    opencode.permissions = [{ sessionID: "ses_sub" }];
    await g.manager.refreshSamples();
    assert.equal(g.info(alice).busy, false);
    // ...unless another session works meanwhile.
    opencode.sessions.find((session) => session.id === "ses_a")!.running = true;
    await g.manager.refreshSamples();
    assert.deepEqual(busy(), [true, "task"]);

    // A question nobody answers is no work either (OpenCode leaves it open).
    opencode.permissions = [];
    opencode.sessions = [{ id: "ses_a", running: true }];
    opencode.forms = [{ sessionID: "ses_a" }];
    await g.manager.refreshSamples();
    assert.equal(g.info(alice).busy, false);

    // A command a turn left running in the background is work, though its session no longer runs.
    opencode.forms = [];
    opencode.sessions = [{ id: "ses_a" }];
    opencode.jobs = [{ kind: "shell", status: "running" }];
    await g.manager.refreshSamples();
    assert.deepEqual(busy(), [true, "task"]);
    opencode.jobs = [{ kind: "shell", status: "completed" }];
    await g.manager.refreshSamples();
    assert.equal(g.info(alice).busy, false);
    // A subagent is listed as a job as well. One that waits for an approval is work as neither.
    opencode.sessions = [{ id: "ses_a" }, { id: "ses_sub", running: true }];
    opencode.permissions = [{ sessionID: "ses_sub" }];
    opencode.jobs = [{ kind: "subagent", status: "running" }];
    await g.manager.refreshSamples();
    assert.equal(g.info(alice).busy, false);
    opencode.permissions = [];
    opencode.jobs = [];

    // A session that ended between two questions tells nothing, and hides no session that works.
    opencode.sessions = [{ id: "ses_sub", running: true, ended: true }, { id: "ses_a", running: true }];
    await g.manager.refreshSamples();
    assert.deepEqual(busy(), [true, "task"]);

    // An OpenCode that doesn't answer tells nothing: the last answer stands, as for the other agents.
    opencode.sessions = [{ id: "ses_a", running: true }];
    await g.manager.refreshSamples();
    assert.equal(g.info(alice).busy, true);
    opencode.apiFails = true;
    await g.manager.refreshSamples();
    assert.equal(g.info(alice).busy, true);
    opencode.apiFails = false;

    opencode.forms = [{ sessionID: "ses_a" }];
    await g.manager.refreshSamples();
    g.clock.now += 31 * MIN;
    await g.manager.reap();
    assert.deepEqual([g.info(alice).status, g.info(alice).stopReason], ["stopped", "idle"]);
  }));

test("opencode: prompts and new terminals are a person at work; what an open tab sends by itself is not", () =>
  withGateway(ALL, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "opencode");
    const send = (method: string, path: string) =>
      g.xhr(g.tokens.alice, alice, { method, path, bearer: null, ...(method === "GET" ? {} : { body: "{}", headers: { "content-type": "application/json", "x-opencode-ticket": "1" } }) });
    const passive: Array<[string, string, number]> = [
      ["GET", "/api/session/active", 200],
      ["GET", "/api/info", 200],
      ["POST", "/api/experimental/persistent-pty/pty_persistent_1/connect-token", 200],
      ["POST", "/api/session/ses_1/view", 204],
      ["POST", "/api/worktree/refresh", 204],
      ["POST", "/api/rpc/opencode.goal/get", 200],
    ];
    const active: Array<[string, string, number]> = [
      ["POST", "/api/session/ses_1/prompt", 200],
      ["POST", "/api/session", 200],
      ["POST", "/api/experimental/session/ses_1/terminal", 200],
      ["POST", "/api/rpc/opencode.goal/set", 200],
    ];
    for (const [requests, counts] of [[passive, false], [active, true]] as const) {
      for (const [method, path, status] of requests) {
        const before = g.info(alice).lastActivityAt;
        g.clock.now += MIN;
        assert.equal((await send(method, path)).status, status, `${method} ${path}`);
        assert.equal(g.info(alice).lastActivityAt !== before, counts, `${method} ${path}`);
      }
    }
  }));

test("switching agents: stop Qwen Code, start OpenCode on the same files; after a gateway restart it is adopted with its password", () =>
  withGateway(ALL, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, "qwen");
    await g.control("POST", `/control/workspaces/${alice}/stop`, { reason: "user", actorUserId: alice });
    assert.equal(json<WorkspaceInfo>(await start(g, alice, { agent: "opencode" })).agent, "opencode");
    await g.waitReady(alice);
    assert.deepEqual(g.runtime.startsFor(alice).map((record) => record.options.agent), ["qwen", "opencode"]);
    const mismatch = await start(g, alice, { agent: "dsh" });
    assert.deepEqual([mismatch.status, json<{ message: string }>(mismatch).message], [409, "OpenCode is already running in this workspace. Stop it to switch."]);

    const { password } = g.runtime.opencodeFor(alice);
    const restarted = await g.restart();
    await g.waitReady(alice);
    assert.equal(g.runtime.startsFor(alice).length, 2, "adopted, not restarted");
    assert.deepEqual([restarted.upstream(alice, "private")?.agent, restarted.upstream(alice, "private")?.credential], ["opencode", password]);
    assert.equal((await g.navigate(g.tokens.alice, alice)).status, 200);
  }));
