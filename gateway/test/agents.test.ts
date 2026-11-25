// Which agent a start runs (the user's choice on Home), each agent in a workspace of its own that has nothing in
// common with the user's other ones, one of them running at a time, and how the control API and the agent ports
// present it. Uses the same in-process gateway as integration.test.ts with more than one agent enabled.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { users, workspaces, type WorkspaceInfo, type WorkspaceRef } from "@portal/core";
import { eq } from "drizzle-orm";
import { ALL, BOTH, bearerSubprotocol, json, MIN, tryAgain, upgrade, upgradeStatus, waitFor, withGateway, type Gateway, type Reply } from "./harness.ts";
import { driverFor } from "@portal/harnesses";
import { workspaceImage } from "../src/docker/image-names.ts";
import { userRoot, workspacePaths } from "../src/workspaces/paths.ts";

/** Each agent's Private workspace. */
const QWEN: WorkspaceRef = { agent: "qwen", kind: "private" };
const DSH: WorkspaceRef = { agent: "dsh", kind: "private" };
const OPENCODE: WorkspaceRef = { agent: "opencode", kind: "private" };

const start = (g: Gateway, userId: number, body?: unknown) => g.control("POST", `/control/workspaces/${userId}/start`, body);
const erase = (g: Gateway, userId: number, workspace: WorkspaceRef, body?: unknown): Promise<Reply> =>
  g.control("DELETE", `/control/workspaces/${userId}/files?kind=${workspace.kind}&agent=${workspace.agent}`, body);
/** The workspaces the runtime was asked to start for the user, in order. */
const startedFor = (g: Gateway, userId: number): WorkspaceRef[] => g.runtime.startsFor(userId).map((record) => record.options.ref);

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

test("a start without an agent runs the agent the user chose on Home, else the first enabled agent", () =>
  withGateway(BOTH, async (g) => {
    const { alice, bob } = g.ids;
    // No choice saved: the install's default, the first of WORKSPACE_AGENTS.
    const started = json<WorkspaceInfo>(await start(g, alice));
    assert.equal(started.agent, "qwen");
    await g.waitReady(alice);
    assert.deepEqual(startedFor(g, alice), [QWEN]);
    assert.equal(g.workspaceRow(alice)?.agent, "qwen", "persisted");
    assert.deepEqual(g.auditActions(alice).find((entry) => entry.action === "workspace_started")?.details, { agent: "qwen", version: "0.27.0", kind: "private" });

    // A saved choice wins, whichever kind the start names.
    g.db.update(users).set({ agent: "dsh" }).where(eq(users.id, bob)).run();
    assert.equal(json<WorkspaceInfo>(await start(g, bob)).agent, "dsh");
    await g.waitReady(bob);
    await g.manager.stop(bob, "user");
    assert.equal(json<WorkspaceInfo>(await start(g, bob, { kind: "online" })).agent, "dsh");
    await g.waitReady(bob);
    assert.deepEqual(startedFor(g, bob), [DSH, { agent: "dsh", kind: "online" }]);

    // Changing the choice applies from the next start; a start without an agent attaches to what runs.
    g.db.update(users).set({ agent: "dsh" }).where(eq(users.id, alice)).run();
    assert.equal(json<WorkspaceInfo>(await start(g, alice)).agent, "qwen");
    await g.manager.stop(alice, "user");
    assert.equal(json<WorkspaceInfo>(await start(g, alice)).agent, "dsh");
  }));

test("one workspace at a time: another agent's is refused with another_running while one runs, the running one's start is fine", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, QWEN);
    for (const [body, asked] of [
      [{ agent: "dsh" }, "Private DeepSeek Harness"],
      [{ agent: "dsh", kind: "private" }, "Private DeepSeek Harness"],
      [{ agent: "dsh", kind: "online" }, "Online DeepSeek Harness"],
    ] as const) {
      const refused = await start(g, alice, body);
      assert.deepEqual([refused.status, json(refused)], [
        409,
        { error: "another_running", message: `Your Private Qwen Code workspace is running. Stop it to start the ${asked} one.` },
      ]);
    }
    assert.deepEqual(startedFor(g, alice), [QWEN], "nothing else was started");
    assert.equal(g.runtime.runningUsers().length, 1);

    for (const body of [{ agent: "qwen" }, { agent: "qwen", kind: "private" }, undefined, {}]) {
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
    assert.deepEqual(!during.ok && [during.error.status, during.error.code], [409, "another_running"]);
    await attempt.done;
  }));

test("a start that leaves out the agent or the kind attaches to the workspace that runs, not to the user's choice", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    const dshOnline: WorkspaceRef = { agent: "dsh", kind: "online" };
    // Qwen Code is her choice, and Private what a start without a kind starts; DeepSeek Harness's Online one runs.
    g.db.update(users).set({ agent: "qwen" }).where(eq(users.id, alice)).run();
    await g.startReady(alice, dshOnline);
    for (const body of [undefined, {}, { agent: null, kind: null }, { agent: "dsh" }, { kind: "online" }, dshOnline]) {
      const attached = await start(g, alice, body);
      const info = json<WorkspaceInfo>(attached);
      assert.deepEqual([attached.status, info.status, info.agent, info.kind], [200, "running", "dsh", "online"], JSON.stringify(body));
    }
    assert.deepEqual(startedFor(g, alice), [dshOnline]);

    // What a start does name must be the running one's: otherwise it asks for another workspace, the one it would
    // start were none running (her choice's without an agent, Private without a kind).
    for (const [body, asked] of [
      [{ kind: "private" }, "Private Qwen Code"],
      [{ agent: "qwen" }, "Private Qwen Code"],
      [{ agent: "dsh", kind: "private" }, "Private DeepSeek Harness"],
      [{ agent: "qwen", kind: "online" }, "Online Qwen Code"],
    ] as const) {
      const refused = await start(g, alice, body);
      assert.deepEqual([refused.status, json(refused)], [
        409,
        { error: "another_running", message: `Your Online DeepSeek Harness workspace is running. Stop it to start the ${asked} one.` },
      ]);
    }
    assert.deepEqual(startedFor(g, alice), [dshOnline]);
  }));

test("Try again on a stopped workspace's port starts that port's workspace, not the agent the user chose", () =>
  withGateway(BOTH, async (g) => {
    const { bob } = g.ids;
    g.db.update(users).set({ agent: "dsh" }).where(eq(users.id, bob)).run();
    // A page load starts nothing, on either agent's port.
    for (const [workspace, name] of [[QWEN, "Private Qwen Code"], [DSH, "Private DeepSeek Harness"]] as const) {
      const page = await g.navigate(g.tokens.bob, bob, "/", {}, workspace);
      assert.ok(page.body.includes(`<h1>Your ${name} workspace is stopped</h1>`), page.body);
    }
    assert.deepEqual(startedFor(g, bob), []);

    // Qwen Code's port: Qwen Code, though DeepSeek Harness is what a start from the portal would run.
    const retry = await tryAgain(g, g.tokens.bob, bob, QWEN);
    assert.deepEqual([retry.status, retry.headers.location], [303, "/"]);
    await g.waitReady(bob);
    assert.deepEqual(startedFor(g, bob), [QWEN]);
    assert.equal((await g.navigate(g.tokens.bob, bob, "/", {}, QWEN)).status, 200);

    // The port's kind as well as its agent.
    const qwenOnline: WorkspaceRef = { agent: "qwen", kind: "online" };
    await g.manager.stop(bob, "user");
    assert.equal((await tryAgain(g, g.tokens.bob, bob, qwenOnline)).status, 303);
    await g.waitReady(bob);
    assert.deepEqual(startedFor(g, bob), [QWEN, qwenOnline]);
    assert.deepEqual([g.info(bob).agent, g.info(bob).kind], ["qwen", "online"]);

    // An agent this portal has not enabled has no ports: nothing listens there, so nothing starts from them.
    await g.manager.stop(bob, "user");
    await assert.rejects(tryAgain(g, g.tokens.bob, bob, OPENCODE), { code: "ECONNREFUSED" });
    assert.deepEqual(startedFor(g, bob), [QWEN, qwenOnline]);
    assert.equal(g.info(bob).status, "stopped");
  }));

test("a gateway started with an agent no longer enabled stops the containers of it that it finds, and closes its ports; the others are adopted", () =>
  withGateway({ env: { WORKSPACE_AGENTS: "qwen,dsh", MAX_RUNNING_WORKSPACES: "3" } }, async (g) => {
    const { alice, bob } = g.ids;
    await g.startReady(alice, DSH);
    await g.startReady(bob, QWEN);
    assert.equal((await g.navigate(g.tokens.alice, alice, "/", {}, DSH)).status, 200);
    const manager = await g.restart({ ...g.config, workspace: { ...g.config.workspace, agents: ["qwen"] } });
    assert.deepEqual([manager.info(alice).status, manager.info(alice).stopReason], ["stopped", "agent_unavailable"]);
    assert.deepEqual(g.auditActions(alice).at(-1)?.details, { reason: "agent_unavailable", ...DSH });
    assert.deepEqual(g.runtime.runningUsers(), [bob], "the DeepSeek Harness container is gone; the Qwen Code one runs on");
    await waitFor(() => manager.info(bob).ready, "bob's workspace to be adopted");
    assert.equal(g.runtime.startsFor(bob).length, 1, "adopted, not restarted");
    await assert.rejects(g.navigate(g.tokens.alice, alice, "/", {}, DSH), { code: "ECONNREFUSED" });
    assert.equal(json<{ error: string }>(await start(g, alice, { agent: "dsh" })).error, "agent_unavailable");
  }));

test("a user's harnesses share nothing: each one's workspace has its own folders, UID, container name, ports and browser token", () =>
  withGateway(ALL, async (g) => {
    const { alice } = g.ids;
    // An agent's Private workspace is numbered by the agent's place: every agent has two numbers, Private first.
    const harnesses = [
      { workspace: QWEN, place: 0 },
      { workspace: DSH, place: 2 },
      { workspace: OPENCODE, place: 4 },
    ];
    const userLine = (file: string): string | undefined => fs.readFileSync(file, "utf8").split("\n").find((line) => line.startsWith("user:"));
    for (const { workspace, place } of harnesses) {
      await g.startReady(alice, workspace);
      const paths = workspacePaths(g.dataDir, alice, workspace);
      const root = path.join(g.dataDir, "users", String(alice), workspace.agent, "private");
      assert.deepEqual([paths.home, paths.workspace], [path.join(root, "home"), path.join(root, "workspace")]);
      assert.deepEqual([fs.readdirSync(paths.home), fs.readdirSync(paths.workspace)], [[], []], `${workspace.agent} finds nothing an earlier harness left`);
      fs.writeFileSync(path.join(paths.home, ".history"), workspace.agent);
      fs.writeFileSync(path.join(paths.workspace, "notes.txt"), workspace.agent);

      // WORKSPACE_UID_BASE's default and AGENT_PORT_BASE, plus the workspace's number among everyone's.
      const number = 20 * alice + place;
      const uid = 200_000 + number;
      assert.equal(userLine(paths.passwd), `user:x:${uid}:${uid}:Workspace user:/home/user:/bin/bash`);
      assert.equal(userLine(paths.group), `user:x:${uid}:`);
      assert.equal(g.runtime.containerFor(alice).name, `wp-${workspace.agent}-private-${alice}`);
      assert.equal(g.workspaceRow(alice)?.containerName, `wp-${workspace.agent}-private-${alice}`);
      assert.equal(g.agentPort(alice, workspace), g.config.agentPortBase + number);
      assert.equal(g.previewPort(alice, workspace), g.config.agentPortBase + number + 10_000);
      assert.equal((await g.navigate(g.tokens.alice, alice, "/", {}, workspace)).status, 200, `${workspace.agent} is served on its port`);
      await g.manager.stop(alice, "user");
    }
    assert.deepEqual(startedFor(g, alice), [QWEN, DSH, OPENCODE]);
    assert.equal(new Set(harnesses.map(({ workspace }) => g.browserToken(g.tokens.alice, alice, workspace))).size, 3, "a token per harness");

    // Each has run and written: what is in a harness's folders is still its own alone.
    assert.deepEqual(fs.readdirSync(userRoot(g.dataDir, alice)).sort(), ["dsh", "opencode", "qwen"]);
    for (const { workspace } of harnesses) {
      const paths = workspacePaths(g.dataDir, alice, workspace);
      assert.deepEqual([fs.readdirSync(paths.home), fs.readdirSync(paths.workspace)], [[".history"], ["notes.txt"]]);
      assert.equal(fs.readFileSync(path.join(paths.workspace, "notes.txt"), "utf8"), workspace.agent);
    }
  }));

test("a harness's port never serves another harness: while Qwen Code runs, DeepSeek Harness's answers another_running to a page, a fetch and a socket", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, QWEN);
    const qwen = g.runtime.qwenFor(alice);
    const seen = qwen.requests.length;
    const refusal = { error: "another_running", message: "Your Private Qwen Code workspace is running, not this one (Private DeepSeek Harness)." };

    const page = await g.navigate(g.tokens.alice, alice, "/", {}, DSH);
    assert.equal(page.status, 409);
    assert.ok(page.body.includes("<h1>Your Private Qwen Code workspace is running, not this one</h1>"), page.body);
    assert.ok(page.body.includes("Only one of your workspaces runs at a time. Stop the Private Qwen Code one in the portal to start the Private DeepSeek Harness one."));
    assert.ok(page.body.includes(`href="http://127.0.0.1:${g.config.webPort}/" target="_top"`));
    // As Qwen Code's own page would ask, and as DeepSeek Harness's would.
    for (const [method, target] of [["GET", "/api/sessions"], ["POST", "/api/session/create"]] as const) {
      const api = await g.xhr(g.tokens.alice, alice, { agent: "dsh", method, path: target, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.deepEqual([api.status, json(api)], [409, refusal], `${method} ${target}`);
    }
    const handshake = await upgrade(g, g.tokens.alice, alice, "/api/remote.mux", [], DSH);
    assert.deepEqual([handshake.status, json(handshake)], [409, refusal], "a socket is refused as a fetch is");
    assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { agent: "dsh" }), { status: 409 }, "Qwen Code's own socket path, with this port's token");
    const retry = await tryAgain(g, g.tokens.alice, alice, DSH);
    assert.equal(retry.status, 409, "Try again there doesn't stop or switch anything");
    assert.ok(retry.body.includes("<h1>Your Private Qwen Code workspace is running, not this one</h1>"));
    // The harness's other kind is no nearer.
    const online = await g.xhr(g.tokens.alice, alice, { agent: "dsh", kind: "online", path: "/api/sessions" });
    assert.deepEqual([online.status, json<{ message: string }>(online).message], [409, "Your Private Qwen Code workspace is running, not this one (Online DeepSeek Harness)."]);

    assert.equal(qwen.requests.length, seen, "nothing on DeepSeek Harness's ports reached Qwen Code");
    assert.equal(qwen.sockets.length, 0);
    assert.deepEqual(startedFor(g, alice), [QWEN]);
    assert.deepEqual([g.info(alice).status, g.info(alice).agent], ["running", "qwen"]);
    assert.equal((await g.navigate(g.tokens.alice, alice, "/", {}, QWEN)).status, 200);
  }));

test("a harness's port answers another_running from the start of another of the user's workspaces until its stop has ended", () =>
  withGateway({ ...BOTH, readyAfterMs: 300 }, async (g) => {
    const { alice } = g.ids;
    const refusal = { error: "another_running", message: "Your Private Qwen Code workspace is running, not this one (Private DeepSeek Harness)." };
    const onItsPort = async (): Promise<[number, unknown]> => {
      const api = await g.xhr(g.tokens.alice, alice, { agent: "dsh", path: "/api/sessions" });
      return [api.status, json(api)];
    };

    await g.manager.start(alice, QWEN);
    assert.deepEqual(await onItsPort(), [409, refusal]);
    assert.equal(g.info(alice).status, "starting", "Qwen Code was not ready yet");
    await g.waitReady(alice);

    let finishStop!: () => void;
    g.runtime.stopGate = new Promise<void>((resolve) => (finishStop = resolve));
    const stopping = g.manager.stop(alice, "user");
    assert.equal(g.info(alice).status, "stopping");
    assert.deepEqual(await onItsPort(), [409, refusal]);
    g.runtime.stopGate = null;
    finishStop();
    await stopping;
    assert.deepEqual(await onItsPort(), [503, { error: "workspace_stopped", message: "The workspace is not running." }]);
  }));

test("a harness's browser token is refused on another harness's port, and its origin is a foreign one there", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    const [qwenToken, dshToken] = [g.browserToken(g.tokens.alice, alice, QWEN), g.browserToken(g.tokens.alice, alice, DSH)];
    const invalid = { error: "invalid_token", message: "Reload the portal page to reconnect to your workspace." };
    const sessions = (workspace: WorkspaceRef, bearer: string): Promise<Reply> => g.xhr(g.tokens.alice, alice, { ...workspace, path: "/api/sessions", bearer });
    const socket = (workspace: WorkspaceRef, bearer: string) => g.openSocket(g.tokens.alice, alice, { ...workspace, protocols: ["qwen-ws", bearerSubprotocol(bearer)] });
    assert.notEqual(qwenToken, dshToken);

    // Qwen Code runs: DeepSeek Harness's token, as a page on that origin would have it, opens nothing of it.
    await g.startReady(alice, QWEN);
    const qwen = g.runtime.qwenFor(alice);
    const seen = qwen.requests.length;
    const wrong = await sessions(QWEN, dshToken);
    assert.deepEqual([wrong.status, json(wrong)], [401, invalid]);
    assert.deepEqual(await socket(QWEN, dshToken), { status: 401 });
    const foreign = await g.xhr(g.tokens.alice, alice, { agent: "qwen", method: "POST", path: "/api/echo", headers: { origin: g.agentOrigin(alice, DSH) }, body: "x" });
    assert.deepEqual([foreign.status, json<{ error: string }>(foreign).error], [403, "forbidden_origin"]);
    assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { agent: "qwen", headers: { origin: g.agentOrigin(alice, DSH) } }), { status: 403 });
    assert.equal(qwen.requests.length, seen, "none reached Qwen Code");
    assert.equal(qwen.sockets.length, 0);
    assert.equal((await sessions(QWEN, qwenToken)).status, 200, "its own token does");
    // Nor is Qwen Code's token one on DeepSeek Harness's port, whatever that port would answer next.
    const other = await sessions(DSH, qwenToken);
    assert.deepEqual([other.status, json(other)], [401, invalid]);
    assert.deepEqual(await socket(DSH, qwenToken), { status: 401 });

    // The other way round: DeepSeek Harness runs, and takes no token but its own.
    await g.manager.stop(alice, "user");
    await g.startReady(alice, DSH);
    const dsh = g.runtime.dshFor(alice);
    const reached = dsh.requests.length;
    const swapped = await sessions(DSH, qwenToken);
    assert.deepEqual([swapped.status, json(swapped)], [401, invalid]);
    const crossed = await g.xhr(g.tokens.alice, alice, { agent: "dsh", method: "POST", path: "/api/session/create", bearer: null, headers: { origin: g.agentOrigin(alice, QWEN) }, body: "{}" });
    assert.deepEqual([crossed.status, json<{ error: string }>(crossed).error], [403, "forbidden_origin"]);
    assert.equal(dsh.requests.length, reached, "none reached DeepSeek Harness");
    assert.equal((await g.xhr(g.tokens.alice, alice, { agent: "dsh", method: "POST", path: "/api/session/create", bearer: dshToken, body: "{}", headers: { "content-type": "application/json" } })).status, 200);
  }));

test("erasing one harness's files leaves the user's other harnesses' alone, and is refused only for the one that runs", () =>
  withGateway(ALL, async (g) => {
    const { alice, admin } = g.ids;
    const dshOnline: WorkspaceRef = { agent: "dsh", kind: "online" };
    const all = [QWEN, DSH, dshOnline, OPENCODE];
    const files = (workspace: WorkspaceRef): string[][] => {
      const paths = workspacePaths(g.dataDir, alice, workspace);
      return [fs.readdirSync(paths.home), fs.readdirSync(paths.workspace)];
    };
    // Each has run and left something in its folders; OpenCode's, the last, runs on.
    for (const workspace of all) {
      if (g.info(alice).status === "running") await g.manager.stop(alice, "user");
      await g.startReady(alice, workspace);
      const paths = workspacePaths(g.dataDir, alice, workspace);
      fs.mkdirSync(path.join(paths.home, ".cache"));
      fs.writeFileSync(path.join(paths.workspace, "notes.txt"), "notes");
    }

    const running = await erase(g, alice, OPENCODE, { actorUserId: admin });
    assert.deepEqual([running.status, json(running)], [409, { error: "workspace_running", message: "The Private OpenCode workspace is running. Stop it before erasing its files." }]);
    assert.deepEqual(all.map(files), all.map(() => [[".cache"], ["notes.txt"]]), "nothing was erased");

    // Another of her workspaces, while OpenCode runs: they share nothing.
    assert.deepEqual(json(await erase(g, alice, DSH, { actorUserId: admin })), { ok: true });
    assert.deepEqual(files(DSH), [[], []]);
    assert.deepEqual([QWEN, dshOnline, OPENCODE].map(files), [QWEN, dshOnline, OPENCODE].map(() => [[".cache"], ["notes.txt"]]), "the agent's other kind and the other agents keep theirs");
    assert.deepEqual(g.auditActions(alice).at(-1), { action: "workspace_files_erased", details: { kind: "private", agent: "dsh" }, actorUserId: admin });
    assert.deepEqual([g.info(alice).status, g.info(alice).agent], ["running", "opencode"]);
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
    await g.startReady(alice, QWEN);
    const stopped = json<WorkspaceInfo>(await g.control("POST", `/control/workspaces/${alice}/stop`, { reason: "user", actorUserId: alice }));
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.stopReason, "user");
    assert.equal(g.workspaceRow(alice)?.stopReason, "user");
    assert.equal(g.db.select().from(workspaces).where(eq(workspaces.userId, alice)).get()?.agent, "qwen");
  }));

test("a DeepSeek Harness workspace: its own image, credential and settings, the same sandbox paths", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, DSH);
    const [record] = g.runtime.startsFor(alice);
    assert.deepEqual(record!.options.ref, DSH);
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
    await g.startReady(alice, DSH);
    const dsh = g.runtime.dshFor(alice);

    const page = await g.navigate(g.tokens.alice, alice, "/", {}, DSH);
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
    const api = await g.xhr(g.tokens.alice, alice, { agent: "dsh", method: "POST", path: "/api/session/create", bearer: null, body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(api.status, 200, api.body);
    assert.equal(dsh.requests.at(-1)!.headers.origin, "http://localhost:3080");
    // A token that is presented must still be the right one.
    assert.equal((await g.xhr(g.tokens.alice, alice, { agent: "dsh", bearer: "wrong" })).status, 401);
    // The cookie agent is still only this user's: another user's session gets nothing.
    assert.equal((await g.navigate(g.tokens.bob, alice, "/", {}, DSH)).status, 403);
    // A foreign Origin is refused before anything reaches dsh.
    const before = dsh.requests.length;
    const cross = await g.xhr(g.tokens.alice, alice, { agent: "dsh", method: "POST", path: "/api/session/create", bearer: null, headers: { origin: "http://evil.example" } });
    assert.equal(cross.status, 403);
    assert.equal(dsh.requests.length, before);
  }));

test("dsh: pairing, OAuth and open-in-app are refused in any spelling", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, DSH);
    const dsh = g.runtime.dshFor(alice);
    const before = dsh.requests.length;
    for (const path of ["/connect", "/connect?code=1", "/CONNECT", "/%63onnect", "//connect", "/x/../connect", "/oauth/callback?code=1", "/open-in-app/vscode", "/open-in-app%2Fvscode", "/%ff/../%63onnect"]) {
      const reply = await g.xhr(g.tokens.alice, alice, { agent: "dsh", path, bearer: null });
      assert.equal(reply.status, 403, path);
    }
    assert.equal(dsh.requests.length, before, "none reached dsh");
    // Qwen Code's blocked paths are not dsh's business.
    assert.equal((await g.xhr(g.tokens.alice, alice, { agent: "dsh", path: "/web-shell/pairing", bearer: null })).status, 404);
  }));

test("dsh: only its own socket path, authorised by the session alone, with the minted cookie upstream", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, DSH);
    const dsh = g.runtime.dshFor(alice);

    const open = await g.openSocket(g.tokens.alice, alice, { agent: "dsh", path: "/api/remote.mux", protocols: [] });
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
      const refused = await g.openSocket(g.tokens.alice, alice, { agent: "dsh", path, protocols: [] });
      assert.deepEqual(refused, { status: 404 }, path);
    }
    assert.deepEqual(await g.openSocket(null, alice, { agent: "dsh", path: "/api/remote.mux", protocols: [] }), { status: 401 });
    assert.deepEqual(await g.openSocket(g.tokens.bob, alice, { agent: "dsh", path: "/api/remote.mux", protocols: [] }), { status: 403 });
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

test("switching agents: stop Qwen Code, start DeepSeek Harness, which is served on its own port", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, QWEN);
    const qwenContainer = g.runtime.containerFor(alice).id;
    await g.control("POST", `/control/workspaces/${alice}/stop`, { reason: "user", actorUserId: alice });
    assert.equal(g.runtime.containers.has(qwenContainer), false);
    const started = json<WorkspaceInfo>(await start(g, alice, { agent: "dsh" }));
    assert.equal(started.agent, "dsh");
    await g.waitReady(alice);
    assert.equal(g.runtime.runningUsers().length, 1, "one container per user, whichever agent");
    assert.deepEqual(startedFor(g, alice), [QWEN, DSH]);
    assert.equal((await g.navigate(g.tokens.alice, alice, "/", {}, DSH)).status, 200);
    assert.equal((await g.navigate(g.tokens.alice, alice, "/", {}, QWEN)).status, 409, "Qwen Code's port is not where DeepSeek Harness is");
    assert.deepEqual(g.auditActions(alice).filter((entry) => entry.action === "workspace_started").map((entry) => entry.details), [
      { agent: "qwen", version: "0.27.0", kind: "private" },
      { agent: "dsh", version: "0.2.2-rc.1", kind: "private" },
    ]);
  }));

test("after a gateway restart a running dsh container is adopted with its secret", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, DSH);
    const secret = g.runtime.dshFor(alice).secret;
    const restarted = await g.restart();
    await g.waitReady(alice);
    assert.equal(g.runtime.startsFor(alice).length, 1, "adopted, not restarted");
    assert.equal(restarted.upstream(alice, DSH)?.agent, "dsh");
    assert.equal(restarted.upstream(alice, DSH)?.credential, secret);
    assert.equal(restarted.upstream(alice, QWEN), null);
    assert.equal((await g.navigate(g.tokens.alice, alice, "/", {}, DSH)).status, 200);
  }));

test("an OpenCode workspace: its own image, password and managed settings, the same sandbox paths", () =>
  withGateway(ALL, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, OPENCODE);
    const [record] = g.runtime.startsFor(alice);
    assert.deepEqual(record!.options.ref, OPENCODE);
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
    await g.startReady(alice, OPENCODE);
    const opencode = g.runtime.opencodeFor(alice);
    const basic = `Basic ${Buffer.from(`opencode:${opencode.password}`).toString("base64")}`;

    const page = await g.navigate(g.tokens.alice, alice, "/", {}, OPENCODE);
    assert.equal(page.status, 200, page.body);
    assert.ok(page.body.includes("OpenCode"));
    const seen = opencode.requests.at(-1)!;
    assert.equal(seen.headers.authorization, basic);
    assert.equal(seen.headers.host, `${opencode.host}:${opencode.port}`);
    assert.equal(seen.headers.cookie, undefined, "the portal session never reaches the workspace");
    assert.equal(seen.headers["sec-fetch-site"], undefined);

    // An API call from the page: no bearer token needed (session agent), and no Origin upstream.
    const api = await g.xhr(g.tokens.alice, alice, { agent: "opencode", method: "POST", path: "/api/session", bearer: null, body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(api.status, 200, api.body);
    assert.equal(api.headers["www-authenticate"], undefined, "the browser is never asked for a password");
    const forwarded = opencode.requests.at(-1)!;
    assert.deepEqual([forwarded.status, forwarded.headers.origin, forwarded.headers.authorization], [200, undefined, basic], "OpenCode accepted the password");
    // What the browser presents never replaces the gateway's credential: a token must be this session's, a password is no token.
    assert.equal((await g.xhr(g.tokens.alice, alice, { agent: "opencode", bearer: "wrong" })).status, 401);
    assert.equal((await g.xhr(g.tokens.alice, alice, { agent: "opencode", bearer: null, headers: { authorization: basic } })).status, 401);
    // Still only this user's: another user's session gets nothing, and nobody's gets nothing either.
    assert.equal((await g.navigate(g.tokens.bob, alice, "/", {}, OPENCODE)).status, 403);
    assert.equal((await g.navigate(null, alice, "/", {}, OPENCODE)).status, 401);
    // A foreign Origin is refused before anything reaches OpenCode.
    const before = opencode.requests.length;
    const cross = await g.xhr(g.tokens.alice, alice, { agent: "opencode", method: "POST", path: "/api/session", bearer: null, headers: { origin: "http://evil.example" } });
    assert.equal(cross.status, 403);
    assert.equal(opencode.requests.length, before);
  }));

test("opencode: pairing another browser and a remote machine's link are refused in any spelling", () =>
  withGateway(ALL, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, OPENCODE);
    const opencode = g.runtime.opencodeFor(alice);
    const before = opencode.requests.length;
    const spellings = [
      "/api/pair", "/api/pair?x=1", "/API/Pair", "/api/%70air", "//api//pair", "/x/../api/pair", "/api%2Fpair",
      "/auth/connect/pairing-code", "/api/experimental/machine", "/api/experimental/machine/link",
      // An escape that is no character must not keep the others from being read (OpenCode's router decodes them).
      "/%ff/../api/%70air", "/%/../auth/%63onnect/pairing-code", "/%c0%af/../api/experimental/%6dachine",
    ];
    for (const path of spellings) {
      const reply = await g.xhr(g.tokens.alice, alice, { agent: "opencode", method: "POST", path, bearer: null, body: "{}" });
      assert.deepEqual([reply.status, json<{ error: string }>(reply).error], [403, "not_available"], path);
    }
    assert.equal((await g.navigate(g.tokens.alice, alice, "/auth/connect/pairing-code", {}, OPENCODE)).status, 403);
    assert.equal(opencode.requests.length, before, "none reached OpenCode");
    // OpenCode would open the machine link to anyone; it is no socket of its page.
    assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { agent: "opencode", path: "/api/experimental/machine/link", protocols: [] }), { status: 404 });
    assert.equal(opencode.sockets.length, 0);
    // The other agents' blocked paths are not OpenCode's business.
    assert.equal((await g.xhr(g.tokens.alice, alice, { agent: "opencode", path: "/connect", bearer: null })).status, 404);
  }));

test("opencode: a terminal's socket, at its own path only, authorised by the session alone", () =>
  withGateway(ALL, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, OPENCODE);
    const opencode = g.runtime.opencodeFor(alice);
    const basic = `Basic ${Buffer.from(`opencode:${opencode.password}`).toString("base64")}`;
    const terminal = "/api/experimental/persistent-pty/pty_persistent_1";

    // As OpenCode's page does: a ticket first (OpenCode gives one to its own page only), then the socket with it.
    const asked = await g.xhr(g.tokens.alice, alice, { agent: "opencode", method: "POST", path: `${terminal}/connect-token`, bearer: null, headers: { "x-opencode-ticket": "1" } });
    assert.equal(asked.status, 200, asked.body);
    const { ticket } = json<{ data: { ticket: string } }>(asked).data;
    const open = await g.openSocket(g.tokens.alice, alice, { agent: "opencode", path: `${terminal}/connect?cursor=0&ticket=${ticket}`, protocols: [] });
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
      assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { agent: "opencode", path, protocols: [] }), { status: 404 }, path);
    }
    // Nor a target as no browser writes one, which the workspace's server would read as another path.
    for (const target of ["/api/experimental/persistent-pty/../connect", "/api/experimental/persistent-pty/..%2f..%2fmachine%2flink/connect", "/api/experimental/persistent-pty/a\\b/connect"]) {
      assert.equal(await upgradeStatus(g, g.tokens.alice, alice, target, [], OPENCODE), 404, target);
    }
    // A target with a "#" is refused, not connected to.
    assert.equal(await upgradeStatus(g, g.tokens.alice, alice, `${terminal}/connect?ticket=${ticket}#x`, [], OPENCODE), 400);
    assert.equal(opencode.sockets.length, accepted);
    assert.deepEqual(await g.openSocket(null, alice, { agent: "opencode", path: `${terminal}/connect`, protocols: [] }), { status: 401 });
    assert.deepEqual(await g.openSocket(g.tokens.bob, alice, { agent: "opencode", path: `${terminal}/connect`, protocols: [] }), { status: 403 });
    assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { agent: "opencode", path: `${terminal}/connect`, protocols: [], headers: { origin: "http://evil.example" } }), { status: 403 });
    // A ticket OpenCode doesn't know is its refusal to make.
    assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { agent: "opencode", path: `${terminal}/connect?ticket=made-up`, protocols: [] }), { status: 403 });
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
    await g.startReady(alice, OPENCODE);
    const send = (method: string, path: string) =>
      g.xhr(g.tokens.alice, alice, { agent: "opencode", method, path, bearer: null, ...(method === "GET" ? {} : { body: "{}", headers: { "content-type": "application/json", "x-opencode-ticket": "1" } }) });
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

test("switching agents: stop Qwen Code, start OpenCode; after a gateway restart it is adopted with its password", () =>
  withGateway(ALL, async (g) => {
    const { alice } = g.ids;
    await g.startReady(alice, QWEN);
    await g.control("POST", `/control/workspaces/${alice}/stop`, { reason: "user", actorUserId: alice });
    assert.equal(json<WorkspaceInfo>(await start(g, alice, { agent: "opencode" })).agent, "opencode");
    await g.waitReady(alice);
    assert.deepEqual(startedFor(g, alice), [QWEN, OPENCODE]);
    const other = await start(g, alice, { agent: "dsh" });
    assert.deepEqual([other.status, json<{ message: string }>(other).message], [409, "Your Private OpenCode workspace is running. Stop it to start the Private DeepSeek Harness one."]);

    const { password } = g.runtime.opencodeFor(alice);
    const restarted = await g.restart();
    await g.waitReady(alice);
    assert.equal(g.runtime.startsFor(alice).length, 2, "adopted, not restarted");
    assert.deepEqual([restarted.upstream(alice, OPENCODE)?.agent, restarted.upstream(alice, OPENCODE)?.credential], ["opencode", password]);
    assert.equal((await g.navigate(g.tokens.alice, alice, "/", {}, OPENCODE)).status, 200);
  }));
