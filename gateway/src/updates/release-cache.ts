// What a registry and GitHub last said about releases (the agents' npm packages, Gufo's image), so the admin
// console, which polls, does not ask on every page load. Fresh for 10 minutes; `refresh` asks again at once. A failed
// check keeps the last good answers, reports the error, and is retried after a minute instead of on every poll (each
// attempt can take the client's full timeout). Release notes are asked for again only when the registry's answer
// changed, at most once an hour otherwise (GitHub allows 60 anonymous requests an hour), and at once on `refresh`; a
// GitHub failure keeps the last ones, since no update depends on them.
import type { ReleaseNotes } from "@portal/core";
import { tagVersion, type GitHubRelease, type GitHubReleases } from "./github-releases.ts";
import { errorMessage, type Logger } from "../lib/log.ts";
import { singleFlight } from "../lib/single-flight.ts";

export const RELEASES_TTL_MS = 10 * 60_000;
export const RELEASES_RETRY_MS = 60_000;
export const NOTES_TTL_MS = 60 * 60_000;

/** By version. */
type Notes = ReadonlyMap<string, ReleaseNotes>;

export interface ReleaseSnapshot<P> {
  /** By name; one missing here has never been checked successfully. `notes` is empty without a repository, or while GitHub never answered. */
  packages: ReadonlyMap<string, P & { notes: Notes }>;
  /** Epoch ms of the last check that succeeded for every name; null before the first. */
  checkedAt: number | null;
  /** Why the last registry check failed; null when it succeeded. */
  error: string | null;
}

export interface ReleaseCacheOptions<P> {
  /** What the registry has for `name`; null when nothing changed since the answer that came with `etag`. */
  source: (name: string, etag: string | null) => Promise<{ etag: string | null; package: P } | null>;
  /** Which of a repository's releases are `name`'s. */
  notes: (releases: GitHubRelease[], name: string) => Notes;
  /** Where release notes come from; none: no notes. */
  github?: GitHubReleases;
  log?: Logger;
  now?: () => number;
}

interface State<P> {
  etag: string | null;
  package: P;
  notes: Notes;
  /** When GitHub last answered for it; null: never. */
  notesAt: number | null;
}

/** `githubRepo`: owner/name of the repository whose releases carry the notes; null for none. */
export class ReleaseCache<P extends { githubRepo: string | null }> {
  readonly #options: ReleaseCacheOptions<P>;
  readonly #now: () => number;
  readonly #packages = new Map<string, State<P>>();
  #checkedAt: number | null = null;
  #attemptedAt: number | null = null;
  #error: string | null = null;

  constructor(options: ReleaseCacheOptions<P>) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** The releases of these names, checked again when stale or when `refresh` is set. */
  async snapshot(names: readonly string[], options: { refresh?: boolean } = {}): Promise<ReleaseSnapshot<P>> {
    if (options.refresh || this.#stale(names)) await this.#check(names, options.refresh === true);
    const packages = new Map<string, P & { notes: Notes }>();
    for (const [name, state] of this.#packages) packages.set(name, { ...state.package, notes: state.notes });
    return { packages, checkedAt: this.#checkedAt, error: this.#error };
  }

  #stale(names: readonly string[]): boolean {
    if (this.#attemptedAt === null) return true;
    const age = this.#now() - this.#attemptedAt;
    if (this.#error !== null) return age >= RELEASES_RETRY_MS;
    return age >= RELEASES_TTL_MS || names.some((name) => !this.#packages.has(name));
  }

  readonly #check = singleFlight((names: readonly string[], refresh: boolean) => this.#checkOnce(names, refresh));

  async #checkOnce(names: readonly string[], refresh: boolean): Promise<void> {
    const results = await Promise.allSettled(names.map((name) => this.#checkPackage(name, refresh)));
    this.#attemptedAt = this.#now();
    const failed = results.find((result) => result.status === "rejected");
    this.#error = failed ? errorMessage(failed.reason) : null;
    if (this.#error === null) this.#checkedAt = this.#attemptedAt;
  }

  async #checkPackage(name: string, refresh: boolean): Promise<void> {
    const { source, notes, github, log } = this.#options;
    const known = this.#packages.get(name);
    const answer = await source(name, known?.etag ?? null);
    const state: State<P> | undefined = answer ? { notes: new Map(), notesAt: null, ...known, ...answer } : known;
    if (!state) return;
    const notesDue = state.notesAt === null || this.#now() - state.notesAt >= NOTES_TTL_MS;
    if (github && state.package.githubRepo && (answer !== null || refresh || notesDue)) {
      try {
        state.notes = notes(await github.list(state.package.githubRepo), name);
        state.notesAt = this.#now();
      } catch (error) {
        log?.warn("could not read release notes; keeping the last ones", { package: name, error });
      }
    }
    this.#packages.set(name, state);
  }
}

/** An npm package's releases among a repository's (tagVersion), by version; the first (newest) wins a duplicate. */
export function notesByVersion(releases: ReadonlyArray<{ tag: string; notes: ReleaseNotes }>, packageName: string): Map<string, ReleaseNotes> {
  const notes = new Map<string, ReleaseNotes>();
  for (const release of releases) {
    const version = tagVersion(release.tag, packageName);
    if (version !== null && !notes.has(version)) notes.set(version, release.notes);
  }
  return notes;
}
