// Agent versions over the control API: the admin console's overview, updates (one job at a time,
// cancellable), image removal, and what an update changes for workspaces (new starts only). Uses the
// in-process gateway of integration.test.ts with the fake image builder and npm registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { auditLog } from "@portal/db";
import { json, startGateway, type Gateway, type GatewayOptions, type Reply } from "./harness.ts";
import type { AgentUpdateJob } from "../src/update-job.ts";
import type { AgentVersionsOverview } from "../src/agent-overview.ts";
import { workspaceImage } from "../src/image-names.ts";
import { WorkspaceManager } from "../src/workspaces.ts";
import { gate } from "./fakes.ts";

const BOTH = { env: { WORKSPACE_AGENTS: "qwen,dsh" } } satisfies GatewayOptions;

async function withGateway(options: GatewayOptions, run: (gateway: Gateway) => Promise<void>): Promise<void> {
  const gateway = await startGateway(options);
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
}

const overview = async (g: Gateway, query = ""): Promise<AgentVersionsOverview> => json(await g.control("GET", `/control/agents/versions${query}`));
const update = (g: Gateway, agent: string, body: unknown) => g.control("POST", `/control/agents/${agent}/update`, body);
const removeImage = (g: Gateway, agent: string, version: string) => g.control("DELETE", `/control/agents/${agent}/images/${version}`);
const failure = (reply: Reply) => [reply.status, json<{ error: string }>(reply).error];

/** Agent audit entries (no target user). */
function agentAudits(g: Gateway) {
  return g.db
    .select()
    .from(auditLog)
    .all()
    .filter((row) => row.action.startsWith("agent_"))
    .map((row) => ({ action: row.action, actorUserId: row.actorUserId, details: JSON.parse(row.details ?? "null") }));
}

/** Polls the overview as the admin console does, until the job is `ready`. */
async function pollJob(g: Gateway, ready: (job: AgentUpdateJob) => boolean, what: string): Promise<AgentUpdateJob> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { job } = await overview(g);
    if (job !== null && ready(job)) return job;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const finished = (g: Gateway): Promise<AgentUpdateJob> => pollJob(g, (job) => job.finishedAt !== null, "the update job to finish");

test("an update over the control API: the job, the new current version, and new starts use its image", () =>
  withGateway(BOTH, async (g) => {
    const { alice, bob, admin } = g.ids;
    await g.startReady(alice, "qwen");
    assert.equal(g.info(alice).agentVersion, "0.27.0");

    const before = await overview(g);
    assert.equal(before.job, null);
    assert.equal(before.registryError, null);
    const qwen = before.agents.find((agent) => agent.id === "qwen")!;
    assert.deepEqual(
      { ...qwen, installed: qwen.installed.map((image) => [image.version, image.current, image.inUse]) },
      {
        id: "qwen",
        name: "Qwen Code",
        packageName: "@qwen-code/qwen-code",
        current: "0.27.0",
        defaultVersion: "0.27.0",
        latest: "0.27.4",
        updateAvailable: true,
        channels: [
          { tag: "latest", version: "0.27.4" },
          { tag: "preview", version: "0.27.2-preview.0" },
          { tag: "nightly", version: "0.27.2-nightly.20261113.6f754be654" },
        ],
        installed: [["0.27.0", true, 1]],
        running: [{ version: "0.27.0", count: 1 }],
      },
    );

    const started = await update(g, "qwen", { version: "latest", actorUserId: admin });
    assert.equal(started.status, 200, started.body);
    const job = json<AgentUpdateJob>(started);
    assert.deepEqual([job.agent, job.fromVersion, job.version, job.rebuild, job.reuse, job.actorUserId, job.phase], ["qwen", "0.27.0", "0.27.4", false, false, admin, "building"]);
    const done = await finished(g);
    assert.equal(done.id, job.id);
    assert.equal(done.phase, "succeeded", done.error ?? "");
    assert.equal(done.log.at(-1), "qwen --version: 0.27.4");

    assert.deepEqual(
      json<{ agents: Array<{ id: string; version: string }> }>(await g.control("GET", "/control/agents")).agents.map((a) => [a.id, a.version]),
      [
        ["qwen", "0.27.4"],
        ["dsh", "0.2.2-rc.1"],
      ],
    );
    assert.match(fs.readFileSync(g.config.agentVersionsFile, "utf8"), /^QWEN_CODE_VERSION=0\.27\.4$/m);
    assert.equal(fs.statSync(g.config.agentVersionsFile).mode & 0o777, 0o600);
    assert.deepEqual(agentAudits(g), [{ action: "agent_updated", actorUserId: admin, details: { agent: "qwen", from: "0.27.0", to: "0.27.4", rebuild: false } }]);

    // Running workspaces keep their image; the next start uses the new one.
    assert.equal(g.info(alice).agentVersion, "0.27.0");
    const info = await g.startReady(bob, "qwen");
    assert.equal(info.agentVersion, "0.27.4");
    assert.equal(g.runtime.startsFor(bob)[0]!.options.image, workspaceImage("qwen", "0.27.4"));
    const after = (await overview(g)).agents.find((agent) => agent.id === "qwen")!;
    assert.deepEqual([after.current, after.updateAvailable], ["0.27.4", false]);
    assert.deepEqual(after.installed.map((image) => [image.version, image.current, image.inUse]), [
      ["0.27.4", true, 1],
      ["0.27.0", false, 1],
    ]);
    assert.deepEqual(after.running, [
      { version: "0.27.4", count: 1 },
      { version: "0.27.0", count: 1 },
    ]);

    // The old image goes once no container uses it.
    assert.deepEqual(failure(await removeImage(g, "qwen", "0.27.0")), [409, "image_in_use"]);
    await g.manager.stop(alice, "user");
    assert.equal(g.info(alice).agentVersion, null, "stopped");
    const removed = await removeImage(g, "qwen", "0.27.0");
    assert.deepEqual([removed.status, json(removed)], [200, { ok: true }]);
    assert.equal(g.builder.images.has(workspaceImage("qwen", "0.27.0")), false);
    // A later start of alice's runs the current version.
    assert.equal((await g.startReady(alice)).agentVersion, "0.27.4");
  }));

test("update requests that can't be met are refused with the documented errors", () =>
  withGateway({ env: { WORKSPACE_AGENTS: "qwen" } }, async (g) => {
    const cases: Array<[string, unknown, number, string]> = [
      ["claude", { version: "latest" }, 400, "unknown_agent"],
      ["dsh", { version: "latest" }, 400, "agent_unavailable"],
      ["qwen", { version: "0.27.4 && reboot" }, 400, "invalid_version"],
      ["qwen", { version: "next" }, 400, "invalid_version"],
      ["qwen", { version: "latest", actorUserId: 0 }, 400, "invalid_actor"],
      ["qwen", { version: "latest", actorUserId: "1" }, 400, "invalid_actor"],
      ["qwen", { version: "latest", actorUserId: 9999 }, 400, "invalid_actor"],
      ["qwen", {}, 400, "bad_request"],
      ["qwen", { version: 27 }, 400, "bad_request"],
      ["qwen", { version: "latest", rebuild: "yes" }, 400, "bad_request"],
      ["qwen", [], 400, "bad_request"],
      ["qwen", { version: "9.9.9" }, 404, "version_not_found"],
    ];
    for (const [agent, body, status, error] of cases) {
      assert.deepEqual(failure(await update(g, agent, body)), [status, error], `${agent} ${JSON.stringify(body)}`);
    }
    assert.equal(g.builder.builds.length, 0);

    g.registry.down = true;
    assert.deepEqual(failure(await update(g, "qwen", { version: "latest" })), [502, "registry_unreachable"]);
    assert.deepEqual(failure(await update(g, "qwen", { version: "0.27.4" })), [502, "registry_unreachable"]);
    const outage = await overview(g, "?refresh=1");
    assert.equal(outage.registryError, "The npm registry is unreachable (fetch failed).");
    assert.deepEqual(outage.agents.map((a) => [a.current, a.latest]), [["0.27.0", "0.27.4"]], "the last answer (from resolving a channel above), marked stale");
    assert.deepEqual(agentAudits(g), []);
    assert.equal((await g.control("GET", "/control/agents/versions", undefined, "wrong-secret")).status, 401);
    assert.equal((await g.control("POST", "/control/agents/update/cancel", undefined, "wrong-secret")).status, 401);
  }));

test("one job at a time; it can be cancelled, and a cancelled or failed job leaves the current version", () =>
  withGateway(BOTH, async (g) => {
    const { admin } = g.ids;
    const building = gate();
    g.builder.buildGate = building.promise;
    const first = json<AgentUpdateJob>(await update(g, "dsh", { version: "next", rebuild: true, actorUserId: admin }));
    assert.deepEqual([first.version, first.rebuild, first.phase], ["0.2.2-rc.3", true, "building"]);
    const step = await pollJob(g, (job) => job.step !== null, "the build step");
    assert.equal(step.step, '[dsh 1/2] RUN npm install -g --no-fund --no-audit "@deepseek-ai/dsh@0.2.2-rc.3"');
    assert.deepEqual(failure(await update(g, "qwen", { version: "latest" })), [409, "update_running"], "for all agents");
    g.builder.install("dsh", "0.2.1");
    assert.deepEqual(failure(await removeImage(g, "dsh", "0.2.1")), [409, "update_running"], "not that agent's images meanwhile");
    assert.equal((await overview(g)).job?.phase, "building");

    assert.deepEqual(json(await g.control("POST", "/control/agents/update/cancel")), { cancelled: true });
    const cancelled = await finished(g);
    assert.deepEqual([cancelled.phase, cancelled.error], ["cancelled", "Cancelled"]);
    assert.deepEqual(json(await g.control("POST", "/control/agents/update/cancel")), { cancelled: false });
    assert.equal(g.versions.current("dsh"), "0.2.2-rc.1");

    // The image reports another version than the one asked for: failed, nothing changes.
    g.builder.buildGate = null;
    g.builder.reportVersion = () => "0.2.2-rc.2";
    assert.equal((await update(g, "dsh", { version: "0.2.2-rc.3", actorUserId: admin })).status, 200);
    const failed = await finished(g);
    assert.deepEqual([failed.phase, failed.error], ["failed", "The new image reports DeepSeek Harness 0.2.2-rc.2, not 0.2.2-rc.3."]);
    assert.equal(g.builder.images.has(workspaceImage("dsh", "0.2.2-rc.3")), false);
    assert.deepEqual(
      json<{ agents: Array<{ id: string; version: string }> }>(await g.control("GET", "/control/agents")).agents.find((a) => a.id === "dsh")!.version,
      "0.2.2-rc.1",
    );
    assert.equal(fs.existsSync(g.config.agentVersionsFile), false, "nothing saved");
    const started = await g.startReady(g.ids.alice, "dsh");
    assert.equal(started.agentVersion, "0.2.2-rc.1");
    assert.equal(g.runtime.startsFor(g.ids.alice)[0]!.options.image, workspaceImage("dsh", "0.2.2-rc.1"));
    assert.deepEqual(agentAudits(g), [
      { action: "agent_update_failed", actorUserId: admin, details: { agent: "dsh", version: "0.2.2-rc.3", error: "Cancelled" } },
      { action: "agent_update_failed", actorUserId: admin, details: { agent: "dsh", version: "0.2.2-rc.3", error: "The new image reports DeepSeek Harness 0.2.2-rc.2, not 0.2.2-rc.3." } },
    ]);

    // With the job over, the next one may start.
    g.builder.reportVersion = null;
    assert.equal((await update(g, "qwen", { version: "0.26.0" })).status, 200, "a rollback is an update too");
    assert.equal((await finished(g)).phase, "succeeded");
    assert.equal(g.versions.current("qwen"), "0.26.0");
  }));

test("rolling back to an image still on the server needs neither the registry nor a build", () =>
  withGateway(BOTH, async (g) => {
    const { admin } = g.ids;
    const image = g.builder.install("qwen", "0.26.0");
    g.registry.down = true;
    const started = await update(g, "qwen", { version: "0.26.0", actorUserId: admin });
    assert.equal(started.status, 200, started.body);
    assert.deepEqual(g.registry.calls, [], "the request asked the registry nothing");
    const job = json<AgentUpdateJob>(started);
    assert.deepEqual([job.reuse, job.phase, job.log], [true, "verifying", [`Using the image already on this server (${image}).`]]);
    const done = await finished(g);
    assert.deepEqual([done.phase, done.error], ["succeeded", null]);
    assert.equal(g.builder.builds.length, 0);
    assert.equal(g.versions.current("qwen"), "0.26.0");
    assert.equal((await g.startReady(g.ids.alice, "qwen")).agentVersion, "0.26.0");
    // A rebuild of it does need both.
    assert.deepEqual(failure(await update(g, "qwen", { version: "0.26.0", rebuild: true })), [502, "registry_unreachable"]);
  }));

test("image removal refuses unknown agents, bad versions, missing and current images", () =>
  withGateway(BOTH, async (g) => {
    assert.deepEqual(failure(await removeImage(g, "claude", "1.0.0")), [400, "unknown_agent"]);
    assert.deepEqual(failure(await removeImage(g, "qwen", "latest")), [400, "invalid_version"]);
    assert.deepEqual(failure(await removeImage(g, "qwen", "1.0.0%3Bx")), [400, "invalid_version"]);
    assert.deepEqual(failure(await removeImage(g, "qwen", "0.1.0")), [404, "not_found"]);
    assert.deepEqual(failure(await removeImage(g, "qwen", "0.27.0")), [409, "image_current"]);
    assert.deepEqual(failure(await removeImage(g, "dsh", "0.2.2-rc.1")), [409, "image_current"]);
    assert.ok(g.builder.images.has(workspaceImage("qwen", "0.27.0")));
  }));

test("the admin's choice survives a restart; adopted containers report the version of their image", () =>
  withGateway({ ...BOTH, agentVersionsFile: "# chosen in the admin console\nQWEN_CODE_VERSION=0.26.0\n" }, async (g) => {
    const { alice, bob } = g.ids;
    const agents = json<{ agents: Array<{ id: string; version: string }> }>(await g.control("GET", "/control/agents")).agents;
    assert.deepEqual(agents.map((a) => [a.id, a.version]), [
      ["qwen", "0.26.0"],
      ["dsh", "0.2.2-rc.1"],
    ]);
    const versions = await overview(g);
    assert.deepEqual(versions.agents.map((a) => [a.current, a.defaultVersion]), [
      ["0.26.0", "0.27.0"],
      ["0.2.2-rc.1", "0.2.2-rc.1"],
    ]);
    await g.startReady(alice, "qwen");
    assert.equal(g.runtime.startsFor(alice)[0]!.options.image, workspaceImage("qwen", "0.26.0"));
    await g.startReady(bob, "dsh");
    // bob's image tag moved since (docker shows an image id then): the version is unknown.
    const bobContainer = g.workspaceRow(bob)!.containerId!;
    g.runtime.containers.get(bobContainer)!.image = "sha256:0123abcd";

    g.manager.shutdown();
    const fresh = new WorkspaceManager({
      config: g.config,
      db: g.db,
      runtime: g.runtime,
      versions: g.versions,
      llm: g.llmQueue,
      connections: g.connections,
      log: g.log,
      now: () => g.clock.now,
    });
    await fresh.init();
    g.useManager(fresh);
    assert.equal((await g.waitReady(alice)).agentVersion, "0.26.0", "parsed from the adopted container's image tag");
    assert.equal((await g.waitReady(bob)).agentVersion, null);
    assert.deepEqual((await overview(g)).agents[1]!.running, [{ version: null, count: 1 }]);
  }));
