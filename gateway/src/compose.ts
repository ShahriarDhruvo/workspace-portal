// The gateway's parts and what each is given: built here once, for main.ts and for the integration tests
// (test/harness.ts). Nothing here starts, listens or asks Docker anything; main.ts does that, in its order.
import { loadSessionContext, type PortalDb } from "@portal/core";
import { createAgentServerFactory } from "./proxy/agent-proxy.ts";
import { createPreviewServerFactory } from "./proxy/preview-proxy.ts";
import { AgentUpdater } from "./updates/agent-updater.ts";
import type { AgentVersions } from "./updates/agent-versions.ts";
import type { Config } from "./config.ts";
import { ConnectionRegistry } from "./proxy/connections.ts";
import { createControlServer } from "./control-api.ts";
import { DockerImageBuilder } from "./docker/docker-image-builder.ts";
import type { ImageBuilder } from "./docker/image-builder.ts";
import type { ContainerRuntime } from "./docker/runtime.ts";
import { EnergyMeter } from "./monitor/energy-meter.ts";
import { EnergyPrices, type FetchText } from "./monitor/energy-prices.ts";
import { fenceCheck, type FenceState } from "./workspaces/fence.ts";
import { createNotesClient, createRegistryClient, EngineReleases, type NotesClient, type RegistryClient } from "./updates/engine-releases.ts";
import { createEngineHost, EngineUpdater, type EngineHost } from "./updates/engine-updater.ts";
import { createGitHubReleases } from "./updates/github-releases.ts";
import { HostMonitor } from "./monitor/host-monitor.ts";
import { hostdClient } from "./monitor/hostd.ts";
import { LiveHub, userNames } from "./monitor/live.ts";
import { LlmMonitor } from "./monitor/llm-monitor.ts";
import { LlmQueue } from "./service/llm-queue.ts";
import { LlmEnergy } from "./monitor/llm-energy.ts";
import { LlmRequests, type FinishedLlmRequest } from "./monitor/llm-requests.ts";
import type { Logger } from "./lib/log.ts";
import { createNpmRegistry, type NpmRegistry } from "./updates/npm-registry.ts";
import { createReaderBackend, withPageCache, type ReaderBackend } from "./service/reader.ts";
import { ReleaseCache } from "./updates/release-cache.ts";
import { createSearxngBackend, type SearchBackend } from "./service/search-mcp.ts";
import { createServiceServer, type ServiceDeps } from "./service/service-api.ts";
import { SessionCache } from "./proxy/session-cache.ts";
import { SessionLog } from "./monitor/session-log.ts";
import { WorkspaceManager } from "./workspaces/manager.ts";

/** What the integration tests replace (test/harness.ts). main.ts passes none: each is then the real one. */
export interface Seams {
  /** The clock of the parts the tests move time for. */
  now?: () => number;
  fence?: () => Promise<FenceState>;
  builder?: ImageBuilder;
  registry?: NpmRegistry;
  /** null: the LLM server has no portal-hostd. */
  engineHost?: EngineHost | null;
  engineRegistry?: RegistryClient;
  engineNotes?: NotesClient;
  enginePollMs?: number;
  search?: SearchBackend;
  reader?: ReaderBackend | null;
  /** Downloads the electricity prices. */
  fetchText?: FetchText;
  /** Told each request that reached the LLM server, once it has ended. */
  onLlmFinished?: (request: FinishedLlmRequest) => void;
}

export function compose(
  { config, db, runtime, versions, log }: { config: Config; db: PortalDb; runtime: ContainerRuntime; versions: AgentVersions; log: Logger },
  seams: Seams = {},
) {
  const { now } = seams;
  const llm = new LlmQueue(config.llm.maxConcurrency, config.llm.maxConcurrencyPerUser);
  // Each run of a workspace and what its LLM requests added up to, energy included (Admin > Usage).
  const sessionLog = new SessionLog({ db, log, now });
  const hostd = { portal: hostdClient(config.hostd.portal), llm: hostdClient(config.hostd.llm) };
  const llmEnergy = new LlmEnergy({
    source: hostd.llm,
    onShares: (shares) => sessionLog.addEnergy(shares),
    log,
  });
  const requests = new LlmRequests({
    now,
    listener: {
      forwarded: (request) => {
        const sessionId = sessionLog.forwarded(request.id, request.userId);
        if (sessionId !== null) llmEnergy.started(request.id, sessionId, request.forwardedAt);
      },
      finished: (request) => {
        seams.onLlmFinished?.(request);
        llmEnergy.ended(request.id, request.finishedAt);
        sessionLog.finished(request);
      },
    },
  });
  const connections = new ConnectionRegistry(now);
  const sessions = new SessionCache((tokenHash) => loadSessionContext(db, tokenHash));
  // Online workspaces run only while the host firewall that fences them in answers (deploy/firewall.sh, fence.ts).
  const fence = seams.fence ?? fenceCheck(config.servicePort);
  const manager = new WorkspaceManager({ config, db, runtime, versions, llm, connections, log, fence, sessions: sessionLog, now });
  const registry = seams.registry ?? createNpmRegistry();
  const updater = new AgentUpdater({
    config,
    versions,
    builder: seams.builder ?? new DockerImageBuilder({ contextDir: config.imageContextDir }),
    registry,
    releases: new ReleaseCache({ registry, github: createGitHubReleases(), log, now }),
    workspaces: () => manager.list(),
    db,
    log,
    now,
  });

  // The admin's live view and engine updates, through each server's portal-hostd.
  const hosts = {
    portal: new HostMonitor({ role: "portal", client: hostd.portal, log }),
    llm: new HostMonitor({ role: "llm", client: hostd.llm, log }),
  };
  const llmMonitor = new LlmMonitor({
    upstreamUrl: config.llm.upstreamUrl,
    apiKey: config.llm.apiKey,
    queue: llm,
    requests,
    names: (ids) => userNames(db, ids),
    log,
    now,
  });
  // Each server's energy and traffic per day (Admin > Energy): read all the time, not only while someone watches.
  const energy = new EnergyMeter({ db, sources: hostd, log });
  // The published electricity prices Admin > Energy prices those days at (every place's, for the one the admin picks).
  const prices = new EnergyPrices({ db, log, fetchText: seams.fetchText });
  const live = new LiveHub({ llm: llmMonitor, hosts, energy, sessions: sessionLog, log, now });
  const engine = new EngineUpdater({
    config,
    host: seams.engineHost !== undefined ? seams.engineHost : hostd.llm && createEngineHost(hostd.llm),
    releases: new EngineReleases({
      registry: seams.engineRegistry ?? createRegistryClient(),
      notes: seams.engineNotes ?? createNotesClient(),
      notesRepo: config.engine.releaseNotesRepo,
      log,
      now,
    }),
    queue: llm,
    db,
    log,
    now,
    pollMs: seams.enginePollMs,
  });

  const search =
    seams.search ??
    createSearxngBackend({
      baseUrl: config.search.url,
      authorization: config.search.authorization,
      timeoutMs: config.search.timeoutMs,
      fallbackEngines: config.search.fallbackEngines,
      fallbackBelow: config.search.fallbackBelow,
      cacheMs: config.search.cacheMs,
      onFallback: (use) => log.info("web search: fallback engines asked", { engines: config.search.fallbackEngines.join(","), ...use }),
    });
  const reader =
    seams.reader !== undefined
      ? seams.reader
      : config.reader.url === ""
        ? null
        : withPageCache(createReaderBackend({ baseUrl: config.reader.url, timeoutMs: config.reader.timeoutMs }), { ttlMs: config.reader.cacheMs });
  return {
    llm,
    sessionLog,
    llmEnergy,
    requests,
    connections,
    sessions,
    manager,
    updater,
    hosts,
    energy,
    prices,
    live,
    engine,
    control: createControlServer({ config, db, manager, versions, updater, engine, llm, live, prices, sessions, connections, log }),
    createAgentServer: createAgentServerFactory({ config, manager, sessions, connections, log }),
    createPreviewServer: createPreviewServerFactory({ config, manager, sessions, connections, log }),
    /** A service listener for one kind's network. */
    createServiceServer: (own: Pick<ServiceDeps, "kind" | "resolveCaller">) => createServiceServer({ ...own, config, db, manager, llm, requests, log, search, reader }),
  };
}
