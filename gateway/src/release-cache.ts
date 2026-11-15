// What the npm registry last said about the agents' release channels, so the admin console (which
// polls) does not ask it on every page load. Fresh for 10 minutes; `refresh` asks again at once.
//
// A registry outage must not break the overview: a failed check keeps the last good answers, reports
// the error, and is retried after a minute instead of on every poll (each attempt can take the
// registry client's full timeout). Concurrent callers share one check.
import { errorMessage } from "./log.ts";
import type { NpmRegistry } from "./npm-registry.ts";

export const RELEASES_TTL_MS = 10 * 60_000;
export const RELEASES_RETRY_MS = 60_000;

export interface ReleaseSnapshot {
  /** dist-tags by package; a package missing here has never been checked successfully. */
  tags: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** Epoch ms of the last check that succeeded for every package; null before the first. */
  checkedAt: number | null;
  /** Why the last check failed; null when it succeeded. */
  error: string | null;
}

export interface ReleaseCacheOptions {
  registry: NpmRegistry;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
}

export class ReleaseCache {
  readonly #registry: NpmRegistry;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #retryMs: number;
  readonly #tags = new Map<string, Readonly<Record<string, string>>>();
  #checkedAt: number | null = null;
  #attemptedAt: number | null = null;
  #error: string | null = null;
  #checking: Promise<void> | null = null;

  constructor(options: ReleaseCacheOptions) {
    this.#registry = options.registry;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? RELEASES_TTL_MS;
    this.#retryMs = options.retryMs ?? RELEASES_RETRY_MS;
  }

  /** The release channels of these packages, checked again when stale or when `refresh` is set. */
  async snapshot(packages: readonly string[], options: { refresh?: boolean } = {}): Promise<ReleaseSnapshot> {
    if (options.refresh || this.#stale(packages)) await this.#check(packages);
    return { tags: new Map(this.#tags), checkedAt: this.#checkedAt, error: this.#error };
  }

  /**
   * One package's dist-tags straight from the registry (to resolve a channel when an update is asked
   * for); the answer also refreshes the cache. Rejects with RegistryError.
   */
  async fresh(packageName: string): Promise<Readonly<Record<string, string>>> {
    const tags = await this.#registry.distTags(packageName);
    this.#tags.set(packageName, tags);
    return tags;
  }

  #stale(packages: readonly string[]): boolean {
    if (this.#attemptedAt === null) return true;
    const age = this.#now() - this.#attemptedAt;
    if (this.#error !== null) return age >= this.#retryMs;
    return age >= this.#ttlMs || packages.some((name) => !this.#tags.has(name));
  }

  #check(packages: readonly string[]): Promise<void> {
    this.#checking ??= this.#checkOnce(packages).finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async #checkOnce(packages: readonly string[]): Promise<void> {
    const results = await Promise.allSettled(packages.map(async (name) => ({ name, tags: await this.#registry.distTags(name) })));
    this.#attemptedAt = this.#now();
    let error: string | null = null;
    for (const result of results) {
      if (result.status === "fulfilled") this.#tags.set(result.value.name, result.value.tags);
      else error ??= errorMessage(result.reason);
    }
    this.#error = error;
    if (error === null) this.#checkedAt = this.#attemptedAt;
  }
}
