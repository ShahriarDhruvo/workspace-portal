// Workspace Portal gateway: owns the per-user Qwen Code containers, proxies browsers to them (one
// port per user), and serves the only things workspaces can reach: the LLM and web search.
// See docs/ARCHITECTURE.md.
import type http from "node:http";
import { getDatabase, loadSessionContext } from "@portal/db";
import { createAgentServerFactory } from "./agent-proxy.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { ConnectionRegistry } from "./connections.ts";
import { createControlServer } from "./control-api.ts";
import { DockerRuntime, isSupportedDockerVersion, MIN_DOCKER_VERSION_TEXT } from "./docker-runtime.ts";
import { listen } from "./listen.ts";
import { LlmQueue } from "./llm-queue.ts";
import { createLogger, type Logger } from "./log.ts";
import { QwenConfigError } from "./qwen.ts";
import { createSearxngBackend } from "./search-mcp.ts";
import { createServiceServer } from "./service-api.ts";
import { SessionCache } from "./session-cache.ts";
import { renderWorkspaceSettings } from "./workspace-files.ts";
import { WorkspaceManager } from "./workspaces.ts";

/** How long the service listeners wait for the workspace bridge address to appear. */
const BRIDGE_WAIT_MS = 60_000;
/** On SIGTERM, time for close frames and the last responses to go out before exiting. */
const SHUTDOWN_GRACE_MS = 1_000;

async function main(log: Logger): Promise<void> {
  const config = readConfig(log);

  try {
    renderWorkspaceSettings(config);
  } catch (error) {
    // Not fatal: the portal keeps working, and workspace starts report the same problem.
    if (error instanceof QwenConfigError) log.error("Qwen Code settings are invalid; workspaces cannot start until they are fixed", { error: error.message });
    else throw error;
  }
  const db = getDatabase(config.dbFile);

  const runtime = new DockerRuntime(config);
  const engine = await runtime.engineVersion();
  if (!isSupportedDockerVersion(engine)) {
    log.error(
      `Docker Engine ${engine || "(unknown version)"} is not supported: ${MIN_DOCKER_VERSION_TEXT} or later is required, because older engines let containers on internal networks resolve outside names (CVE-2024-29018)`,
      { version: engine, minimum: MIN_DOCKER_VERSION_TEXT },
    );
    process.exit(1);
  }
  const network = await runtime.ensureNetwork();
  if (network !== "exists") {
    log.info(`${network} the workspace network`, { network: config.workspace.network, subnet: config.workspace.subnet, internal: true });
  }
  if (!(await runtime.imageAvailable())) {
    log.error("workspace image not found; workspaces cannot start until it is built", {
      image: config.workspace.image,
      hint: `docker build -t ${config.workspace.image} workspace-image`,
    });
  }

  const llm = new LlmQueue(config.llm.maxConcurrency, config.llm.maxConcurrencyPerUser);
  const connections = new ConnectionRegistry();
  const sessions = new SessionCache((tokenHash) => loadSessionContext(db, tokenHash));
  const manager = new WorkspaceManager({ config, db, runtime, llm, connections, log });
  await manager.init();
  manager.startBackgroundTasks();

  const search = createSearxngBackend({
    baseUrl: config.search.url,
    authorization: config.search.authorization,
    timeoutMs: config.search.timeoutMs,
  });
  const control = createControlServer({ config, db, manager, llm, sessions, connections, log });
  const createAgentServer = createAgentServerFactory({ config, manager, sessions, connections, log });
  const service = createServiceServer({ config, db, manager, llm, log, search });
  const servers: http.Server[] = [control, service];

  await listen(control, { host: "127.0.0.1", port: config.controlPort });
  // One port per user: each workspace is its own browser origin.
  const firstPort = config.agentPortBase + 1;
  const lastPort = config.agentPortBase + config.agentPortCount - 1;
  for (let port = firstPort; port <= lastPort; port++) {
    const agent = createAgentServer();
    await listen(agent, { host: config.agentBind, port });
    servers.push(agent);
  }
  log.info("gateway listening", {
    control: `127.0.0.1:${config.controlPort}`,
    workspaces: `${config.agentBind}:${firstPort}-${lastPort}`,
    image: config.workspace.image,
    maxRunning: config.maxRunning,
    idleTimeoutMinutes: config.idleTimeoutMs / 60_000,
  });

  const bridge = config.workspace.gatewayIp;
  const onRetry = (): void => log.warn("workspace bridge address not up yet; retrying", { address: bridge });
  listen(service, { host: bridge, port: config.servicePort, waitForAddressMs: BRIDGE_WAIT_MS, onRetry }).then(
    () => log.info("service API listening", { service: `${bridge}:${config.servicePort}`, llm: config.llm.upstreamUrl, search: config.search.url }),
    (error: unknown) => {
      log.error("cannot listen on the workspace bridge", { address: bridge, error });
      process.exit(1);
    },
  );

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
    manager.shutdown();
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
