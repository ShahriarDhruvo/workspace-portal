// Workspace Portal gateway: owns the per-user agent containers (Qwen Code, DeepSeek Harness or OpenCode; a Private
// and an Online workspace per user, one running at a time), proxies browsers to them (one port per user and kind),
// and serves the LLM and web search to them (one service listener per kind, on that kind's network).
// See docs/ARCHITECTURE.md.
import type http from "node:http";
import { openDatabase, WORKSPACE_KINDS, type WorkspaceKind } from "@portal/core";
import { AgentVersions } from "./updates/agent-versions.ts";
import { AgentConfigError, driverFor } from "./agents/index.ts";
import { compose } from "./compose.ts";
import { ConfigError, loadConfig, PREVIEW_PORT_OFFSET, type Config } from "./config.ts";
import { DockerRuntime, isSupportedDockerVersion, MIN_DOCKER_VERSION_TEXT } from "./docker/docker-runtime.ts";
import { listen } from "./lib/listen.ts";
import { createLogger, type Logger } from "./lib/log.ts";

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
  const db = openDatabase(config.dbFile);
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
  // Online's network only while Online workspaces are on; with them off, an existing one is left as it is, unused.
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
        hint: "update the agent in the admin console (Updates), or: sudo bash deploy/install.sh",
      });
    }
  }

  const { manager, sessionLog, updater, hosts, energy, prices, live, engine, llmEnergy, connections, control, createAgentServer, createPreviewServer, createServiceServer } =
    compose({ config, db, runtime, versions, log });
  await manager.init();
  sessionLog.reconcile(manager.list());
  manager.startBackgroundTasks();
  // Before the control API listens, so no job can start meanwhile: a gateway that stopped mid-update
  // leaves its staging image (and maybe a version-check container) behind.
  await updater.sweep();
  energy.start();
  prices.start();
  log.info("server readings", {
    portal: config.hostd.portal.url || "not set up (HOSTD_PORTAL_TOKEN)",
    llm: config.hostd.llm.url || "not set up (HOSTD_LLM_URL, HOSTD_LLM_TOKEN)",
  });

  const servers: http.Server[] = [control];

  await listen(control, { host: "127.0.0.1", port: config.controlPort });
  // One port per user and kind: each workspace, and each of a user's two kinds, is its own browser origin, and so
  // are the web apps running in it (its preview port, PREVIEW_PORT_OFFSET above). Online's ports listen even while
  // Online is off (they answer that the workspace is stopped).
  const portRanges: Record<string, string> = {};
  const previewRanges: Record<string, string> = {};
  for (const kind of WORKSPACE_KINDS) {
    const firstPort = config.workspace.kinds[kind].agentPortBase + 1;
    const lastPort = firstPort + config.agentPortCount - 2;
    for (let port = firstPort; port <= lastPort; port++) {
      const agent = createAgentServer();
      await listen(agent, { host: config.agentBind, port });
      servers.push(agent);
      const preview = createPreviewServer();
      await listen(preview, { host: config.agentBind, port: port + PREVIEW_PORT_OFFSET });
      servers.push(preview);
    }
    portRanges[kind] = `${config.agentBind}:${firstPort}-${lastPort}`;
    previewRanges[kind] = `${config.agentBind}:${firstPort + PREVIEW_PORT_OFFSET}-${lastPort + PREVIEW_PORT_OFFSET}`;
  }
  log.info("gateway listening", {
    control: `127.0.0.1:${config.controlPort}`,
    workspaces: portRanges,
    previews: previewRanges,
    agents: config.workspace.agents.map((agent) => versions.selection(agent).image),
    maxRunning: config.maxRunning,
    idleTimeoutMinutes: config.idleTimeoutMs / 60_000,
  });

  // A service listener per kind, on the host's address on that kind's network, answering only that kind's
  // containers. The address exists once Docker has brought the bridge up.
  for (const kind of kinds) {
    const service = createServiceServer({ kind });
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
