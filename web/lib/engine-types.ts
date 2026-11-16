// LLM engine updates: GET /control/engine and its job (docs/ARCHITECTURE.md, "LLM engine updates"). EngineStatus is
// portal-hostd's GET /v1/engine (hostd/README.md).
import type { ApiError, ReleaseNotes } from "./gateway-types";

export interface EngineImage {
  id: string;
  digest: string | null;
  version: string | null;
  revision: string | null;
  createdAt: number | null;
  sizeBytes: number | null;
  current: boolean;
}

export interface EngineStatus {
  unit: string;
  repository: string;
  image: string;
  digest: string | null;
  version: string | null;
  revision: string | null;
  state: string;
  subState: string;
  ready: boolean;
  buildInfo: string | null;
  images: EngineImage[];
}

/**
 * One version in the engine's Package images table: the 5 newest releases up to the one `latest` points at, and the
 * versions that run or have an image on the LLM server (with that image's digest).
 */
export interface EngineRelease {
  version: string;
  digest: string | null;
  latest: boolean;
  notes: ReleaseNotes | null;
}

export type EngineJobStage = "pulling" | "draining" | "restarting" | "succeeded" | "failed" | "cancelled";

export interface EngineUpdateJob {
  id: string;
  fromVersion: string | null;
  toVersion: string | null;
  image: string | null;
  /** The LLM server had an image of that version: no download, it is used as it is. */
  reuse: boolean;
  stage: EngineJobStage;
  step: string;
  log: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  rolledBack: boolean;
  drain: { since: number; deadline: number; inFlight: number } | null;
  cancellable: boolean;
  actorUserId: number | null;
}

export type EngineHostState = "off" | "offline" | "no_engine" | "ok";

export interface EngineOverview {
  state: EngineHostState;
  error: string | null;
  engine: EngineStatus | null;
  releases: { repository: string; releases: EngineRelease[]; checkedAt: number | null; error: string | null } | null;
  job: EngineUpdateJob | null;
  drainMinutes: number;
}

/** GET (and POST, refreshing) /api/admin/engine. `engine` is null when the gateway could not provide it. */
export interface AdminEngine {
  engine: EngineOverview | null;
  error: ApiError | null;
}
