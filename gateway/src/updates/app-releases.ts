// The releases of the other software on the AI server (llm-server/apps.json, as portal-hostd reports it), for Admin >
// Updates: a dir app's from its GitHub releases, an image app's from its registry's tags, each tag's version being the
// first group of the app's `releases.tag` pattern. Cached like the agents' and Gufo's (release-cache.ts).
import { compareAppVersions, type AppRelease, type AppReleaseList, type AppStatus, type ReleaseNotes } from "@portal/core";
import { RELEASES_OFFERED } from "./agent-overview.ts";
import { EngineReleaseError, stableNotes, type RegistryClient } from "./engine-releases.ts";
import type { GitHubRelease, GitHubReleases } from "./github-releases.ts";
import type { Logger } from "../lib/log.ts";
import { ReleaseCache } from "./release-cache.ts";

/** portal-hostd's own pattern for a version: it names a directory. */
export const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/** Newest first (compareAppVersions): also orders the image tags of one version, newest build first. */
export function byNewestAppVersion(a: string, b: string): number {
  return compareAppVersions(b, a);
}

/** The version a tag names, by the app's pattern; null when it names none hostd could install. */
export function appTagVersion(pattern: RegExp, tag: string): string | null {
  const version = pattern.exec(tag)?.[1];
  return version !== undefined && APP_VERSION.test(version) ? version : null;
}

type Listed = Omit<AppRelease, "notes"> & { notes?: ReleaseNotes | null };

/** A dir app's releases: its GitHub releases whose tags match, prereleases only when the app asks for them. */
export function githubAppReleases(releases: readonly GitHubRelease[], pattern: RegExp, prerelease: boolean): Listed[] {
  const byVersion = new Map<string, Listed>();
  for (const release of releases) {
    const version = appTagVersion(pattern, release.tag);
    if (version === null || (release.prerelease && !prerelease) || byVersion.has(version)) continue;
    byVersion.set(version, { version, tag: null, latest: false, notes: release.notes });
  }
  const listed = [...byVersion.values()].sort((a, b) => byNewestAppVersion(a.version, b.version)).slice(0, RELEASES_OFFERED);
  return listed.map((release, index) => ({ ...release, latest: index === 0 }));
}

/** An image app's releases: per version, the newest of its tags (a rebuild of the same version gets a new tag). */
export function registryAppReleases(tags: readonly string[], pattern: RegExp): Listed[] {
  const byVersion = new Map<string, string>();
  for (const tag of tags) {
    const version = appTagVersion(pattern, tag);
    if (version === null) continue;
    const seen = byVersion.get(version);
    if (seen === undefined || byNewestAppVersion(tag, seen) < 0) byVersion.set(version, tag);
  }
  const versions = [...byVersion.keys()].sort(byNewestAppVersion).slice(0, RELEASES_OFFERED);
  return versions.map((version, index) => ({ version, tag: byVersion.get(version)!, latest: index === 0 }));
}

/** The releases the card lists: `releases`, plus each installed version not among them. */
export function withInstalled(releases: readonly Listed[], app: AppStatus, notes: ReadonlyMap<string, ReleaseNotes>): AppRelease[] {
  const listed = new Map(releases.map((release) => [release.version, release]));
  for (const { version } of app.versions) if (!listed.has(version)) listed.set(version, { version, tag: null, latest: false });
  return [...listed.values()]
    .sort((a, b) => byNewestAppVersion(a.version, b.version))
    .map((release) => ({ version: release.version, tag: release.tag, latest: release.latest, notes: release.notes ?? notes.get(release.version) ?? null }));
}

export interface AppReleasesOptions {
  registry: RegistryClient;
  github: GitHubReleases;
  now?: () => number;
  log?: Logger;
}

interface Source {
  app: AppStatus;
  pattern: RegExp;
}

export class AppReleases {
  readonly #registry: RegistryClient;
  readonly #github: GitHubReleases;
  /** What each app's releases come from, as hostd last said: the cache asks by app id. */
  readonly #sources = new Map<string, Source>();
  readonly #cache: ReleaseCache<{ githubRepo: string | null; releases: Listed[] }>;

  constructor({ registry, github, ...rest }: AppReleasesOptions) {
    this.#registry = registry;
    this.#github = github;
    this.#cache = new ReleaseCache({
      ...rest,
      github,
      notes: stableNotes,
      source: async (id) => {
        const source = this.#sources.get(id);
        if (source === undefined) throw new EngineReleaseError(`no app ${id}`);
        const { app, pattern } = source;
        if (app.kind === "dir") {
          if (!app.releases.github) throw new EngineReleaseError(`${app.name} names no GitHub repository`);
          // A dir app's notes come with its releases: no second request to GitHub.
          return { etag: null, package: { githubRepo: null, releases: githubAppReleases(await github.list(app.releases.github), pattern, app.releases.prerelease === true) } };
        }
        if (!app.repository) throw new EngineReleaseError(`${app.name} has no image repository`);
        const releases = registryAppReleases(await this.#registry.tags(app.repository), pattern);
        return { etag: null, package: { githubRepo: app.releases.github ?? null, releases } };
      },
    });
  }

  /** The source of `app`'s releases, as the card shows it. */
  static source(app: AppStatus): string {
    return app.kind === "dir" ? (app.releases.github ?? "") : (app.repository ?? "");
  }

  /** Each app's releases, with its installed versions. */
  async list(apps: readonly AppStatus[], options: { refresh?: boolean } = {}): Promise<Map<string, AppReleaseList>> {
    for (const app of apps) this.#sources.set(app.id, { app, pattern: new RegExp(app.releases.tag) });
    const { packages, checkedAt, error } = await this.#cache.snapshot(apps.map((app) => app.id), options);
    const lists = new Map<string, AppReleaseList>();
    for (const app of apps) {
      const known = packages.get(app.id);
      lists.set(app.id, { source: AppReleases.source(app), releases: withInstalled(known?.releases ?? [], app, known?.notes ?? new Map()), checkedAt, error });
    }
    return lists;
  }

  /**
   * What hostd needs to install `version` of an image app: its tag and digest, straight from the registry (an update
   * must not act on a stale list). null for a dir app, whose install script takes the version itself.
   */
  async resolve(app: AppStatus, version: string): Promise<{ image: string; tag: string } | null> {
    if (app.kind === "dir") return null;
    if (!app.repository) throw new EngineReleaseError(`${app.name} has no image repository`);
    const tag = registryAppReleases(await this.#registry.tags(app.repository), new RegExp(app.releases.tag)).find((release) => release.version === version)?.tag;
    if (!tag) throw new EngineReleaseError(`${app.repository} has no tag of ${version}`);
    const digest = await this.#registry.digest(app.repository, tag);
    if (digest === null) throw new EngineReleaseError(`the registry has no digest for ${app.repository}:${tag}`);
    return { image: `${app.repository}@${digest}`, tag };
  }
}
