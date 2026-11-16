// A user's two workspaces, Private and Online: one runs at a time, each with its own files, UID, settings, agent
// ports, browser token and service listener, and nothing on one kind's side ever reaches the other's container.
// Online is allowed per user (users.online_allowed) and for the whole portal (ONLINE_WORKSPACES). Uses the same
// in-process gateway as integration.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { llmUsage, users, workspaces, type WorkspaceKind } from "@portal/db";
import { eq } from "drizzle-orm";
import { userPaths, userRoot } from "../src/paths.ts";
import { WorkspaceManager, type WorkspaceInfo } from "../src/workspaces.ts";
import { bearerSubprotocol, cookie, json, request, startGateway, waitFor, type Gateway, type GatewayOptions, type Reply } from "./harness.ts";

async function withGateway(options: GatewayOptions, run: (gateway: Gateway) => Promise<void>): Promise<void> {
  const gateway = await startGateway(options);
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
}

const start = (g: Gateway, userId: number, body?: unknown): Promise<Reply> => g.control("POST", `/control/workspaces/${userId}/start`, body);
const erase = (g: Gateway, userId: number, kind: string, body?: unknown): Promise<Reply> =>
  g.control("DELETE", `/control/workspaces/${userId}/files?kind=${kind}`, body);
const refusal = (reply: Reply): [number, string] => [reply.status, json<{ error: string }>(reply).error];

function allowOnline(g: Gateway, userId: number, allowed: boolean): void {
  g.db.update(users).set({ onlineAllowed: allowed }).where(eq(users.id, userId)).run();
}

/** The agent port's "Try again" (the error and capacity pages' form) on one kind's port. */
function tryAgain(g: Gateway, token: string, userId: number, kind: WorkspaceKind): Promise<Reply> {
  return request(g.agentPort(userId, kind), {
    method: "POST",
    path: "/__portal/start",
    headers: { cookie: cookie(token), origin: g.agentOrigin(userId, kind), "sec-fetch-site": "same-origin" },
  });
}

/** A "restarted" gateway: a new manager over the same database and containers, with this config. */
async function restart(g: Gateway, config = g.config): Promise<WorkspaceManager> {
  g.manager.shutdown();
  const manager = new WorkspaceManager({ config, db: g.db, runtime: g.runtime, versions: g.versions, llm: g.llmQueue, connections: g.connections, log: g.log, fence: g.fence.check, now: () => g.clock.now });
  await manager.init();
  g.useManager(manager);
  return manager;
}

const logged = (g: Gateway, msg: string): boolean => g.logs.some((line) => (JSON.parse(line) as { msg: string }).msg === msg);

test("an Online start: its own files, UID, settings with the Online service address, and the kind everywhere", () =>
  withGateway({}, async (g) => {
    const { alice } = g.ids;
    const started = json<WorkspaceInfo>(await start(g, alice, { kind: "online" }));
    assert.deepEqual([started.status, started.kind, started.online], ["starting", "online", "allowed"]);
    await g.waitReady(alice);

    const record = g.runtime.startsFor(alice)[0]!;
    assert.equal(record.options.kind, "online");
    const online = userPaths(g.dataDir, alice, "online");
    const uid = 2_000_000_000 + alice;
    assert.equal(fs.readFileSync(online.passwd, "utf8").split("\n").find((line) => line.startsWith("user:")), `user:x:${uid}:${uid}:Workspace user:/home/user:/bin/bash`);
    assert.equal(fs.existsSync(userPaths(g.dataDir, alice, "private").root), false, "the Private folder is not even created");
    const settings = record.settings as { mcpServers: Record<string, { httpUrl: string }> };
    assert.equal(settings.mcpServers.search!.httpUrl, "http://172.28.0.1:4001/mcp/search", "the agent calls the gateway on the Online bridge");
    assert.ok(JSON.stringify(record.systemDefaults).includes("http://172.28.0.1:4001/llm/v1"));

    assert.equal(g.workspaceRow(alice)?.kind, "online");
    assert.equal(g.workspaceRow(alice)?.containerName, `wp-wo-${alice}`);
    assert.deepEqual(g.auditActions(alice).find((entry) => entry.action === "workspace_started")?.details, { agent: "qwen", version: "0.27.0", kind: "online" });
    assert.deepEqual(g.live.frame().workspaces.list.map((w) => [w.userId, w.kind]), [[alice, "online"]]);

    await g.control("POST", `/control/workspaces/${alice}/stop`, { reason: "user", actorUserId: alice });
    assert.deepEqual(g.auditActions(alice).at(-1)?.details, { reason: "user", kind: "online" });
    assert.equal(g.info(alice).kind, "online", "a stopped workspace shows its last kind");
  }));

test("one kind at a time: the other kind is refused with kind_mismatch, a start without a kind attaches", () =>
  withGateway({}, async (g) => {
    const { alice, bob } = g.ids;
    await g.startReady(alice, undefined, "online");
    const other = await start(g, alice, { kind: "private" });
    assert.deepEqual([other.status, json(other)], [
      409,
      { error: "kind_mismatch", message: "Your Online workspace is running. Stop it to start the Private one." },
    ]);
    const attached = json<WorkspaceInfo>(await start(g, alice));
    assert.equal(attached.kind, "online", "old callers keep working: no kind attaches to what runs");
    assert.equal(json<WorkspaceInfo>(await start(g, alice, { kind: "online" })).status, "running");
    assert.equal(g.runtime.startsFor(alice).length, 1);

    // While starting, too; and a start without a kind starts Private.
    const attempt = g.manager.requestStart(bob);
    assert.ok(attempt.ok);
    const during = g.manager.requestStart(bob, { kind: "online" });
    assert.equal(!during.ok && during.error.name, "KindMismatchError");
    await attempt.done;
    assert.equal(g.info(bob).kind, "private");

    assert.deepEqual(refusal(await start(g, alice, { kind: "public" })), [400, "unknown_kind"]);
    assert.deepEqual(refusal(await start(g, alice, { kind: 1 })), [400, "unknown_kind"]);
  }));

test("Online needs the admin's permission for the user: 403 online_not_allowed; Private still starts", () =>
  withGateway({}, async (g) => {
    const { alice, carol } = g.ids;
    allowOnline(g, alice, false);
    assert.equal(json<WorkspaceInfo>(await g.control("GET", `/control/workspaces/${alice}`)).online, "not_allowed");
    const refused = await start(g, alice, { kind: "online" });
    assert.deepEqual([refused.status, json(refused)], [403, { error: "online_not_allowed", message: "Your administrator hasn't allowed you an Online workspace." }]);
    assert.equal(g.runtime.startsFor(alice).length, 0);
    const page = await tryAgain(g, g.tokens.alice, alice, "online");
    assert.equal(page.status, 403, "nor from the Online port's Try again");
    assert.ok(page.body.includes("<h1>Your workspace can&#39;t start</h1>"));
    assert.equal(json<WorkspaceInfo>(await start(g, alice, { kind: "private" })).kind, "private");

    const list = json<{ workspaces: WorkspaceInfo[] }>(await g.control("GET", "/control/workspaces")).workspaces;
    assert.deepEqual(list.map((w) => [w.userId, w.online]), [[alice, "not_allowed"]]);
    assert.equal(json<WorkspaceInfo>(await g.control("GET", `/control/workspaces/${carol}`)).online, "allowed", "allowed by default");
  }));

test("ONLINE_WORKSPACES=off: Online is off for everyone (409 online_disabled); the Online ports answer all the same", () =>
  withGateway({ env: { ONLINE_WORKSPACES: "off" } }, async (g) => {
    const { alice } = g.ids;
    assert.equal(g.info(alice).online, "off");
    const refused = await start(g, alice, { kind: "online" });
    assert.deepEqual([refused.status, json(refused)], [409, { error: "online_disabled", message: "Online workspaces are turned off on this portal." }]);
    const page = await g.navigate(g.tokens.alice, alice, "/", {}, "online");
    assert.equal(page.status, 503);
    assert.ok(page.body.includes("Your Online workspace is stopped"));
    assert.equal((await tryAgain(g, g.tokens.alice, alice, "online")).status, 409);
    await g.startReady(alice);
    assert.equal(g.info(alice).kind, "private");
  }));

test("the reaper stops an Online workspace once its user is no longer allowed Online, even while it works", () =>
  withGateway({}, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, undefined, "online");
    g.runtime.qwenFor(alice).health.activePrompts = 1;
    await g.manager.refreshSamples();
    await g.manager.reap();
    assert.equal(g.info(alice).status, "running");

    allowOnline(g, alice, false);
    await g.manager.reap();
    assert.deepEqual([g.info(alice).status, g.info(alice).stopReason], ["stopped", "online_not_allowed"]);
    assert.deepEqual(g.auditActions(alice).at(-1)?.details, { reason: "online_not_allowed", kind: "online" });
    assert.deepEqual(g.runtime.runningUsers(), []);
  }));

test("a gateway started with ONLINE_WORKSPACES=off stops the Online containers it finds; Private ones are adopted", () =>
  withGateway({ env: { MAX_RUNNING_WORKSPACES: "3" } }, async (g) => {
    const { alice, bob } = g.ids;
    await g.startReady(alice, undefined, "online");
    await g.startReady(bob);
    const off = { ...g.config, workspace: { ...g.config.workspace, onlineEnabled: false } };
    const manager = await restart(g, off);
    assert.deepEqual([manager.info(alice).status, manager.info(alice).stopReason], ["stopped", "online_disabled"]);
    assert.deepEqual(g.runtime.runningUsers(), [bob], "the Online container is gone; the Private one runs on");
    assert.deepEqual(g.auditActions(alice).at(-1)?.details, { reason: "online_disabled", kind: "online" });
    await waitFor(() => manager.info(bob).ready, "bob's workspace to be adopted");
    assert.equal(manager.info(bob).kind, "private");
    assert.equal(g.runtime.startsFor(bob).length, 1, "adopted, not restarted");
  }));

test("after a restart an Online container is adopted as Online, on its own port and with its own token", () =>
  withGateway({}, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, undefined, "online");
    const manager = await restart(g);
    await waitFor(() => manager.info(alice).ready, "the adopted workspace to be ready");
    assert.equal(manager.info(alice).kind, "online");
    assert.equal((await g.xhr(g.tokens.alice, alice, { path: "/api/sessions", kind: "online" })).status, 200);
    assert.equal(manager.upstream(alice, "private"), null);
  }));

test("agent ports: a port says user and kind; the other kind's port, token or socket never reaches the container", () =>
  withGateway({}, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, undefined, "online");
    const qwen = g.runtime.qwenFor(alice);
    assert.notEqual(g.agentPort(alice, "online"), g.agentPort(alice, "private"));
    assert.equal(g.agentPort(alice, "online"), g.config.workspace.kinds.online.agentPortBase + alice);
    assert.notEqual(g.browserToken(g.tokens.alice, alice, "online"), g.browserToken(g.tokens.alice, alice, "private"));

    assert.equal((await g.navigate(g.tokens.alice, alice, "/", {}, "online")).status, 200);
    assert.equal((await g.xhr(g.tokens.alice, alice, { path: "/api/sessions", kind: "online" })).status, 200);
    const seen = qwen.requests.length;

    // The Private port while Online runs: a page saying so, 409 for the rest; nothing is forwarded.
    const page = await g.navigate(g.tokens.alice, alice);
    assert.equal(page.status, 409);
    assert.ok(page.body.includes("<h1>Your Online workspace is running, not this one</h1>"));
    assert.ok(page.body.includes(`href="//127.0.0.1:${g.config.webPort}/" target="_top"`));
    const api = await g.xhr(g.tokens.alice, alice, { path: "/api/sessions" });
    assert.deepEqual([api.status, json(api)], [409, { error: "kind_mismatch", message: "Your Online workspace is running, not this one (Private)." }]);
    assert.deepEqual(await g.openSocket(g.tokens.alice, alice), { status: 409 });
    assert.equal((await tryAgain(g, g.tokens.alice, alice, "private")).status, 409, "Try again on the Private port doesn't stop or switch anything");

    // The Online port with the Private token (as a page on the Private origin would have it): refused.
    const wrongToken = await g.xhr(g.tokens.alice, alice, { path: "/api/sessions", kind: "online", bearer: g.browserToken(g.tokens.alice, alice, "private") });
    assert.equal(wrongToken.status, 401);
    const wrongSocket = await g.openSocket(g.tokens.alice, alice, { kind: "online", protocols: ["qwen-ws", bearerSubprotocol(g.browserToken(g.tokens.alice, alice, "private"))] });
    assert.equal("status" in wrongSocket && wrongSocket.status, 401);
    // The other origin is a foreign one.
    const foreign = await g.xhr(g.tokens.alice, alice, { method: "POST", path: "/api/echo", kind: "online", headers: { origin: g.agentOrigin(alice, "private") }, body: "x" });
    assert.equal(foreign.status, 403);

    assert.equal(qwen.requests.length, seen, "no request on the Private port (or with its token) reached the Online container");
    assert.equal(g.runtime.startsFor(alice).length, 1);
  }));

test("service API: each kind's listener knows only its own kind's containers by source address", () =>
  withGateway({}, async (g) => {
    const { alice, bob } = g.ids;
    await g.startReady(alice);
    await g.startReady(bob, undefined, "online");
    const privateIp = g.runtime.qwenFor(alice).host;
    const onlineIp = g.runtime.qwenFor(bob).host;
    assert.notEqual(privateIp, onlineIp);
    const requests = (userId: number): number => g.db.select().from(llmUsage).where(eq(llmUsage.userId, userId)).get()?.requests ?? 0;
    const call = (kind: WorkspaceKind, from: string): Promise<Reply> =>
      request(g.ports.services[kind], { method: "POST", path: "/llm/v1/chat/completions", headers: { "content-type": "application/json" }, body: "{}", localAddress: from });

    assert.equal((await call("private", privateIp)).status, 200);
    assert.equal((await call("online", onlineIp)).status, 200);
    assert.deepEqual([requests(alice), requests(bob)], [1, 1]);

    assert.equal((await call("private", onlineIp)).status, 403, "the Private listener never resolves an Online container");
    assert.equal((await call("online", privateIp)).status, 403, "and the Online listener never a Private one");
    assert.deepEqual([requests(alice), requests(bob)], [1, 1], "nothing was attributed to anyone");
    assert.equal(g.manager.userIdForIp("private", onlineIp), null);
    assert.equal(g.manager.userIdForIp("online", onlineIp), bob);
  }));

test("erasing a kind's files: refused while that kind runs, audited with the kind and the admin, the other kind kept", () =>
  withGateway({}, async (g) => {
    const { alice, admin } = g.ids;
    await g.startReady(alice);
    await g.manager.stop(alice, "user");
    await g.startReady(alice, undefined, "online");
    const priv = userPaths(g.dataDir, alice, "private");
    const online = userPaths(g.dataDir, alice, "online");
    fs.writeFileSync(path.join(priv.workspace, "secret.txt"), "private");
    fs.writeFileSync(path.join(online.workspace, "page.html"), "online");
    fs.mkdirSync(path.join(online.home, ".cache"));

    const running = await erase(g, alice, "online", { actorUserId: admin });
    assert.deepEqual([running.status, json(running)], [409, { error: "workspace_running", message: "The Online workspace is running. Stop it before erasing its files." }]);
    assert.ok(fs.existsSync(path.join(online.workspace, "page.html")));
    assert.deepEqual(refusal(await erase(g, alice, "bogus")), [400, "unknown_kind"]);
    assert.deepEqual(refusal(await g.control("DELETE", `/control/workspaces/${alice}/files`)), [400, "unknown_kind"]);
    assert.deepEqual(refusal(await erase(g, alice, "online", { actorUserId: 9999 })), [400, "invalid_actor"]);
    assert.deepEqual(refusal(await erase(g, 9999, "online")), [404, "user_not_found"]);

    await g.manager.stop(alice, "user");
    assert.deepEqual(json(await erase(g, alice, "online", { actorUserId: admin })), { ok: true });
    assert.deepEqual([fs.readdirSync(online.workspace), fs.readdirSync(online.home)], [[], []]);
    assert.equal(fs.readFileSync(path.join(priv.workspace, "secret.txt"), "utf8"), "private", "the Private files are untouched");
    assert.deepEqual(g.auditActions(alice).at(-1), { action: "workspace_files_erased", details: { kind: "online" }, actorUserId: admin });

    // Erasing Private while Online runs is fine: they share nothing.
    await g.startReady(alice, undefined, "online");
    assert.deepEqual(json(await erase(g, alice, "private")), { ok: true });
    assert.deepEqual(fs.readdirSync(priv.workspace), []);
    assert.equal(g.info(alice).status, "running");
  }));

test("the files from before kinds become the Private ones at gateway start, or at the next start while a container ran", () =>
  withGateway({ env: { MAX_RUNNING_WORKSPACES: "3" } }, async (g) => {
    const { alice, bob } = g.ids;
    const legacy = (userId: number): string => {
      const root = userRoot(g.dataDir, userId);
      fs.mkdirSync(path.join(root, "workspace", "project"), { recursive: true });
      fs.writeFileSync(path.join(root, "workspace", "project", "notes.md"), `user ${userId}`);
      fs.mkdirSync(path.join(root, "home", ".qwen"), { recursive: true });
      fs.mkdirSync(path.join(root, "system", "qwen"), { recursive: true });
      return root;
    };
    // Alice's container from before the update still runs (on her old folders); bob has none.
    await g.startReady(alice);
    fs.rmSync(userPaths(g.dataDir, alice, "private").root, { recursive: true });
    const aliceRoot = legacy(alice);
    const bobRoot = legacy(bob);

    const manager = await restart(g);
    assert.deepEqual(fs.readdirSync(bobRoot), ["private"], "bob's files moved when the gateway started");
    assert.equal(fs.readFileSync(path.join(userPaths(g.dataDir, bob, "private").workspace, "project", "notes.md"), "utf8"), `user ${bob}`);
    assert.ok(logged(g, "moved a user's files into the Private workspace's folder"));
    assert.deepEqual(fs.readdirSync(aliceRoot).sort(), ["home", "system", "workspace"], "a running container's folders stay where it mounts them");

    await waitFor(() => manager.info(alice).ready, "alice's workspace to be adopted");
    await manager.stop(alice, "user");
    await g.startReady(alice);
    assert.deepEqual(fs.readdirSync(aliceRoot), ["private"], "moved at her next start");
    assert.equal(fs.readFileSync(path.join(userPaths(g.dataDir, alice, "private").workspace, "project", "notes.md"), "utf8"), `user ${alice}`);
    assert.ok(fs.existsSync(userPaths(g.dataDir, alice, "private").passwd), "and system/ rendered in its new place");
    assert.equal(g.db.select().from(workspaces).where(eq(workspaces.userId, alice)).get()?.kind, "private");
  }));

// ---------------------------------------------------------------- the host firewall's fence (fence.ts)

test("Online runs only inside the host firewall: without it, Online is off and refused, Private starts as ever", () =>
  withGateway({ fence: "missing" }, async (g) => {
    const { alice, bob } = g.ids;
    assert.equal(g.info(alice).online, "off");
    const refused = await start(g, alice, { kind: "online" });
    assert.deepEqual([refused.status, json(refused)], [
      409,
      { error: "online_disabled", message: "Online workspaces are off: the host firewall that keeps them off the local network is not loaded. Ask your administrator." },
    ]);
    assert.equal((await tryAgain(g, g.tokens.alice, alice, "online")).status, 409, "nor from the Online port");
    assert.deepEqual(g.runtime.starts, []);
    assert.ok(logged(g, "the host firewall that fences the Online workspaces in is not loaded: Online workspaces are refused and stopped until it is (sudo systemctl status workspace-portal-firewall)"));
    await g.startReady(bob);
    assert.equal(g.info(bob).kind, "private");

    // "unknown" (no clear answer) is not "loaded" either.
    g.fence.state = "unknown";
    await g.manager.checkFence();
    assert.deepEqual(refusal(await start(g, alice, { kind: "online" })), [409, "online_disabled"]);

    g.fence.state = "loaded";
    await g.manager.checkFence();
    assert.equal(g.info(alice).online, "allowed");
    await g.startReady(alice, undefined, "online");
    assert.ok(logged(g, "the host firewall that fences the Online workspaces in is loaded again: they may run"));
  }));

test("the fence going away stops every Online workspace, starting or working; Private ones run on", () =>
  withGateway({ env: { MAX_RUNNING_WORKSPACES: "3" } }, async (g) => {
    const { alice, bob, carol } = g.ids;
    await g.startReady(alice, undefined, "online");
    g.runtime.qwenFor(alice).health.activePrompts = 1;
    await g.manager.refreshSamples();
    await g.startReady(bob);
    g.runtime.readyAfterMs = 60_000;
    await start(g, carol, { kind: "online" });
    assert.equal(g.info(carol).status, "starting");

    g.fence.state = "missing";
    assert.equal(await g.manager.checkFence(), "missing");
    for (const userId of [alice, carol]) {
      assert.deepEqual([g.info(userId).status, g.info(userId).stopReason, g.info(userId).online], ["stopped", "online_disabled", "off"]);
      assert.deepEqual(g.auditActions(userId).at(-1)?.details, { reason: "online_disabled", kind: "online" });
    }
    assert.deepEqual(g.runtime.runningUsers(), [bob]);
    assert.equal(g.info(bob).status, "running");
    // The reaper and reconcile see it the same way.
    await g.manager.reap();
    await g.manager.reconcile();
    assert.deepEqual(g.runtime.runningUsers(), [bob]);
  }));

test("a start checks the fence once more right before the container: gone by then, no Online container runs", () =>
  withGateway({}, async (g) => {
    const { alice } = g.ids;
    const attempt = g.manager.requestStart(alice, { kind: "online" });
    assert.ok(attempt.ok, "accepted: the last check found the fence");
    g.fence.state = "missing";
    await assert.rejects(attempt.done, { name: "OnlineDisabledError" });
    assert.deepEqual(g.runtime.starts, []);
    assert.deepEqual([g.info(alice).status, g.info(alice).stopReason, g.info(alice).lastError], ["stopped", "online_disabled", null]);

    // Through the control API (the start is accepted on the last check's word, then refused): the same 409.
    g.fence.state = "loaded";
    await g.manager.checkFence();
    g.fence.state = "missing";
    const checks = g.fence.checks;
    assert.deepEqual(refusal(await start(g, alice, { kind: "online" })), [409, "online_disabled"]);
    assert.equal(g.fence.checks, checks + 1, "checked once more by the start");
    assert.deepEqual(g.runtime.starts, []);
  }));

test("a gateway started without the fence stops the Online containers it finds; Private ones are adopted", () =>
  withGateway({ env: { MAX_RUNNING_WORKSPACES: "3" } }, async (g) => {
    const { alice, bob } = g.ids;
    await g.startReady(alice, undefined, "online");
    await g.startReady(bob);
    g.fence.state = "missing";
    const manager = await restart(g);
    assert.deepEqual([manager.info(alice).status, manager.info(alice).stopReason], ["stopped", "online_disabled"]);
    assert.deepEqual(g.runtime.runningUsers(), [bob]);
    await waitFor(() => manager.info(bob).ready, "bob's workspace to be adopted");
  }));

test("without a fence check at all (none passed to the manager), Online never runs", () =>
  withGateway({}, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, undefined, "online");
    g.manager.shutdown();
    const manager = new WorkspaceManager({ config: g.config, db: g.db, runtime: g.runtime, versions: g.versions, llm: g.llmQueue, connections: g.connections, log: g.log, now: () => g.clock.now });
    await manager.init();
    g.useManager(manager);
    assert.deepEqual([manager.info(alice).status, manager.info(alice).stopReason, manager.info(alice).online], ["stopped", "online_disabled", "off"]);
    assert.deepEqual(g.runtime.runningUsers(), []);
    await assert.rejects(manager.start(alice, { kind: "online" }), { name: "OnlineDisabledError" });
  }));

// ---------------------------------------------------------------- one origin's page against the other kind's port

for (const agent of ["qwen", "dsh"] as const) {
  test(`${agent}: a page on another port of the host (the Online origin) gets nothing through to the Private agent, cookie or not`, () =>
    withGateway({ env: { WORKSPACE_AGENTS: "qwen,dsh" } }, async (g) => {
      const { alice } = g.ids;
      await g.startReady(alice, agent, "private");
      const upstream = agent === "dsh" ? g.runtime.dshFor(alice) : g.runtime.qwenFor(alice);
      const seen = upstream.requests.length;
      const fromOnline = { "sec-fetch-site": "same-site", referer: `${g.agentOrigin(alice, "online")}/` };
      // An image, a script, a no-cors or CORS fetch, a top-level navigation: the browser adds the portal's cookie to
      // each (SameSite=Lax holds only between sites), and sends no Origin with a GET.
      for (const [mode, dest] of [["no-cors", "image"], ["no-cors", "script"], ["no-cors", "empty"], ["cors", "empty"], ["navigate", "document"]] as const) {
        const reply = await g.xhr(g.tokens.alice, alice, { path: "/api/sessions?x=1", bearer: null, headers: { ...fromOnline, "sec-fetch-mode": mode, "sec-fetch-dest": dest } });
        assert.deepEqual([reply.status, json<{ error: string }>(reply).error], [403, "forbidden_same_site"], `${mode} ${dest}`);
      }
      assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { headers: { "sec-fetch-site": "same-site" } }), { status: 403 });
      assert.equal(upstream.requests.length, seen, "nothing reached the agent");

      // What the portal itself does: navigate its iframe of the workspace.
      assert.equal((await g.navigate(g.tokens.alice, alice)).status, 200);
      assert.ok(upstream.requests.length > seen);
    }));
}

// ---------------------------------------------------------------- erasing files against containers and starts

test("erasing Private files waits for no kind flag: a Private container a failed stop left behind is removed first, or nothing is erased", () =>
  withGateway({}, async (g) => {
    const { alice, admin } = g.ids;
    await g.startReady(alice);
    const privateId = g.runtime.containerFor(alice).id;
    const secret = path.join(userPaths(g.dataDir, alice, "private").workspace, "secret.txt");
    fs.writeFileSync(secret, "private");
    g.runtime.failStops = new Error("docker daemon hiccup");
    await g.manager.stop(alice, "user");
    // An Online start can't remove the leftover either; the entry now shows Online.
    assert.deepEqual(refusal(await start(g, alice, { kind: "online" })), [500, "start_failed"]);
    assert.deepEqual([g.info(alice).kind, g.runtime.containers.get(privateId)?.running], ["online", true]);

    assert.deepEqual(refusal(await erase(g, alice, "private", { actorUserId: admin })), [409, "workspace_running"]);
    assert.equal(fs.readFileSync(secret, "utf8"), "private", "nothing erased under the running container");

    g.runtime.failStops = null;
    assert.deepEqual(json(await erase(g, alice, "private", { actorUserId: admin })), { ok: true });
    assert.equal(g.runtime.containers.has(privateId), false, "the leftover went first");
    assert.deepEqual(fs.readdirSync(path.dirname(secret)), []);
  }));

test("erasing a kind's files is refused while Docker has a container of that kind the gateway doesn't track", () =>
  withGateway({}, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice);
    await g.manager.stop(alice, "user");
    // One the gateway never started (or lost track of): Docker's word counts.
    await g.runtime.startWorkspace(alice, { kind: "private", agent: "qwen", credential: "x", image: g.versions.selection("qwen").image });
    assert.deepEqual(refusal(await erase(g, alice, "private")), [409, "workspace_running"]);
    assert.deepEqual(json(await erase(g, alice, "online")), { ok: true }, "the other kind's are its own");
  }));

test("an Online start during 'Erase Private files' waits for it: the files from before kinds don't slip into private/", () =>
  withGateway({}, async (g) => {
    const { alice, admin } = g.ids;
    // Private files from before kinds, never moved (the container from before ran at the update).
    const legacyHome = path.join(userRoot(g.dataDir, alice), "home");
    fs.mkdirSync(path.join(legacyHome, "notes"), { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "notes", "secret.txt"), "private");
    // The erase is held up before it deletes anything (it asks Docker first).
    let release!: () => void;
    g.runtime.listGate = new Promise((resolve) => (release = resolve));
    const erasing = g.manager.eraseFiles(alice, "private", admin);
    const attempt = g.manager.requestStart(alice, { kind: "online" });
    assert.ok(attempt.ok, "the other kind may start meanwhile");
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    // Otherwise the start would move the old home into private/ now, where an erase already past private/home
    // would never look again.
    assert.deepEqual(g.runtime.starts, [], "the start waits for the erase");
    assert.ok(fs.existsSync(path.join(legacyHome, "notes", "secret.txt")), "and has not moved the old files");
    release();
    g.runtime.listGate = null;
    await erasing;
    await attempt.done;
    await g.waitReady(alice);
    const privateHome = userPaths(g.dataDir, alice, "private").home;
    assert.deepEqual(fs.existsSync(privateHome) ? fs.readdirSync(privateHome) : [], []);
    assert.equal(fs.existsSync(legacyHome), false);
    assert.equal(g.info(alice).kind, "online");
  }));

// ---------------------------------------------------------------- user ids without a workspace port

test("a user id without a workspace port (AGENT_PORT_COUNT) starts no workspace of either kind: 409 no_workspace_port", () =>
  withGateway({}, async (g) => {
    const now = Date.now();
    for (const id of [g.config.agentPortCount, g.config.agentPortCount + 1]) {
      g.db.insert(users).values({ id, username: `late${id}`, firstName: "L", lastName: "Ate", passwordHash: "x", role: "user", mustChangePassword: false, createdAt: now, updatedAt: now }).run();
      for (const kind of ["private", "online"] as const) {
        const reply = await start(g, id, { kind });
        assert.deepEqual([reply.status, json(reply)], [
          409,
          { error: "no_workspace_port", message: `User ${id} has no workspace port: this portal serves workspaces for user ids 1 to ${g.config.agentPortCount - 1} (AGENT_PORT_COUNT).` },
        ]);
      }
    }
    assert.deepEqual(g.runtime.starts, []);
  }));

test("after AGENT_PORT_COUNT went down, a running container of a user beyond it is removed, not adopted", () =>
  withGateway({ env: { MAX_RUNNING_WORKSPACES: "3" } }, async (g) => {
    const { alice, dave } = g.ids;
    await g.startReady(alice);
    await g.startReady(dave);
    const manager = await restart(g, { ...g.config, agentPortCount: dave });
    assert.deepEqual(g.runtime.runningUsers(), [alice]);
    assert.ok(logged(g, "not adopting a workspace container of a user without a workspace port (AGENT_PORT_COUNT)"));
    await waitFor(() => manager.info(alice).ready, "alice's workspace to be adopted");
  }));
