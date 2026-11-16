// LLM engine updates: GET /control/engine and its job (docs/ARCHITECTURE.md, "LLM engine updates"). EngineStatus is
// portal-hostd's GET /v1/engine (hostd/README.md).
import type { ApiError } from "./gateway-types";

export interface EngineImage {
  id: string;
  digest: string | null;
  version: string | null;
  revision: string | null;
  createdAt: number | null;
  sizeBytes: number | null;
  current: boolean;
  previous: boolean;
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
  previous: { image: string; digest: string | null; version: string | null } | null;
  images: EngineImage[];
}

export interface EngineReleaseNotes {
  title: string;
  url: string;
  publishedAt: number | null;
  body: string;
  breaking: boolean;
}

export interface EngineRelease {
  version: string;
  digest: string | null;
  latest: boolean;
  notes: EngineReleaseNotes | null;
}

export type EngineJobStage = "pulling" | "draining" | "restarting" | "succeeded" | "failed" | "cancelled";

export interface EngineUpdateJob {
  id: string;
  kind: "update" | "rollback";
  fromVersion: string | null;
  toVersion: string | null;
  image: string | null;
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

/** A job that is still going. */
export function engineJobActive(job: EngineUpdateJob | null): boolean {
  return job !== null && job.finishedAt === null;
}

/** GET (and POST, refreshing) /api/admin/engine. `engine` is null when the gateway could not provide it. */
export interface AdminEngine {
  engine: EngineOverview | null;
  error: ApiError | null;
}
