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
import { fenceCheck, type FenceState } from "@portal/container";
import { createRegistryClient, EngineReleases, type RegistryClient } from "./updates/engine-releases.ts";
import { createEngineHost, EngineUpdater, type EngineHost } from "./updates/engine-updater.ts";
import { AppReleases } from "./updates/app-releases.ts";
import { AppUpdater, createAppHost, type AppHost } from "./updates/app-updater.ts";
import { createGitHubReleases, type GitHubReleases } from "./updates/github-releases.ts";
import { HostMonitor } from "./monitor/host-monitor.ts";
import { hostdClient } from "./monitor/hostd.ts";
import { LiveHub, userNames } from "./monitor/live.ts";
import { LlmMonitor } from "./monitor/llm-monitor.ts";
import { LlmQueue } from "./service/llm-queue.ts";
import { KeyUsage } from "./monitor/key-usage.ts";
import { LlmEnergy } from "./monitor/llm-energy.ts";
import { LlmRequests, type FinishedLlmRequest } from "./monitor/llm-requests.ts";
import type { Logger } from "./lib/log.ts";
import { createNpmRegistry, type NpmRegistry } from "./updates/npm-registry.ts";
import { createReaderBackend, withPageCache, type ReaderBackend } from "./service/reader.ts";
import { createExaBackend } from "./service/exa-search.ts";
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
  /** null: the AI server has no portal-hostd. */
  engineHost?: EngineHost | null;
  engineRegistry?: RegistryClient;
  engineNotes?: GitHubReleases;
  /** How often the engine's and the other software's updates ask portal-hostd about its job. */
  enginePollMs?: number;
  /** null: the AI server has no portal-hostd. */
  appHost?: AppHost | null;
  search?: SearchBackend;
  reader?: ReaderBackend | null;
  /** Downloads the electricity prices. */
  fetchText?: FetchText;
  /** Told each request that reached the AI server, once it has ended. */
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
  // The same for each API key (the API page).
  const keyUsage = new KeyUsage({ db, log, now });
  const hostd = { portal: hostdClient(config.hostd.portal), llm: hostdClient(config.hostd.llm) };
  const llmEnergy = new LlmEnergy({
    source: hostd.llm,
    onShares: (shares) => {
      sessionLog.addEnergy(shares.filter((share) => "sessionId" in share));
      keyUsage.addEnergy(shares.filter((share) => "keyId" in share));
    },
    log,
  });
  const requests = new LlmRequests({
    now,
    listener: {
      forwarded: ({ id, userId, keyId, forwardedAt }) => {
        const sessionId = keyId === null ? sessionLog.forwarded(id, userId) : null;
        const owner = keyId !== null ? { keyId } : sessionId !== null ? { sessionId } : null;
        if (owner) llmEnergy.started(id, owner, forwardedAt);
      },
      finished: (request) => {
        seams.onLlmFinished?.(request);
        llmEnergy.ended(request.id, request.finishedAt);
        if (request.keyId === null) sessionLog.finished(request);
        else keyUsage.finished(request.keyId, request);
      },
    },
  });
  const connections = new ConnectionRegistry(now);
  const sessions = new SessionCache((tokenHash) => loadSessionContext(db, tokenHash));
  // Online workspaces run only while the host firewall that fences them in answers (firewall.sh and fence.ts in container/security).
  const fence = seams.fence ?? fenceCheck(config.servicePort);
  const manager = new WorkspaceManager({ config, db, runtime, versions, llm, connections, log, fence, sessions: sessionLog, now });
  const registry = seams.registry ?? createNpmRegistry();
  const updater = new AgentUpdater({
    config,
    versions,
    builder: seams.builder ?? new DockerImageBuilder({ contextDir: config.imageContextDir }),
    registry,
    github: createGitHubReleases(),
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
    slotsPath: config.llm.slotsPath,
    apiKey: config.llm.apiKey,
    queue: llm,
    requests,
    names: (ids) => userNames(db, ids),
    images: config.llm.imageModels.length > 0,
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
      github: seams.engineNotes ?? createGitHubReleases(),
      notesRepo: config.engine.releaseNotesRepo,
      log,
      now,
    }),
    queue: llm,
    db,
    log,
    now,
    pollMs: seams.enginePollMs,
    busy: () => apps.running,
  });
  // The other software on the AI server (llm-server/apps.json): llama-swap and the media models' servers.
  const apps: AppUpdater = new AppUpdater({
    config,
    host: seams.appHost !== undefined ? seams.appHost : hostd.llm && createAppHost(hostd.llm),
    releases: new AppReleases({ registry: seams.engineRegistry ?? createRegistryClient(), github: seams.engineNotes ?? createGitHubReleases(), log, now }),
    queue: llm,
    db,
    log,
    now,
    pollMs: seams.enginePollMs,
    busy: () => engine.running,
  });

  const search = seams.search ?? searchBackend(config.search, log);
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
    apps,
    control: createControlServer({ config, db, manager, versions, updater, engine, apps, llm, requests, live, prices, sessions, connections, log }),
    createAgentServer: createAgentServerFactory({ config, manager, sessions, connections, log }),
    createPreviewServer: createPreviewServerFactory({ config, manager, sessions, connections, log }),
    /** A service listener for one kind's network. */
    createServiceServer: (own: Pick<ServiceDeps, "kind" | "resolveCaller">) => createServiceServer({ ...own, config, db, manager, llm, requests, log, search, reader }),
  };
}

/** Exa answers within a second or two; past this, SearXNG is asked instead. */
const EXA_TIMEOUT_MS = 10_000;

/** web_search's source: SearXNG, and in front of it Exa when EXA_SEARCH is on. */
export function searchBackend(search: Config["search"], log: Logger): SearchBackend {
  const searxng = createSearxngBackend({
    baseUrl: search.url,
    authorization: search.authorization,
    timeoutMs: search.timeoutMs,
    fallbackEngines: search.fallbackEngines,
    fallbackBelow: search.fallbackBelow,
    cacheMs: search.cacheMs,
    onFallback: (use) => log.info("web search: fallback engines asked", { engines: search.fallbackEngines.join(","), ...use }),
  });
  if (!search.exa) return searxng;
  return createExaBackend({
    fallback: searxng,
    timeoutMs: EXA_TIMEOUT_MS,
    cacheMs: search.cacheMs,
    onFailure: ({ reason, pauseMs }) => log.warn("web search: Exa did not answer, SearXNG is asked instead", { reason, pauseMinutes: Math.round(pauseMs / 60_000) }),
  });
}
