// The live view (GET /control/live) and LLM engine updates (/control/engine...) of the mock gateway
// (mock-gateway.mjs), with simulated readings: an LLM server like the Strix Halo test machine and a small Intel
// portal server (a 2-core Pentium), LLM sessions that read prompts and write answers for the running workspaces' users, and an engine
// (gufo 0.31.0, releases up to 0.34.0) whose updates download, drain and restart over a few seconds.
//
// The energy meter is simulated too: at start the mock's database gets about 400 days of plausible daily totals per
// server in host_daily (INSERT OR IGNORE, so a restart keeps what is there), and a meter that runs without viewers,
// like the gateway's, adds each online server's simulated power and traffic to today's row (in the frames' `today`).
//
// Test hooks (no auth), under /__mock: POST /__mock/live?portal=online|offline|off&llm=online|offline|off&load=0..7
// (each server's portal-hostd state; load = how many sessions the simulated users keep busy),
// POST /__mock/engine?fail-next=1 (the next restart fails and rolls back), ?hostd=ok|offline|off, ?reset=1.

import path from "node:path";
import Database from "better-sqlite3";

const FRAME_MS = 500;
const HISTORY_MS = 60_000;
/** How often the simulated energy meter adds to today's rows (the gateway's polls every 30 s). */
const METER_MS = 2000;
const HISTORY_DAYS = 400;
const GiB = 1024 ** 3;
const REPOSITORY = "ghcr.io/gufo-org/toolboxes/gufo-runtime";
/** The image registry's release tags, newest first; latest is the first. */
const RELEASES = ["0.34.0", "0.33.0", "0.32.0", "0.31.0", "0.30.0", "0.29.0", "0.28.0"];
/** Releases with notes on GitHub, and how many days ago each was published (0.30.0 has none). */
const NOTED = { "0.34.0": 2, "0.33.0": 6, "0.32.0": 13, "0.31.0": 20, "0.29.0": 41, "0.28.0": 55 };
const ENGINE_START = { version: "0.31.0", local: ["0.31.0", "0.29.0"] };
const digestOf = (version) => `sha256:${[...version].map((c) => c.charCodeAt(0).toString(16)).join("").padEnd(64, "0").slice(0, 64)}`;

const LLM_INFO = {
  hostd: 2,
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
  network: { interfaces: ["enp191s0"] },
  disks: { devices: ["nvme0n1"], mounts: ["/", "/boot/efi", "/boot"] },
};
const PORTAL_INFO = {
  hostd: 2,
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
  network: { interfaces: ["eno1"] },
  disks: { devices: ["sda"], mounts: ["/", "/boot/efi", "/boot"] },
};

const wave = (t, periodMs, phase = 0) => (Math.sin((t / periodMs) * 2 * Math.PI + phase) + 1) / 2;
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const pad = (n) => String(n).padStart(2, "0");
/** YYYY-MM-DD in the local time zone, as @portal/db's usageDay(). */
const localDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** A number in [0, 1) that depends only on the text, so the seeded history is the same on every start. */
function noise(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/**
 * A plausible full day of the meter for a server: the LLM server 150..1,200 Wh by how busy the users kept it
 * (quieter at weekends), the portal 15..45 Wh; a few hundred MB to a few GB of traffic, and on rare days a
 * model download (tens of GB) on the LLM server.
 */
function dailyTotals(day, role) {
  const weekend = [0, 6].includes(new Date(`${day}T12:00:00`).getDay());
  const busy = Math.min(1, (weekend ? 0.35 : 1) * (0.15 + 0.85 * noise(`${day} load`)));
  const jitter = (key) => 0.85 + 0.3 * noise(`${day} ${role} ${key}`);
  if (role === "llm") {
    const download = noise(`${day} download`) < 0.02 ? (8 + 30 * noise(`${day} size`)) * 1e9 : 0;
    return {
      energyWh: round((150 + 1050 * busy) * jitter("energy"), 1),
      rxBytes: Math.round((0.25e9 + 1.6e9 * busy) * jitter("rx") + download),
      txBytes: Math.round((0.12e9 + 0.5e9 * busy) * jitter("tx")),
    };
  }
  return {
    energyWh: round((15 + 30 * busy) * jitter("energy"), 1),
    rxBytes: Math.round((0.35e9 + 2.8e9 * busy) * jitter("rx")),
    txBytes: Math.round((0.3e9 + 1.8e9 * busy) * jitter("tx")),
  };
}

/**
 * @param {{ workspaces: () => Array<{ userId: number; status: string; agent: string | null; kind: string; agentVersion: string | null;
 *   busy: boolean; busyReason: string | null; memoryBytes: number | null; llmInFlight: number; connections: { owner: number; admin: number };
 *   startedAt: number | null }>; userName: (id: number) => string | null;
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
    const writing = sessions.filter((s) => s.readUntil !== null).length;
    const reading = sessions.length - writing;
    const pulling = engine.job?.stage === "pulling";
    if (role === "llm") {
      const gpuUsage = sessions.length === 0 ? 2 : Math.min(99, 55 + 40 * busy + 4 * wave(t, 3000));
      return {
        t,
        cpu: { usage: round(3 + 6 * busy + 2 * wave(t, 7000)), mhz: 3100 + Math.round(400 * wave(t, 5000)), mhzPeak: 5090, tempC: round(52 + 10 * busy), powerW: round(3 + 4 * busy), coreUsage: [], coreMhz: [] },
        gpu: { usage: round(gpuUsage, 0), mhz: sessions.length ? 2720 : 600, tempC: round(48 + 18 * busy + 2 * wave(t, 9000)), powerW: round(2 + 92 * busy), memUsedBytes: 0.4 * GiB, memTotalBytes: 0.5 * GiB },
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
        power: { watts: round(7 + 120 * busy + 2 * wave(t, 5000)), parts: { gpu: round(2 + 92 * busy), cpu: round(3 + 4 * busy), dram: null } },
        fans: [
          { label: "Fan 1", rpm: Math.round(1800 + 1400 * busy), duty: Math.round(30 + 40 * busy) },
          { label: "Fan 2", rpm: Math.round(1750 + 1350 * busy), duty: Math.round(30 + 40 * busy) },
          { label: "Fan 3", rpm: 0, duty: 0 },
        ],
        throttling: false,
        // Prompts in from the portal, answers out; an engine update's download fills the line.
        net: { rxBps: Math.round(4e3 + reading * 90e3 + 3e3 * wave(t, 3000) + (pulling ? 92e6 : 0)), txBps: Math.round(2e3 + writing * 3e3 + 1e3 * wave(t, 4000)) },
        disk: {
          readBps: Math.round(sessions.length ? 0.4e6 * wave(t, 6000) : 0),
          writeBps: Math.round(60e3 + 40e3 * wave(t, 7000) + (pulling ? 88e6 : 0)),
          totalBytes: 1_998_301_216_768,
          freeBytes: 1_127_548_862_464,
        },
      };
    }
    const running = deps.workspaces().filter((w) => w.status === "running").length;
    const llmNet = hostSample("llm", t).net;
    return {
      t,
      cpu: { usage: round(6 + 18 * running + 10 * wave(t, 6000)), mhz: 2000 + Math.round(700 * wave(t, 4000)), mhzPeak: 2900, tempC: round(44 + 6 * running), powerW: round(0.6 + 0.5 * running), coreUsage: [], coreMhz: [] },
      gpu: { usage: 0, mhz: 350, tempC: null, powerW: 0.05, memUsedBytes: null, memTotalBytes: null },
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
      power: { watts: round(0.9 + 0.5 * running + 0.3 * wave(t, 5000)), parts: { gpu: 0.05, cpu: round(0.6 + 0.5 * running), dram: 0.3 } },
      fans: [],
      // The LLM proxy forwards the prompts (out) and the answers (in); the workspaces fetch packages and pages.
      net: { rxBps: Math.round(3e3 + llmNet.txBps + running * 35e3 * wave(t, 8000)), txBps: Math.round(2e3 + llmNet.rxBps + running * 6e3 * wave(t, 5000)) },
      disk: {
        readBps: Math.round(running * 150e3 * wave(t, 9000)),
        writeBps: Math.round(40e3 + running * 220e3 * wave(t, 6500)),
        totalBytes: 254_356_226_048,
        freeBytes: 181_904_322_560 - running * 1_350_000_000,
      },
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
      return {
        role,
        state,
        error: state === "offline" ? "http://192.168.10.14:9180: connect ECONNREFUSED" : null,
        info: state === "online" ? (role === "llm" ? LLM_INFO : PORTAL_INFO) : null,
        sample,
        today: state !== "off" && today[role] ? { ...today[role] } : null,
      };
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

  // ---------------------------------------------------------------- energy meter
  const db = new Database(path.join(process.env.PORTAL_DATA_DIR || "/srv/workspace-portal", "db", "portal.sqlite"), { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  /** Today's host_daily row per server, as the gateway's meter keeps it in memory for the frames. */
  const today = { portal: null, llm: null };
  const insertDay = db.prepare("INSERT OR IGNORE INTO host_daily (day, role, energy_wh, rx_bytes, tx_bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  const readDay = db.prepare("SELECT day, energy_wh AS energyWh, rx_bytes AS rxBytes, tx_bytes AS txBytes FROM host_daily WHERE day = ? AND role = ?");
  const addToDay = db.prepare(
    "UPDATE host_daily SET energy_wh = coalesce(energy_wh, 0) + ?, rx_bytes = rx_bytes + ?, tx_bytes = tx_bytes + ?, updated_at = ? WHERE day = ? AND role = ?",
  );

  /** Fills in the past HISTORY_DAYS days and today so far (the share of a whole day gone by), then loads today's rows. */
  function seedHistory(now) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const share = (now - midnight.getTime()) / 86_400_000;
    db.transaction(() => {
      for (let back = HISTORY_DAYS; back >= 0; back--) {
        const date = new Date(midnight);
        date.setDate(date.getDate() - back);
        const day = localDay(date);
        const part = back === 0 ? share : 1;
        const end = new Date(date);
        end.setDate(end.getDate() + 1);
        for (const role of ["portal", "llm"]) {
          const totals = dailyTotals(day, role);
          insertDay.run(day, role, round(totals.energyWh * part, 3), Math.round(totals.rxBytes * part), Math.round(totals.txBytes * part), back === 0 ? now : end.getTime() - 1);
        }
      }
    })();
    for (const role of ["portal", "llm"]) today[role] = readDay.get(localDay(midnight), role);
  }

  let meteredAt = Date.now();
  seedHistory(meteredAt);

  /** Adds each online server's power and traffic since the last call to today's row (a new row after midnight). */
  function meter() {
    const t = Date.now();
    const seconds = (t - meteredAt) / 1000;
    meteredAt = t;
    const day = localDay(new Date(t));
    for (const role of ["portal", "llm"]) {
      if (today[role]?.day !== day) insertDay.run(day, role, 0, 0, 0, t);
      if (hosts[role] === "online") {
        const sample = hostSample(role, t);
        addToDay.run((sample.power.watts * seconds) / 3600, Math.round(sample.net.rxBps * seconds), Math.round(sample.net.txBps * seconds), t, day, role);
      }
      today[role] = readDay.get(day, role);
    }
  }
  setInterval(meter, METER_MS).unref();

  // ---------------------------------------------------------------- engine
  const engine = {
    hostd: "ok",
    version: ENGINE_START.version,
    previous: null,
    local: new Set(ENGINE_START.local),
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
        // As the gateway lists them: the 5 newest up to latest, then the versions that run or are on the LLM server.
        releases: [...new Set([...RELEASES.slice(0, 5), engine.version, ...engine.local])]
          .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
          .map((version) => ({
            version,
            digest: digestOf(version),
            latest: version === RELEASES[0],
            notes:
              version in NOTED
                ? {
                    title: `v${version}`,
                    url: `https://github.com/gufo-org/gufo/releases/tag/v${version}`,
                    publishedAt: Date.now() - NOTED[version] * 86_400_000,
                    body:
                      version === "0.34.0"
                        ? "## [0.34.0](https://github.com/gufo-org/gufo/compare/v0.33.0...v0.34.0)\n\n### ⚠ BREAKING CHANGES\n\n* **audio:** decode EmbeddingGemma 2 audio in Rust and drop libsndfile and soxr\n\n### Features\n\n* **cli:** deprecate --draft-tokens\n\n### Bug Fixes\n\n* **server:** keep the prompt cache across slot reuse"
                        : `### Features\n\n* improvements in ${version}\n\n### Bug Fixes\n\n* fixes in ${version}`,
                    breaking: version === "0.34.0",
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

  async function runEngineJob(target, actorUserId) {
    const job = engine.job;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const stage = (name, step, cancellable) => Object.assign(job, { stage: name, step, cancellable });
    try {
      if (job.reuse) note(`Using the image already on the LLM server (${job.image}).`);
      else {
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
      deps.audit("engine_updated", actorUserId, { from: job.fromVersion, to: target });
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
      deps.audit("engine_update_failed", actorUserId, { from: job.fromVersion, to: target, error: message, rolledBack: job.rolledBack });
    } finally {
      queuePaused = false;
    }
  }

  /** An image of that version on the LLM server is used as it is (no download, no registry), as on the gateway. */
  function startEngineJob(target, actorUserId) {
    const reuse = engine.local.has(target);
    engine.job = {
      id: Math.random().toString(16).slice(2, 14),
      fromVersion: engine.version,
      toVersion: target,
      image: `${REPOSITORY}@${digestOf(target)}`,
      reuse,
      stage: reuse ? "draining" : "pulling",
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
    void runEngineJob(target, actorUserId);
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
      if (!RELEASES.includes(version) && !engine.local.has(version)) return [404, { error: "version_not_found", message: `the registry has no digest for ${REPOSITORY}:${version}` }];
      if (version === engine.version) return [409, { error: "already_current", message: `The engine already runs ${version}.` }];
      if (engineBusy()) return [409, { error: "engine_job_running", message: "An engine update is running. Wait for it to finish, or cancel it." }];
      return [200, startEngineJob(version, actorUserId)];
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
    if (params.get("reset") === "1") {
      Object.assign(engine, { version: ENGINE_START.version, previous: null, local: new Set(ENGINE_START.local), job: null, failNext: false, restartingUntil: 0 });
    }
    return { hostd: engine.hostd, version: engine.version, previous: engine.previous, failNext: engine.failNext };
  }

  return { route, hook };
}
