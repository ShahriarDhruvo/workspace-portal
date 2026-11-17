// Workspace Portal gateway: owns the per-user agent containers (Qwen Code or DeepSeek Harness; a Private and an
// Online workspace per user, one running at a time), proxies browsers to them (one port per user and kind), and
// serves the LLM and web search to them (one service listener per kind, on that kind's network).
// See docs/ARCHITECTURE.md.
import type http from "node:http";
import { getDatabase, loadSessionContext, WORKSPACE_KINDS, type WorkspaceKind } from "@portal/db";
import { createAgentServerFactory } from "./agent-proxy.ts";
import { AgentUpdater } from "./agent-updater.ts";
import { AgentVersions } from "./agent-versions.ts";
import { AgentConfigError, driverFor } from "./agents/index.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { ConnectionRegistry } from "./connections.ts";
import { createControlServer } from "./control-api.ts";
import { DockerImageBuilder } from "./docker-image-builder.ts";
import { DockerRuntime, isSupportedDockerVersion, MIN_DOCKER_VERSION_TEXT } from "./docker-runtime.ts";
import { EnergyMeter } from "./energy-meter.ts";
import { EnergyPrices } from "./energy-prices.ts";
import { fenceCheck } from "./fence.ts";
import { createNotesClient, createRegistryClient, EngineReleases } from "./engine-releases.ts";
import { createEngineHost, EngineUpdater } from "./engine-updater.ts";
import { createGitHubReleases } from "./github-releases.ts";
import { HostMonitor } from "./host-monitor.ts";
import { HostdClient } from "./hostd.ts";
import { listen } from "./listen.ts";
import { LiveHub, userNames } from "./live.ts";
import { LlmMonitor } from "./llm-monitor.ts";
import { LlmQueue } from "./llm-queue.ts";
import { LlmEnergy } from "./llm-energy.ts";
import { LlmRequests } from "./llm-requests.ts";
import { createLogger, type Logger } from "./log.ts";
import { createNpmRegistry } from "./npm-registry.ts";
import { createReaderBackend, withPageCache } from "./reader.ts";
import { ReleaseCache } from "./release-cache.ts";
import { createSearxngBackend } from "./search-mcp.ts";
import { createServiceServer } from "./service-api.ts";
import { SessionCache } from "./session-cache.ts";
import { SessionLog } from "./session-log.ts";
import { WorkspaceManager } from "./workspaces.ts";

/** How long the service listeners wait for the workspace bridge address to appear. */
const BRIDGE_WAIT_MS = 60_000;
/** On SIGTERM, time for close frames and the last responses to go out before exiting. */
const SHUTDOWN_GRACE_MS = 1_000;

async function main(log: Logger): Promise<void> {
  const config = readConfig(log);

  for (const agent of config.workspace.agents) {
    const driver = driverFor(agent);
    try {
      // The kinds differ only in the service address, so one rendering finds every problem.
      driver.renderSettings(config, "private");
    } catch (error) {
      // Not fatal: the portal keeps working, and starts of this agent report the same problem.
      if (!(error instanceof AgentConfigError)) throw error;
      log.error(`${driver.name} settings are invalid; its workspaces cannot start until they are fixed`, { error: error.message });
    }
  }
  const db = getDatabase(config.dbFile);
  // The version (and image) new workspaces of each agent start with: the admin's choice, else .env.
  const versions = AgentVersions.fromConfig(config, log);
  log.info("agent versions", {
    agents: Object.fromEntries(config.workspace.agents.map((agent) => [agent, { current: versions.current(agent), default: versions.defaultVersion(agent) }])),
  });

  const runtime = new DockerRuntime(config);
  const dockerVersion = await runtime.engineVersion();
  if (!isSupportedDockerVersion(dockerVersion)) {
    log.error(
      `Docker Engine ${dockerVersion || "(unknown version)"} is not supported: ${MIN_DOCKER_VERSION_TEXT} or later is required, because older engines let containers on internal networks resolve outside names (CVE-2024-29018)`,
      { version: dockerVersion, minimum: MIN_DOCKER_VERSION_TEXT },
    );
    process.exit(1);
  }
  // Online's network only while Online workspaces are on; one that exists from before stays as it is, unused.
  const kinds: WorkspaceKind[] = WORKSPACE_KINDS.filter((kind) => kind === "private" || config.workspace.onlineEnabled);
  for (const kind of kinds) {
    const own = config.workspace.kinds[kind];
    const network = await runtime.ensureNetwork(kind);
    if (network !== "exists") log.info(`${network} the ${kind} workspace network`, { network: own.network, subnet: own.subnet, internal: kind === "private" });
  }
  if (!config.workspace.onlineEnabled) log.info("Online workspaces are off (ONLINE_WORKSPACES=off): only Private workspaces start");
  for (const agent of config.workspace.agents) {
    const { image } = versions.selection(agent);
    if (!(await runtime.imageAvailable(image))) {
      log.error(`${driverFor(agent).name} workspace image not found; its workspaces cannot start until it is built`, {
        image,
        hint: "update the agent in the admin console (Agents), or: sudo bash deploy/install.sh",
      });
    }
  }

  const llm = new LlmQueue(config.llm.maxConcurrency, config.llm.maxConcurrencyPerUser);
  // Each run of a workspace and what its LLM requests added up to, energy included (Admin > Usage).
  const sessionLog = new SessionLog({ db, log });
  const llmEnergy = new LlmEnergy({
    source: config.hostd.llm.token === "" ? null : new HostdClient(config.hostd.llm),
    onShares: (shares) => sessionLog.addEnergy(shares),
    log,
  });
  const requests = new LlmRequests({
    listener: {
      forwarded: (request) => {
        const sessionId = sessionLog.forwarded(request.id, request.userId);
        if (sessionId !== null) llmEnergy.started(request.id, sessionId, request.forwardedAt);
      },
      finished: (request) => {
        llmEnergy.ended(request.id, request.finishedAt);
        sessionLog.finished(request);
      },
    },
  });
  const connections = new ConnectionRegistry();
  const sessions = new SessionCache((tokenHash) => loadSessionContext(db, tokenHash));
  // Online workspaces run only while the host firewall that fences them in answers (deploy/firewall.sh, fence.ts).
  const fence = fenceCheck(config.servicePort);
  const manager = new WorkspaceManager({ config, db, runtime, versions, llm, connections, log, fence, sessions: sessionLog });
  await manager.init();
  sessionLog.reconcile(manager.list());
  manager.startBackgroundTasks();
  const registry = createNpmRegistry();
  const updater = new AgentUpdater({
    config,
    versions,
    builder: new DockerImageBuilder({ contextDir: config.imageContextDir }),
    registry,
    releases: new ReleaseCache({ registry, github: createGitHubReleases(), log }),
    workspaces: () => manager.list(),
    db,
    log,
  });
  // Before the control API listens, so no job can start meanwhile: a gateway that stopped mid-update
  // leaves its staging image (and maybe a version-check container) behind.
  await updater.sweep();

  // The admin's live view and engine updates, through each server's portal-hostd.
  const hosts = {
    portal: new HostMonitor({ role: "portal", config: config.hostd.portal, log }),
    llm: new HostMonitor({ role: "llm", config: config.hostd.llm, log }),
  };
  const llmMonitor = new LlmMonitor({
    upstreamUrl: config.llm.upstreamUrl,
    apiKey: config.llm.apiKey,
    queue: llm,
    requests,
    names: (ids) => userNames(db, ids),
    log,
  });
  // Each server's energy and traffic per day (Admin > Energy): read all the time, not only while someone watches.
  const energy = new EnergyMeter({
    db,
    sources: {
      portal: config.hostd.portal.token === "" ? undefined : new HostdClient(config.hostd.portal),
      llm: config.hostd.llm.token === "" ? undefined : new HostdClient(config.hostd.llm),
    },
    log,
  });
  energy.start();
  // The published electricity prices Admin > Energy prices those days at (every place's, for the one the admin picks).
  const prices = new EnergyPrices({ db, log });
  prices.start();
  const live = new LiveHub({ llm: llmMonitor, hosts, energy, sessions: sessionLog, log });
  const engine = new EngineUpdater({
    config,
    host: config.hostd.llm.token === "" ? null : createEngineHost(new HostdClient(config.hostd.llm)),
    releases: new EngineReleases({ registry: createRegistryClient(), notes: createNotesClient(), notesRepo: config.engine.releaseNotesRepo, log }),
    queue: llm,
    db,
    log,
  });
  log.info("server readings", {
    portal: config.hostd.portal.url || "not set up (HOSTD_PORTAL_TOKEN)",
    llm: config.hostd.llm.url || "not set up (HOSTD_LLM_URL, HOSTD_LLM_TOKEN)",
  });

  const search = createSearxngBackend({
    baseUrl: config.search.url,
    authorization: config.search.authorization,
    timeoutMs: config.search.timeoutMs,
    fallbackEngines: config.search.fallbackEngines,
    fallbackBelow: config.search.fallbackBelow,
    cacheMs: config.search.cacheMs,
    onFallback: (use) => log.info("web search: fallback engines asked", { engines: config.search.fallbackEngines.join(","), ...use }),
  });
  const reader =
    config.reader.url === ""
      ? null
      : withPageCache(createReaderBackend({ baseUrl: config.reader.url, timeoutMs: config.reader.timeoutMs }), { ttlMs: config.reader.cacheMs });
  const control = createControlServer({ config, db, manager, versions, updater, engine, llm, live, prices, sessions, connections, log });
  const createAgentServer = createAgentServerFactory({ config, manager, sessions, connections, log });
  const servers: http.Server[] = [control];

  await listen(control, { host: "127.0.0.1", port: config.controlPort });
  // One port per user and kind: each workspace, and each of a user's two kinds, is its own browser origin. Online's
  // ports listen even while Online is off (they answer that the workspace is stopped).
  const portRanges: Record<string, string> = {};
  for (const kind of WORKSPACE_KINDS) {
    const firstPort = config.workspace.kinds[kind].agentPortBase + 1;
    const lastPort = firstPort + config.agentPortCount - 2;
    for (let port = firstPort; port <= lastPort; port++) {
      const agent = createAgentServer();
      await listen(agent, { host: config.agentBind, port });
      servers.push(agent);
    }
    portRanges[kind] = `${config.agentBind}:${firstPort}-${lastPort}`;
  }
  log.info("gateway listening", {
    control: `127.0.0.1:${config.controlPort}`,
    workspaces: portRanges,
    agents: config.workspace.agents.map((agent) => versions.selection(agent).image),
    maxRunning: config.maxRunning,
    idleTimeoutMinutes: config.idleTimeoutMs / 60_000,
  });

  // A service listener per kind, on the host's address on that kind's network, answering only that kind's
  // containers. The address exists once Docker has brought the bridge up.
  for (const kind of kinds) {
    const service = createServiceServer({ kind, config, db, manager, llm, requests, log, search, reader });
    servers.push(service);
    const bridge = config.workspace.kinds[kind].gatewayIp;
    const onRetry = (): void => log.warn(`${kind} workspace bridge address not up yet; retrying`, { address: bridge });
    listen(service, { host: bridge, port: config.servicePort, waitForAddressMs: BRIDGE_WAIT_MS, onRetry }).then(
      () =>
        log.info("service API listening", {
          kind,
          service: `${bridge}:${config.servicePort}`,
          llm: config.llm.upstreamUrl,
          search: config.search.url,
          reader: config.reader.url || "off",
        }),
      (error: unknown) => {
        log.error(`cannot listen on the ${kind} workspace bridge`, { address: bridge, error });
        process.exit(1);
      },
    );
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down; workspace containers keep running", { signal });
    for (const server of servers) {
      server.close();
      server.closeIdleConnections();
    }
    connections.closeAll(1001, "gateway restarting");
    live.close();
    energy.stop();
    llmEnergy.stop();
    prices.stop();
    hosts.portal.close();
    hosts.llm.close();
    manager.shutdown();
    // Records a running update as failed now (audited before the database closes below).
    updater.shutdown();
    engine.shutdown();
    setTimeout(() => {
      db.$client.close();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

function readConfig(log: Logger): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error("invalid configuration", { problems: error.problems });
      process.exit(1);
    }
    throw error;
  }
}

const log = createLogger();
main(log).catch((error: unknown) => {
  log.error("gateway failed to start", { error });
  process.exit(1);
});
