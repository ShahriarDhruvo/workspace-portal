// The live view (GET /control/live) and LLM engine updates (/control/engine...) of the mock gateway
// (mock-gateway.mjs), with simulated readings: an LLM server like the Strix Halo test machine and a small Intel
// portal server (a 2-core Pentium), LLM sessions that read prompts and write answers for the running workspaces' users, and an engine
// (gufo 0.31.0, releases up to 0.34.0) whose updates download, drain and restart over a few seconds.
//
// Test hooks (no auth), under /__mock: POST /__mock/live?portal=online|offline|off&llm=online|offline|off&load=0..7
// (each server's portal-hostd state; load = how many sessions the simulated users keep busy),
// POST /__mock/engine?fail-next=1 (the next restart fails and rolls back), ?hostd=ok|offline|off, ?reset=1.

const FRAME_MS = 500;
const HISTORY_MS = 60_000;
const GiB = 1024 ** 3;
const REPOSITORY = "ghcr.io/gufo-org/toolboxes/gufo-runtime";
const RELEASES = ["0.34.0", "0.33.0", "0.32.0", "0.31.0", "0.30.0"];
const digestOf = (version) => `sha256:${[...version].map((c) => c.charCodeAt(0).toString(16)).join("").padEnd(64, "0").slice(0, 64)}`;

const LLM_INFO = {
  hostd: 1,
  hostname: "thephilosopher",
  role: "llm",
  os: "Fedora Linux 44 (Server Edition)",
  kernel: "7.2.15-200.fc44.x86_64",
  intervalMs: FRAME_MS,
  cpu: { model: "AMD RYZEN AI MAX+ 395 w/ Radeon 8060S", cores: 16, threads: 32, maxMhz: 5187 },
  gpu: { name: "Radeon 8060S", maxMhz: 2900 },
  memory: { totalBytes: 128 * GiB },
  sources: { perf: true, bandwidth: "amd_df", power: "socket", gpuBusy: "activity" },
  power: { label: "APU socket power" },
  engine: { unit: "gufo.service" },
};
const PORTAL_INFO = {
  hostd: 1,
  hostname: "locust",
  role: "portal",
  os: "Fedora Linux 44 (Server Edition)",
  kernel: "7.2.15-200.fc44.x86_64",
  intervalMs: FRAME_MS,
  cpu: { model: "Intel(R) Pentium(R) CPU G4400T @ 2.90GHz", cores: 2, threads: 2, maxMhz: 2900 },
  gpu: { name: "Intel HD Graphics 510", maxMhz: 950 },
  memory: { totalBytes: 8 * GiB },
  sources: { perf: true, bandwidth: "uncore_imc", power: "rapl", gpuBusy: "pmu" },
  power: { label: "CPU package + DRAM (RAPL)" },
  engine: null,
};

const wave = (t, periodMs, phase = 0) => (Math.sin((t / periodMs) * 2 * Math.PI + phase) + 1) / 2;
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * @param {{ workspaces: () => Array<{ userId: number; status: string; agent: string | null; agentVersion: string | null;
 *   busy: boolean; busyReason: string | null; memoryBytes: number | null; llmInFlight: number; connections: { owner: number; admin: number };
 *   startedAt: number | null }>; userName: (id: number) => string | null; maxRunning: () => number; memoryLimitBytes: number;
 *   audit: (action: string, actorUserId: number | null, details: unknown) => void }} deps
 */
export function createMockLive(deps) {
  const hosts = { portal: "online", llm: "online" };
  let load = 4;
  /** @type {Array<{ slot: number; userId: number; promptTokens: number; cachedTokens: number; processed: number; generated: number; target: number; startedAt: number; readUntil: number | null }>} */
  let sessions = [];
  /** @type {any[]} */
  let recent = [];
  /** @type {Record<"portal" | "llm", any[]>} */
  const history = { portal: [], llm: [] };
  const tokens = [];
  const viewers = new Set();
  let timer = null;
  let queuePaused = false;

  function hostSample(role, t) {
    const busy = sessions.length / 7;
    if (role === "llm") {
      const writing = sessions.filter((s) => s.readUntil !== null).length;
      const reading = sessions.length - writing;
      const gpuUsage = sessions.length === 0 ? 2 : Math.min(99, 55 + 40 * busy + 4 * wave(t, 3000));
      return {
        t,
        cpu: { usage: round(3 + 6 * busy + 2 * wave(t, 7000)), mhz: 3100 + Math.round(400 * wave(t, 5000)), mhzPeak: 5090, tempC: round(52 + 10 * busy), powerW: round(6 + 4 * busy), coreUsage: [], coreMhz: [] },
        gpu: { usage: round(gpuUsage, 0), mhz: sessions.length ? 2720 : 600, tempC: round(48 + 18 * busy + 2 * wave(t, 9000)), powerW: round(8 + 92 * busy), memUsedBytes: 0.4 * GiB, memTotalBytes: 0.5 * GiB },
        memory: {
          totalBytes: 128 * GiB,
          availableBytes: 12.6 * GiB,
          usedBytes: 115.4 * GiB,
          gpuBytes: 111.4 * GiB,
          swapTotalBytes: 8 * GiB,
          swapUsedBytes: 0.2 * GiB,
          readBps: sessions.length ? (writing ? 150e9 : 40e9) + reading * 8e9 + 15e9 * wave(t, 4000) : 1.2e9,
          writeBps: sessions.length ? 9e9 + 3e9 * wave(t, 4000) : 0.3e9,
        },
        power: { watts: round(22 + 120 * busy + 6 * wave(t, 5000)), parts: { gpu: round(8 + 92 * busy), cpu: round(6 + 4 * busy), dram: null } },
        fans: [
          { label: "Fan 1", rpm: Math.round(1800 + 1400 * busy), duty: Math.round(30 + 40 * busy) },
          { label: "Fan 2", rpm: Math.round(1750 + 1350 * busy), duty: Math.round(30 + 40 * busy) },
          { label: "Fan 3", rpm: 0, duty: 0 },
        ],
        throttling: false,
      };
    }
    const running = deps.workspaces().filter((w) => w.status === "running").length;
    return {
      t,
      cpu: { usage: round(6 + 18 * running + 10 * wave(t, 6000)), mhz: 2000 + Math.round(700 * wave(t, 4000)), mhzPeak: 2900, tempC: round(44 + 6 * running), powerW: round(3 + 2 * running), coreUsage: [], coreMhz: [] },
      gpu: { usage: 0, mhz: 350, tempC: null, powerW: 0.1, memUsedBytes: null, memTotalBytes: null },
      memory: {
        totalBytes: 7.6 * GiB,
        availableBytes: (6.3 - 1.4 * running) * GiB,
        usedBytes: (1.3 + 1.4 * running) * GiB,
        gpuBytes: null,
        swapTotalBytes: 4 * GiB,
        swapUsedBytes: 0.1 * GiB,
        readBps: 0.6e9 + 0.4e9 * wave(t, 5000),
        writeBps: 0.2e9,
      },
      power: { watts: round(6.5 + 2.5 * running + wave(t, 5000)), parts: { gpu: 0.1, cpu: round(3 + 2 * running), dram: 1.1 } },
      fans: [],
    };
  }

  /** Moves the simulated sessions on by one frame. */
  function step(t) {
    const running = deps.workspaces().filter((w) => w.status === "running");
    for (const session of sessions) {
      const age = t - session.startedAt;
      if (age < 600) continue;
      const remaining = session.promptTokens - session.cachedTokens - session.processed;
      if (remaining > 0) {
        session.processed += Math.min(remaining, Math.round((2600 / Math.max(1, sessions.length)) * (FRAME_MS / 1000)));
        if (session.processed >= session.promptTokens - session.cachedTokens) session.readUntil = t;
      } else {
        session.generated += Math.round((32 - 1.5 * sessions.length) * (FRAME_MS / 1000) + Math.random());
      }
    }
    const done = sessions.filter((s) => s.generated >= s.target);
    for (const session of done) {
      const readMs = (session.readUntil ?? t) - session.startedAt;
      recent.unshift({
        userId: session.userId,
        userName: deps.userName(session.userId),
        finishedAt: t,
        durationMs: t - session.startedAt,
        ttftMs: readMs,
        promptTokens: session.promptTokens - session.cachedTokens,
        cachedTokens: session.cachedTokens,
        generatedTokens: session.generated,
        readTps: round(((session.promptTokens - session.cachedTokens) * 1000) / Math.max(1, readMs * 0.6), 0),
        writeTps: round(31 - sessions.length, 1),
        ok: true,
      });
    }
    recent = recent.slice(0, 10);
    sessions = sessions.filter((s) => s.generated < s.target);
    if (running.length === 0 || queuePaused) return;
    const free = [0, 1, 2, 3, 4, 5, 6].filter((slot) => !sessions.some((s) => s.slot === slot));
    while (sessions.length < Math.min(load, 7) && free.length > 0) {
      const promptTokens = 6000 + Math.round(Math.random() * 40_000);
      sessions.push({
        slot: free.shift(),
        userId: running[sessions.length % running.length].userId,
        promptTokens,
        cachedTokens: Math.round(promptTokens * (0.5 + Math.random() * 0.45)),
        processed: 0,
        generated: 0,
        target: 80 + Math.round(Math.random() * 900),
        startedAt: t,
        readUntil: null,
      });
    }
  }

  function frame(t) {
    const live = (role) => {
      const state = hosts[role];
      const sample = state === "online" ? history[role].at(-1) ?? null : null;
      return { role, state, error: state === "offline" ? "http://192.168.10.14:9180: connect ECONNREFUSED" : null, info: state === "online" ? (role === "llm" ? LLM_INFO : PORTAL_INFO) : null, sample };
    };
    const rows = [...sessions]
      .sort((a, b) => a.slot - b.slot)
      .map((s) => {
        const writing = s.readUntil !== null;
        const readSpan = (writing ? s.readUntil : t) - s.startedAt;
        return {
          slot: s.slot + 1,
          userId: s.userId,
          userName: deps.userName(s.userId),
          phase: writing ? "writing" : s.processed > 0 ? "reading" : "preparing",
          promptTokens: s.promptTokens,
          cachedTokens: s.cachedTokens,
          processedTokens: s.processed,
          generatedTokens: s.generated,
          readTps: s.processed > 0 && readSpan >= 400 ? round((s.processed * 1000) / readSpan, 0) : null,
          writeTps: writing && t - s.readUntil >= 800 ? round(32 - 1.5 * sessions.length + wave(t, 2000, s.slot), 1) : null,
          startedAt: s.startedAt,
        };
      });
    const totals = {
      readTps: rows.filter((r) => r.phase === "reading").reduce((sum, r) => sum + (r.readTps ?? 0), 0),
      writeTps: rows.filter((r) => r.phase === "writing").reduce((sum, r) => sum + (r.writeTps ?? 0), 0),
    };
    const waiting =
      load > 7 && deps.workspaces().some((w) => w.status === "running")
        ? Array.from({ length: load - 7 }, (_, i) => {
            const userId = deps.workspaces().find((w) => w.status === "running").userId;
            return { userId, userName: deps.userName(userId), since: t - 2000 * (i + 1), stage: "portal" };
          })
        : [];
    const list = deps
      .workspaces()
      .filter((w) => w.status !== "stopped")
      .map((w) => ({
        userId: w.userId,
        userName: deps.userName(w.userId),
        status: w.status,
        agent: w.agent,
        agentVersion: w.agentVersion,
        busy: w.busy || sessions.some((s) => s.userId === w.userId),
        busyReason: w.busy ? "task" : sessions.some((s) => s.userId === w.userId) ? "llm" : null,
        memoryBytes: w.memoryBytes,
        llmInFlight: sessions.filter((s) => s.userId === w.userId).length,
        open: w.connections.owner + w.connections.admin,
        startedAt: w.startedAt,
      }));
    return {
      t,
      hosts: { portal: live("portal"), llm: live("llm") },
      llm: {
        engine: engine.restartingUntil > t ? "loading" : "ready",
        sessionsReported: true,
        engineSessions: 7,
        maxConcurrency: 7,
        inFlight: sessions.length,
        queued: waiting.length,
        paused: queuePaused,
        sessions: rows,
        waiting,
        totals,
        recent,
      },
      workspaces: { maxRunning: deps.maxRunning(), memoryLimitBytes: deps.memoryLimitBytes, list },
    };
  }

  function tick() {
    const t = Date.now();
    step(t);
    for (const role of ["portal", "llm"]) {
      if (hosts[role] !== "online") {
        history[role] = [];
        continue;
      }
      history[role].push(hostSample(role, t));
      history[role] = history[role].filter((s) => s.t >= t - HISTORY_MS);
    }
    const current = frame(t);
    tokens.push({ t, readTps: current.llm.totals.readTps, writeTps: current.llm.totals.writeTps });
    while (tokens.length > HISTORY_MS / FRAME_MS) tokens.shift();
    const payload = `event: frame\ndata: ${JSON.stringify(current)}\n\n`;
    for (const res of viewers) res.write(payload);
  }

  function serveLive(res) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    if (timer === null) timer = setInterval(tick, FRAME_MS);
    viewers.add(res);
    res.write(`event: init\ndata: ${JSON.stringify({ frameMs: FRAME_MS, history: { portal: history.portal, llm: history.llm }, llmHistory: tokens })}\n\n`);
    res.write(`event: frame\ndata: ${JSON.stringify(frame(Date.now()))}\n\n`);
    res.on("close", () => {
      viewers.delete(res);
      if (viewers.size === 0) {
        clearInterval(timer);
        timer = null;
      }
    });
  }

  // ---------------------------------------------------------------- engine
  const engine = {
    hostd: "ok",
    version: "0.31.0",
    previous: null,
    local: new Set(["0.31.0", "0.30.0"]),
    job: null,
    failNext: false,
    restartingUntil: 0,
  };

  function engineStatus() {
    const image = (v) => `${REPOSITORY}@${digestOf(v)}`;
    const loading = engine.restartingUntil > Date.now();
    return {
      unit: "gufo.service",
      quadlet: "/home/thephilosopher/.config/containers/systemd/gufo.container",
      repository: REPOSITORY,
      image: image(engine.version),
      digest: digestOf(engine.version),
      version: engine.version,
      revision: "be7bd3b",
      state: loading ? "activating" : "active",
      subState: loading ? "start" : "running",
      ready: !loading,
      buildInfo: loading ? null : `${engine.version} (be7bd3b)`,
      previous: engine.previous && { image: image(engine.previous), digest: digestOf(engine.previous), version: engine.previous },
      images: [...engine.local]
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
        .map((v, i) => ({ id: digestOf(v).slice(7, 19), digest: digestOf(v), version: v, revision: null, createdAt: Date.now() - (i + 1) * 86_400_000, sizeBytes: 1.9e9, current: v === engine.version, previous: v === engine.previous })),
      job: null,
    };
  }

  function engineOverview() {
    const base = { job: engine.job && { ...engine.job, log: [...engine.job.log], drain: engine.job.drain && { ...engine.job.drain, inFlight: sessions.length } }, drainMinutes: 15 };
    if (engine.hostd === "off") return { ...base, state: "off", error: null, engine: null, releases: null };
    if (engine.hostd === "offline") return { ...base, state: "offline", error: "http://192.168.10.14:9180: connect ECONNREFUSED", engine: null, releases: null };
    return {
      ...base,
      state: "ok",
      error: null,
      engine: engineStatus(),
      releases: {
        repository: REPOSITORY,
        releases: RELEASES.map((version, i) => ({
          version,
          digest: digestOf(version),
          latest: i === 0,
          notes:
            i <= 2
              ? {
                  title: `v${version}`,
                  url: `https://github.com/gufo-org/gufo/releases/tag/v${version}`,
                  publishedAt: Date.now() - (i + 1) * 2 * 86_400_000,
                  body:
                    i === 0
                      ? "## [0.34.0](https://github.com/gufo-org/gufo/compare/v0.33.0...v0.34.0)\n\n### ⚠ BREAKING CHANGES\n\n* **audio:** decode EmbeddingGemma 2 audio in Rust and drop libsndfile and soxr\n\n### Features\n\n* **cli:** deprecate --draft-tokens\n\n### Bug Fixes\n\n* **server:** keep the prompt cache across slot reuse"
                      : `### Features\n\n* improvements in ${version}\n\n### Bug Fixes\n\n* fixes in ${version}`,
                  breaking: i === 0,
                }
              : null,
        })),
        checkedAt: Date.now() - 60_000,
        error: null,
      },
    };
  }

  const note = (line) => {
    engine.job.log.push(line);
  };

  async function runEngineJob(kind, target, actorUserId) {
    const job = engine.job;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const stage = (name, step, cancellable) => Object.assign(job, { stage: name, step, cancellable });
    try {
      if (kind === "update" && !engine.local.has(target)) {
        stage("pulling", `Downloading ${target}`, true);
        note(`Downloading ${target}.`);
        for (let i = 1; i <= 8 && !job.cancel; i++) {
          await sleep(500);
          note(`Copying blob ${i}/8`);
        }
        if (job.cancel) throw new Error("Cancelled.");
        engine.local.add(target);
      }
      const since = Date.now();
      stage("draining", "Waiting for running requests to finish", true);
      job.drain = { since, deadline: since + 15 * 60_000, inFlight: sessions.length };
      queuePaused = true;
      note(`New LLM requests wait in the portal's queue; ${sessions.length} still running.`);
      while (sessions.length > 0 && !job.cancel && !job.restartNow) {
        await sleep(250);
        // Without a viewer of /control/live nothing else moves the sessions on.
        if (timer === null) step(Date.now());
      }
      if (job.cancel) throw new Error("Cancelled.");
      if (job.restartNow) note(`Restarting now on request; ${sessions.length} running request(s) will be cut off.`);
      sessions = [];
      job.drain = null;
      stage("restarting", `Restarting the engine with ${target}`, false);
      note(`Restarting the engine with ${target}.`);
      engine.restartingUntil = Date.now() + 5000;
      await sleep(5000);
      if (engine.failNext) {
        engine.failNext = false;
        job.rolledBack = true;
        note(`The engine did not report ${target}; restoring ${engine.version}.`);
        engine.restartingUntil = Date.now() + 3000;
        await sleep(3000);
        throw new Error(`The engine reported ${engine.version}, not ${target}.`);
      }
      engine.previous = engine.version;
      engine.version = target;
      note("The engine is ready.");
      Object.assign(job, { stage: "succeeded", step: "Done", finishedAt: Date.now(), toVersion: target, cancellable: false });
      deps.audit("engine_updated", actorUserId, { kind, from: job.fromVersion, to: target });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = message === "Cancelled.";
      Object.assign(job, {
        stage: cancelled ? "cancelled" : "failed",
        step: cancelled ? "Cancelled" : job.rolledBack ? "Failed; the previous version runs again" : "Failed",
        error: message,
        finishedAt: Date.now(),
        cancellable: false,
        drain: null,
      });
      deps.audit("engine_update_failed", actorUserId, { kind, from: job.fromVersion, to: target, error: message, rolledBack: job.rolledBack });
    } finally {
      queuePaused = false;
    }
  }

  function startEngineJob(kind, target, actorUserId) {
    engine.job = {
      id: Math.random().toString(16).slice(2, 14),
      kind,
      fromVersion: engine.version,
      toVersion: target,
      image: `${REPOSITORY}@${digestOf(target)}`,
      stage: kind === "update" ? "pulling" : "draining",
      step: "Starting",
      log: [],
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      rolledBack: false,
      drain: null,
      cancellable: true,
      actorUserId,
    };
    void runEngineJob(kind, target, actorUserId);
    return { ...engine.job, log: [] };
  }

  const engineBusy = () => engine.job !== null && engine.job.finishedAt === null;
  const unavailable = () =>
    engine.hostd === "ok" ? null : { status: 503, error: "engine_unavailable", message: engine.hostd === "off" ? "The LLM server's portal-hostd is not set up (HOSTD_LLM_URL, HOSTD_LLM_TOKEN)." : "The LLM server's portal-hostd can't be reached." };

  /** Answers /control/live and /control/engine...; returns [status, body] for JSON answers, or null when it streamed. */
  async function route(method, parts, body, res) {
    if (parts[1] === "live" && method === "GET") {
      serveLive(res);
      return null;
    }
    if (parts[1] !== "engine") return [404, { error: "not_found", message: "Not found" }];
    const action = parts[2];
    if (action === undefined && method === "GET") return [200, engineOverview()];
    if (action === "update" && method === "POST") {
      const down = unavailable();
      if (down) return [down.status, down];
      const { version, actorUserId = null } = body ?? {};
      if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return [400, { error: "invalid_version", message: "version must be a release version, like 0.34.0." }];
      if (!RELEASES.includes(version)) return [404, { error: "version_not_found", message: `the registry has no digest for ${REPOSITORY}:${version}` }];
      if (version === engine.version) return [409, { error: "already_current", message: `The engine already runs ${version}.` }];
      if (engineBusy()) return [409, { error: "engine_job_running", message: "An engine update is running. Wait for it to finish, or cancel it." }];
      return [200, startEngineJob("update", version, actorUserId)];
    }
    if (action === "rollback" && method === "POST") {
      const down = unavailable();
      if (down) return [down.status, down];
      if (engine.previous === null) return [409, { error: "no_previous", message: "There is no previous engine version to go back to." }];
      if (!engine.local.has(engine.previous)) {
        return [409, { error: "not_pulled", message: `The ${engine.previous} image is no longer on the LLM server. Install ${engine.previous} from the list of versions instead.` }];
      }
      if (engineBusy()) return [409, { error: "engine_job_running", message: "An engine update is running. Wait for it to finish, or cancel it." }];
      return [200, startEngineJob("rollback", engine.previous, body?.actorUserId ?? null)];
    }
    if (action === "cancel" && method === "POST") {
      const ok = engineBusy() && engine.job.cancellable;
      if (ok) engine.job.cancel = true;
      return [200, { cancelled: ok }];
    }
    if (action === "restart-now" && method === "POST") {
      const ok = engineBusy() && engine.job.stage === "draining";
      if (ok) engine.job.restartNow = true;
      return [200, { ok }];
    }
    if (action === "images" && method === "DELETE") {
      const digest = decodeURIComponent(parts[3] ?? "");
      const version = [...engine.local].find((v) => digestOf(v) === digest);
      if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return [400, { error: "invalid_digest", message: "digest must be sha256:<64 hex digits>." }];
      if (engineBusy()) return [409, { error: "engine_job_running", message: "An engine update is running. Wait for it to finish, or cancel it." }];
      if (version === undefined) return [404, { error: "not_found", message: "No such image." }];
      if (version === engine.version) return [409, { error: "image_current", message: "The engine runs this image." }];
      engine.local.delete(version);
      return [200, { ok: true }];
    }
    return [405, { error: "method_not_allowed", message: "Not allowed." }];
  }

  /** The /__mock/live and /__mock/engine hooks. */
  function hook(name, params) {
    if (name === "live") {
      for (const role of ["portal", "llm"]) if (params.has(role)) hosts[role] = params.get(role);
      if (params.has("load")) load = Number(params.get("load"));
      return { hosts, load };
    }
    if (params.has("fail-next")) engine.failNext = params.get("fail-next") === "1";
    if (params.has("hostd")) engine.hostd = params.get("hostd");
    if (params.get("reset") === "1") Object.assign(engine, { version: "0.31.0", previous: null, local: new Set(["0.31.0", "0.30.0"]), job: null, failNext: false, restartingUntil: 0 });
    return { hostd: engine.hostd, version: engine.version, previous: engine.previous, failNext: engine.failNext };
  }

  return { route, hook };
}
