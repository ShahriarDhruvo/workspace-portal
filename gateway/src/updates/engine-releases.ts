// The LLM engine's releases, for Admin > Updates: the stable version tags of the engine's container image in its
// registry (any Docker Registry v2, with the anonymous token flow ghcr.io and Docker Hub use), their image digests,
// and their release notes from GitHub, cached like the agents' releases (release-cache.ts).
import { byNewestVersion, compareVersions, fetchBounded, isStableVersion, type EngineRelease, type EngineReleaseList, type ReleaseNotes } from "@portal/core";
import { RELEASES_OFFERED } from "./agent-overview.ts";
import type { GitHubRelease, GitHubReleases } from "./github-releases.ts";
import type { Logger } from "../lib/log.ts";
import { ReleaseCache } from "./release-cache.ts";

/** The tag list (n=1000) and a token answer are small; anything larger than this is refused while it streams in. */
const MAX_BYTES = 4 * 1024 * 1024;
/** The newest tags whose digests are read: those offered, and enough to find what `latest` points at. */
const VERSIONS_CHECKED = 8;
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export class EngineReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineReleaseError";
  }
}

/** Splits "ghcr.io/owner/name" into the registry host and the repository path. Docker Hub names get its host. */
export function splitRepository(repository: string): { registry: string; path: string } {
  const [first, ...rest] = repository.split("/");
  if (rest.length > 0 && (first!.includes(".") || first!.includes(":") || first === "localhost")) {
    return { registry: first === "docker.io" ? "registry-1.docker.io" : first!, path: rest.join("/") };
  }
  return { registry: "registry-1.docker.io", path: rest.length === 0 ? `library/${first}` : repository };
}

/** Newest first, a leading v ignored; a label that is no X.Y.Z release (an image's own, whatever it says) goes last. */
function byNewestRelease(a: string, b: string): number {
  const [x, y] = [a.replace(/^v/, ""), b.replace(/^v/, "")];
  const [stableX, stableY] = [isStableVersion(x), isStableVersion(y)];
  return stableX && stableY ? compareVersions(y, x)! : Number(stableY) - Number(stableX);
}

export interface RegistryClient {
  /** The repository's tags. */
  tags(repository: string): Promise<string[]>;
  /** The digest a tag points at. */
  digest(repository: string, tag: string): Promise<string | null>;
}

/** Docker Registry v2 over HTTPS with anonymous bearer tokens. */
export function createRegistryClient(fetchImpl: typeof fetch = fetch): RegistryClient {
  const tokens = new Map<string, string>();

  async function get(repository: string, pathAndQuery: string, init: { method?: string; accept?: string } = {}) {
    const { registry, path } = splitRepository(repository);
    const ask = () => {
      const token = tokens.get(repository);
      const headers = { ...(init.accept ? { accept: init.accept } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
      return fetchBounded(fetchImpl, `https://${registry}/v2/${path}/${pathAndQuery}`, { method: init.method ?? "GET", headers, maxBytes: MAX_BYTES });
    };
    let answer = await ask();
    if (answer.status === 401) {
      tokens.set(repository, await anonymousToken(fetchImpl, answer.headers.get("www-authenticate") ?? ""));
      answer = await ask();
    }
    if (!answer.ok) throw new EngineReleaseError(`${registry} answered ${answer.status} for ${path}`);
    return answer;
  }

  return {
    async tags(repository) {
      const body = boundedJson((await get(repository, "tags/list?n=1000")).text, "tag list") as { tags?: unknown };
      return Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : [];
    },
    async digest(repository, tag) {
      const { headers } = await get(repository, `manifests/${encodeURIComponent(tag)}`, { method: "HEAD", accept: MANIFEST_TYPES });
      const digest = headers.get("docker-content-digest");
      return digest !== null && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
    },
  };
}

/** A registry answer's JSON, refused when larger than MAX_BYTES (`text` is then null) or not JSON. */
function boundedJson(text: string | null, what: string): unknown {
  if (text === null) throw new EngineReleaseError(`the registry's ${what} is larger than ${MAX_BYTES / 1024 / 1024} MiB`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EngineReleaseError(`the registry's ${what} is not JSON`);
  }
}

/** Follows a `WWW-Authenticate: Bearer realm=...,service=...,scope=...` challenge anonymously. */
async function anonymousToken(fetchImpl: typeof fetch, challenge: string): Promise<string> {
  const params = new Map<string, string>();
  for (const match of challenge.matchAll(/(\w+)="([^"]*)"/g)) params.set(match[1]!, match[2]!);
  const realm = params.get("realm");
  if (!/^bearer /i.test(challenge) || !realm?.startsWith("https://")) throw new EngineReleaseError("the registry asks for credentials the portal doesn't have");
  const url = new URL(realm);
  for (const key of ["service", "scope"]) {
    const value = params.get(key);
    if (value) url.searchParams.set(key, value);
  }
  const { ok, status, text } = await fetchBounded(fetchImpl, url, { maxBytes: MAX_BYTES });
  if (!ok) throw new EngineReleaseError(`the registry's token service answered ${status}`);
  const body = boundedJson(text, "token answer") as { token?: unknown; access_token?: unknown };
  const token = typeof body.token === "string" ? body.token : body.access_token;
  if (typeof token !== "string" || token === "") throw new EngineReleaseError("the registry's token service sent no token");
  return token;
}

/** The engine's stable releases (X.Y.Z tags, no prereleases) among a repository's, by version. */
export function stableNotes(releases: readonly GitHubRelease[]): Map<string, ReleaseNotes> {
  const notes = new Map<string, ReleaseNotes>();
  for (const release of releases) {
    const version = release.tag.replace(/^v/, "");
    if (isStableVersion(version) && !release.prerelease) notes.set(version, release.notes);
  }
  return notes;
}

type Listed = Omit<EngineRelease, "notes">;

/**
 * The versions the engine card lists, newest first: `releases` (the newest in the registry), plus every version in
 * `local` (what runs, the images on the LLM server) that isn't among them, with its local digest; each with the notes
 * GitHub has for it.
 */
export function withLocalVersions(
  releases: readonly Listed[],
  local: ReadonlyArray<{ version: string | null; digest: string | null }>,
  notes: ReadonlyMap<string, ReleaseNotes>,
): EngineRelease[] {
  const listed = new Map(releases.map((release) => [release.version, release]));
  for (const { version, digest } of local) {
    if (version !== null && !listed.has(version)) listed.set(version, { version, digest, latest: false });
  }
  return [...listed.values()].sort((a, b) => byNewestRelease(a.version, b.version)).map((release) => ({ ...release, notes: notes.get(release.version) ?? null }));
}

export interface EngineReleasesOptions {
  registry: RegistryClient;
  github: GitHubReleases;
  /** GitHub owner/name of the release notes; "" = none. */
  notesRepo: string;
  now?: () => number;
  log?: Logger;
}

/**
 * Offered: the RELEASES_OFFERED newest stable tags no newer than the one `latest` points at (a version pushed but not
 * yet made latest is not offered).
 */
export class EngineReleases {
  readonly #registry: RegistryClient;
  /** By image repository. */
  readonly #cache: ReleaseCache<{ githubRepo: string | null; releases: Listed[] }>;

  constructor({ registry, notesRepo, ...rest }: EngineReleasesOptions) {
    this.#registry = registry;
    this.#cache = new ReleaseCache({
      ...rest,
      notes: stableNotes,
      source: async (repository) => {
        const tags = await registry.tags(repository);
        const versions = tags.filter(isStableVersion).sort(byNewestVersion).slice(0, VERSIONS_CHECKED);
        const [digests, latest] = await Promise.all([
          Promise.all(versions.map((version) => registry.digest(repository, version))),
          tags.includes("latest") ? registry.digest(repository, "latest") : null,
        ]);
        const latestAt = latest === null ? -1 : digests.indexOf(latest);
        const releases = versions
          .map((version, index) => ({ version, digest: digests[index] ?? null, latest: index === latestAt }))
          .slice(Math.max(0, latestAt))
          .slice(0, RELEASES_OFFERED);
        return { etag: null, package: { githubRepo: notesRepo || null, releases } };
      },
    });
  }

  /** The releases, with the versions in `local` (withLocalVersions). */
  async list(
    repository: string,
    options: { refresh?: boolean } = {},
    local: ReadonlyArray<{ version: string | null; digest: string | null }> = [],
  ): Promise<EngineReleaseList> {
    const { packages, checkedAt, error } = await this.#cache.snapshot([repository], options);
    const known = packages.get(repository);
    return { repository, releases: withLocalVersions(known?.releases ?? [], local, known?.notes ?? new Map()), checkedAt, error };
  }

  /** A version's digest straight from the registry (an update must not act on a stale list). */
  async resolve(repository: string, version: string): Promise<string> {
    if (!isStableVersion(version)) throw new EngineReleaseError(`${version} is not a release version (like 0.34.0)`);
    const digest = await this.#registry.digest(repository, version);
    if (digest === null) throw new EngineReleaseError(`the registry has no digest for ${repository}:${version}`);
    return digest;
  }
}
