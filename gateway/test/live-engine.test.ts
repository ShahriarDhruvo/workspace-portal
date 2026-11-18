// The admin's live view (GET /control/live) and LLM engine updates (/control/engine...) through the
// control API, with the in-process gateway of integration.test.ts and a fake portal-hostd engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { auditLog, type LiveFrame, type LiveInit } from "@portal/core";
import { CONTROL_SECRET, json, startGateway, waitFor, type Gateway, type GatewayOptions } from "./harness.ts";
import { ENGINE_REPOSITORY, engineDigest } from "./fakes.ts";
import { SseParser } from "../src/monitor/hostd.ts";

async function withGateway(options: GatewayOptions, run: (gateway: Gateway) => Promise<void>): Promise<void> {
  const gateway = await startGateway(options);
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
}

/** Opens the live stream and collects its events until `close()`. */
function openLive(g: Gateway, secret = CONTROL_SECRET): Promise<{ status: number; type: string; events: Array<{ event: string; data: unknown }>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: g.ports.control, path: "/control/live", headers: { authorization: `Bearer ${secret}` }, agent: false });
    req.on("error", reject);
    req.on("response", (res) => {
      const events: Array<{ event: string; data: unknown }> = [];
      const parser = new SseParser((event, data) => events.push({ event, data: JSON.parse(data) }));
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => parser.push(chunk));
      res.on("error", () => undefined);
      resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), events, close: () => req.destroy() });
    });
    req.end();
  });
}

test("GET /control/live streams an init event, then frames with the servers and the LLM view (not the workspaces, even with one running); it stops when nobody watches", () =>
  withGateway({}, async (g) => {
    const { alice } = g.ids;
    await g.control("POST", `/control/workspaces/${alice}/start`, {});
    await g.waitReady(alice);

    assert.equal((await openLive(g, "wrong")).status, 401);
    const live = await openLive(g);
    assert.equal(live.status, 200);
    assert.match(live.type, /^text\/event-stream/);
    await waitFor(() => live.events.filter((e) => e.event === "frame").length >= 2, "two frames");
    const [init, first] = live.events;
    assert.equal(init!.event, "init");
    assert.deepEqual(init!.data as LiveInit, { frameMs: 500, history: { portal: [], llm: [] }, llmHistory: [] });
    const frame = first!.data as LiveFrame;
    assert.deepEqual(
      [frame.hosts.portal.state, frame.hosts.llm.state],
      ["off", "off"],
      "no portal-hostd set up in the test gateway",
    );
    assert.equal("workspaces" in frame, false, "the running workspaces are on Admin > Users, not in the live frames");
    assert.deepEqual([frame.llm.maxConcurrency, frame.llm.inFlight, frame.llm.queued, frame.llm.paused], [g.config.llm.maxConcurrency, 0, 0, false]);
    // The fake LLM server has no /slots: the rows come from the gateway's own count.
    const lastFrame = (): LiveFrame => live.events.filter((e) => e.event === "frame").at(-1)!.data as LiveFrame;
    await waitFor(() => lastFrame().llm.engine === "ready", "the engine check");
    assert.equal(lastFrame().llm.sessionsReported, false);
    assert.equal(g.live.viewers, 1);
    const others = await Promise.all(Array.from({ length: 7 }, () => openLive(g)));
    const ninth = await g.control("GET", "/control/live");
    assert.deepEqual([ninth.status, json(ninth)], [429, { error: "too_many_viewers", message: "At most 8 live views can be open at once." }]);
    for (const view of [live, ...others]) view.close();
    await waitFor(() => g.live.viewers === 0, "the viewer to leave");
  }));

test("engine overview, updates (a download, or the image already there) and image removal through the control API", () =>
  withGateway({}, async (g) => {
    const { admin } = g.ids;
    const overview = json<{ state: string; engine: { version: string }; releases: { releases: Array<{ version: string; latest: boolean }> }; job: null; drainMinutes: number }>(
      await g.control("GET", "/control/engine"),
    );
    assert.equal(overview.state, "ok");
    assert.equal(overview.engine.version, "0.31.0");
    assert.equal(overview.drainMinutes, 15);
    assert.deepEqual(overview.releases.releases.slice(0, 2).map((r) => [r.version, r.latest]), [["0.34.0", true], ["0.33.0", false]]);
    assert.equal(overview.job, null);

    const refused = async (method: string, path: string, body: unknown, status: number, error: string): Promise<void> => {
      const reply = await g.control(method, path, body);
      assert.equal(reply.status, status, `${method} ${path} ${JSON.stringify(body)}: ${reply.body}`);
      assert.equal(json<{ error: string }>(reply).error, error);
    };
    await refused("POST", "/control/engine/update", { version: 34 }, 400, "invalid_version");
    await refused("POST", "/control/engine/update", { version: "latest" }, 400, "invalid_version");
    await refused("POST", "/control/engine/update", { version: "0.99.0" }, 404, "version_not_found");
    await refused("POST", "/control/engine/update", { version: "0.31.0" }, 409, "already_current");
    await refused("POST", "/control/engine/update", { version: "0.34.0", actorUserId: 999 }, 400, "invalid_actor");
    await refused("POST", "/control/engine/rollback", {}, 404, "not_found");

    const started = json<{ reuse: boolean; toVersion: string; image: string }>(await g.control("POST", "/control/engine/update", { version: "0.34.0", actorUserId: admin }));
    assert.deepEqual([started.reuse, started.toVersion, started.image], [false, "0.34.0", `${ENGINE_REPOSITORY}@${engineDigest("0.34.0")}`]);
    const running = async () => json<{ running: boolean; agent: boolean; engine: boolean }>(await g.control("GET", "/control/updates/running"));
    const during = await running();
    assert.equal(during.engine, g.engine.snapshot()?.finishedAt === null, "the deploy scripts' check follows the job");
    await waitFor(() => g.engine.snapshot()?.phase === "succeeded", "the update");
    assert.deepEqual(await running(), { running: false, agent: false, engine: false });
    assert.equal(g.engineHost!.version, "0.34.0");
    assert.equal(json<{ engine: { version: string } }>(await g.control("GET", "/control/engine")).engine.version, "0.34.0");
    assert.equal(json<{ ok: boolean }>(await g.control("POST", "/control/engine/restart-now")).ok, false, "no drain to end");
    assert.equal(json<{ cancelled: boolean }>(await g.control("POST", "/control/engine/cancel")).cancelled, false);

    // Back to the version before: its image is on the LLM server, so nothing is downloaded.
    const back = json<{ reuse: boolean }>(await g.control("POST", "/control/engine/update", { version: "0.31.0", actorUserId: admin }));
    assert.equal(back.reuse, true);
    await waitFor(() => g.engine.snapshot()?.toVersion === "0.31.0" && g.engine.snapshot()?.phase === "succeeded", "the switch back");
    assert.equal(g.engineHost!.version, "0.31.0");

    await refused("DELETE", `/control/engine/images/${encodeURIComponent(engineDigest("0.31.0"))}`, undefined, 409, "image_current");
    await refused("DELETE", "/control/engine/images/latest", undefined, 400, "invalid_digest");
    assert.deepEqual(json(await g.control("DELETE", `/control/engine/images/${encodeURIComponent(engineDigest("0.34.0"))}`)), { ok: true });
    const audits = g.db.select().from(auditLog).all().filter((row) => row.action.startsWith("engine_"));
    assert.deepEqual(
      audits.map((row) => [row.action, row.actorUserId]),
      [
        ["engine_updated", admin],
        ["engine_updated", admin],
      ],
      "image removal is the web app's to audit",
    );
  }));

test("engine routes without a portal-hostd for the LLM server", () =>
  withGateway({ engineHost: null }, async (g) => {
    assert.equal(json<{ state: string }>(await g.control("GET", "/control/engine")).state, "off");
    const reply = await g.control("POST", "/control/engine/update", { version: "0.34.0" });
    assert.equal(reply.status, 503);
    assert.equal(json<{ error: string }>(reply).error, "engine_unavailable");
  }));
