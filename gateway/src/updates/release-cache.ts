// What the npm registry and GitHub last said about the agents' releases, so the admin console (which polls) does
// not ask on every page load. Fresh for 10 minutes; `refresh` asks again at once.
//
// Each check asks the registry for every package's document with the ETag of the last answer: while nothing was
// published it answers 304 without a body, so only a release downloads the document again (npm-registry.ts). The
// release notes come from the GitHub repository the package names (github-releases.ts), asked again only when the
// package changed, at most once an hour otherwise (GitHub allows 60 anonymous requests an hour), and at once on
// `refresh`. A GitHub failure keeps the notes it had; they are a nicety, not what an update depends on.
//
// A registry outage must not break the overview: a failed check keeps the last good answers, reports the error, and
// is retried after a minute instead of on every poll (each attempt can take the registry client's full timeout).
// Concurrent callers share one check.
import { tagVersion, type GitHubReleases, type ReleaseNotes } from "./github-releases.ts";
import { errorMessage, type Logger } from "../lib/log.ts";
import type { NpmPackage, NpmRegistry, PublishedVersion } from "./npm-registry.ts";

export const RELEASES_TTL_MS = 10 * 60_000;
export const RELEASES_RETRY_MS = 60_000;
export const NOTES_TTL_MS = 60 * 60_000;

/** What is known of one package's releases. */
export interface PackageReleases {
  distTags: Readonly<Record<string, string>>;
  versions: readonly PublishedVersion[];
  /** Release notes by version, from the package's GitHub repository; empty when it names none or GitHub never answered. */
  notes: ReadonlyMap<string, ReleaseNotes>;
}

export interface ReleaseSnapshot {
  /** By package; a package missing here has never been checked successfully. */
  packages: ReadonlyMap<string, PackageReleases>;
  /** Epoch ms of the last check that succeeded for every package; null before the first. */
  checkedAt: number | null;
  /** Why the last registry check failed; null when it succeeded. */
  error: string | null;
}

export interface ReleaseCacheOptions {
  registry: NpmRegistry;
  /** Where release notes come from; none: no notes. */
  github?: GitHubReleases | null;
  log?: Logger;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
}

interface PackageState {
  etag: string | null;
  package: NpmPackage;
  notes: ReadonlyMap<string, ReleaseNotes>;
  /** When GitHub last answered for it; null: never. */
  notesAt: number | null;
}

export class ReleaseCache {
  readonly #registry: NpmRegistry;
  readonly #github: GitHubReleases | null;
  readonly #log: Logger | null;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #retryMs: number;
  readonly #packages = new Map<string, PackageState>();
  #checkedAt: number | null = null;
  #attemptedAt: number | null = null;
  #error: string | null = null;
  #checking: Promise<void> | null = null;

  constructor(options: ReleaseCacheOptions) {
    this.#registry = options.registry;
    this.#github = options.github ?? null;
    this.#log = options.log ?? null;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? RELEASES_TTL_MS;
    this.#retryMs = options.retryMs ?? RELEASES_RETRY_MS;
  }

  /** The releases of these packages, checked again when stale or when `refresh` is set. */
  async snapshot(packages: readonly string[], options: { refresh?: boolean } = {}): Promise<ReleaseSnapshot> {
    if (options.refresh || this.#stale(packages)) await this.#check(packages, options.refresh === true);
    const known = new Map<string, PackageReleases>();
    for (const [name, state] of this.#packages) {
      known.set(name, { distTags: state.package.distTags, versions: state.package.versions, notes: state.notes });
    }
    return { packages: known, checkedAt: this.#checkedAt, error: this.#error };
  }

  #stale(packages: readonly string[]): boolean {
    if (this.#attemptedAt === null) return true;
    const age = this.#now() - this.#attemptedAt;
    if (this.#error !== null) return age >= this.#retryMs;
    return age >= this.#ttlMs || packages.some((name) => !this.#packages.has(name));
  }

  #check(packages: readonly string[], refresh: boolean): Promise<void> {
    this.#checking ??= this.#checkOnce(packages, refresh).finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async #checkOnce(packages: readonly string[], refresh: boolean): Promise<void> {
    const results = await Promise.allSettled(packages.map((name) => this.#checkPackage(name, refresh)));
    this.#attemptedAt = this.#now();
    const failed = results.find((result) => result.status === "rejected");
    this.#error = failed ? errorMessage(failed.reason) : null;
    if (this.#error === null) this.#checkedAt = this.#attemptedAt;
  }

  async #checkPackage(name: string, refresh: boolean): Promise<void> {
    const known = this.#packages.get(name);
    const answer = await this.#registry.packument(name, known?.etag ?? null);
    const pkg = answer?.package ?? known?.package;
    if (!pkg) return;
    const changed = answer !== null;
    let { notes, notesAt } = known ?? { notes: new Map<string, ReleaseNotes>(), notesAt: null };
    const notesDue = notesAt === null || this.#now() - notesAt >= NOTES_TTL_MS;
    if (this.#github && pkg.githubRepo && (changed || refresh || notesDue)) {
      try {
        notes = notesByVersion(await this.#github.list(pkg.githubRepo), name);
        notesAt = this.#now();
      } catch (error) {
        this.#log?.warn("could not read an agent's release notes; keeping the last ones", { package: name, error });
      }
    }
    this.#packages.set(name, { etag: answer ? answer.etag : (known?.etag ?? null), package: pkg, notes, notesAt });
  }
}

/** The package's releases among a repository's (tagVersion), by version; the first (newest) wins a duplicate. */
export function notesByVersion(releases: ReadonlyArray<{ tag: string; notes: ReleaseNotes }>, packageName: string): Map<string, ReleaseNotes> {
  const notes = new Map<string, ReleaseNotes>();
  for (const release of releases) {
    const version = tagVersion(release.tag, packageName);
    if (version !== null && !notes.has(version)) notes.set(version, release.notes);
  }
  return notes;
}
