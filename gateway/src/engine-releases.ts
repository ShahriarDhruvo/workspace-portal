// The LLM engine's releases, for Admin > Updates: the stable version tags of the engine's container
// image in its registry (any Docker Registry v2, with the anonymous token flow ghcr.io and Docker Hub
// use), their image digests, and their release notes from GitHub (github-releases.ts). Cached for 10
// minutes like the agents' releases (release-cache.ts): the console polls, and GitHub allows 60
// anonymous requests an hour.
import { readBoundedText } from "./bounded-body.ts";
import { createGitHubReleases, type GitHubReleases, type ReleaseNotes } from "./github-releases.ts";
import { errorMessage, type Logger } from "./log.ts";

export type { ReleaseNotes } from "./github-releases.ts";

const TTL_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const TIMEOUT_MS = 10_000;
/** The tag list (n=1000) and a token answer are small; anything larger than this is refused while it streams in. */
const MAX_BYTES = 4 * 1024 * 1024;
/** Versions offered to install, newest first, as for the agents (agent-overview.ts RELEASES_OFFERED). */
export const RELEASES_OFFERED = 5;
/** The newest tags whose digests are read: those offered, and enough to find what `latest` points at. */
const VERSIONS_CHECKED = 8;
const STABLE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export interface EngineRelease {
  version: string;
  /** The image's digest (sha256:...); null when the registry didn't say. */
  digest: string | null;
  /** The registry's `latest` tag points at this version. */
  latest: boolean;
  notes: ReleaseNotes | null;
}

export interface EngineReleaseList {
  repository: string;
  /** withLocalVersions: the newest releases, and the versions the LLM server has an image of, newest first. */
  releases: EngineRelease[];
  checkedAt: number | null;
  error: string | null;
}

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

/** Compares X.Y.Z versions (a leading v is ignored); non-versions sort first. */
export function compareVersions(a: string, b: string): number {
  const pa = STABLE_TAG.exec(a);
  const pb = STABLE_TAG.exec(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isStableVersion(value: string): boolean {
  return STABLE_TAG.test(value) && !value.startsWith("v");
}

export interface RegistryClient {
  /** The repository's tags. */
  tags(repository: string): Promise<string[]>;
  /** The digest a tag points at. */
  digest(repository: string, tag: string): Promise<string | null>;
}

export interface NotesClient {
  /** Release notes by version (without a leading v). */
  notes(repo: string): Promise<Map<string, ReleaseNotes>>;
}

/** Docker Registry v2 over HTTPS with anonymous bearer tokens. */
export function createRegistryClient(fetchImpl: typeof fetch = fetch): RegistryClient {
  const tokens = new Map<string, string>();

  async function get(repository: string, pathAndQuery: string, init: { method?: string; accept?: string } = {}): Promise<Response> {
    const { registry, path } = splitRepository(repository);
    const url = `https://${registry}/v2/${path}/${pathAndQuery}`;
    const headers = (): Record<string, string> => {
      const token = tokens.get(repository);
      return { ...(init.accept ? { accept: init.accept } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
    };
    let response = await fetchImpl(url, { method: init.method ?? "GET", headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 401) {
      await response.body?.cancel();
      tokens.set(repository, await anonymousToken(fetchImpl, response.headers.get("www-authenticate") ?? ""));
      response = await fetchImpl(url, { method: init.method ?? "GET", headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new EngineReleaseError(`${registry} answered ${response.status} for ${path}`);
    }
    return response;
  }

  return {
    async tags(repository) {
      const body = (await boundedJson(await get(repository, "tags/list?n=1000"), "tag list")) as { tags?: unknown };
      return Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : [];
    },
    async digest(repository, tag) {
      const response = await get(repository, `manifests/${encodeURIComponent(tag)}`, { method: "HEAD", accept: MANIFEST_TYPES });
      const digest = response.headers.get("docker-content-digest");
      return digest !== null && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
    },
  };
}

/** A registry answer's JSON, refused when larger than MAX_BYTES or not JSON. */
async function boundedJson(response: Response, what: string): Promise<unknown> {
  const text = await readBoundedText(response, MAX_BYTES);
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
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new EngineReleaseError(`the registry's token service answered ${response.status}`);
  }
  const body = (await boundedJson(response, "token answer")) as { token?: unknown; access_token?: unknown };
  const token = typeof body.token === "string" ? body.token : body.access_token;
  if (typeof token !== "string" || token === "") throw new EngineReleaseError("the registry's token service sent no token");
  return token;
}

/** The engine's stable releases (X.Y.Z tags, no prereleases) on GitHub, by version. */
export function createNotesClient(github: GitHubReleases = createGitHubReleases()): NotesClient {
  return {
    async notes(repo) {
      const notes = new Map<string, ReleaseNotes>();
      for (const release of await github.list(repo)) {
        if (STABLE_TAG.test(release.tag) && !release.prerelease) notes.set(release.tag.replace(/^v/, ""), release.notes);
      }
      return notes;
    },
  };
}

/**
 * The versions the engine card lists, newest first: `releases` (the newest in the registry), plus every version in
 * `local` (what runs, the images on the LLM server) that isn't among them, with its local digest and the notes GitHub
 * has for it.
 */
export function withLocalVersions(
  releases: readonly EngineRelease[],
  local: ReadonlyArray<{ version: string | null; digest: string | null }>,
  notes: ReadonlyMap<string, ReleaseNotes>,
): EngineRelease[] {
  const listed = new Map(releases.map((release) => [release.version, release]));
  for (const { version, digest } of local) {
    if (version === null || listed.has(version)) continue;
    listed.set(version, { version, digest, latest: false, notes: notes.get(version) ?? null });
  }
  return [...listed.values()].sort((a, b) => compareVersions(b.version, a.version));
}

export interface EngineReleasesOptions {
  registry: RegistryClient;
  notes: NotesClient;
  /** GitHub owner/name of the release notes; "" = none. */
  notesRepo: string;
  now?: () => number;
  log?: Logger;
}

/**
 * The engine's releases, cached; a failed check keeps the last good list and is retried after a minute. Offered: the
 * RELEASES_OFFERED newest stable tags no newer than the one `latest` points at (a version pushed but not yet made
 * latest is not offered).
 */
export class EngineReleases {
  readonly #options: EngineReleasesOptions;
  readonly #now: () => number;
  #list: EngineReleaseList | null = null;
  /** Every stable release's notes from the last answer GitHub gave, for the versions on the LLM server too. */
  #notes: ReadonlyMap<string, ReleaseNotes> = new Map();
  #attemptedAt: number | null = null;
  #checking: Promise<void> | null = null;

  constructor(options: EngineReleasesOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** The releases, with the versions in `local` (withLocalVersions). */
  async list(
    repository: string,
    options: { refresh?: boolean } = {},
    local: ReadonlyArray<{ version: string | null; digest: string | null }> = [],
  ): Promise<EngineReleaseList> {
    const cached = this.#list?.repository === repository ? this.#list : null;
    const now = this.#now();
    const fresh = cached?.checkedAt != null && now - cached.checkedAt < TTL_MS;
    const retryDue = this.#attemptedAt === null || now - this.#attemptedAt >= RETRY_MS || cached === null;
    if (options.refresh || (!fresh && retryDue)) await this.#check(repository);
    const list = this.#list?.repository === repository ? this.#list : { repository, releases: [], checkedAt: null, error: null };
    return { ...list, releases: withLocalVersions(list.releases, local, this.#notes) };
  }

  /** A version's digest straight from the registry (an update must not act on a stale list). */
  async resolve(repository: string, version: string): Promise<string> {
    if (!isStableVersion(version)) throw new EngineReleaseError(`${version} is not a release version (like 0.34.0)`);
    const digest = await this.#options.registry.digest(repository, version);
    if (digest === null) throw new EngineReleaseError(`the registry has no digest for ${repository}:${version}`);
    return digest;
  }

  #check(repository: string): Promise<void> {
    this.#checking ??= this.#fetch(repository).finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async #fetch(repository: string): Promise<void> {
    const { registry, notes, notesRepo } = this.#options;
    this.#attemptedAt = this.#now();
    const previous = this.#list?.repository === repository ? this.#list : null;
    try {
      const tags = await registry.tags(repository);
      const versions = tags.filter(isStableVersion).sort((a, b) => compareVersions(b, a)).slice(0, VERSIONS_CHECKED);
      const [digests, latest, notesByVersion] = await Promise.all([
        Promise.all(versions.map((version) => registry.digest(repository, version))),
        tags.includes("latest") ? registry.digest(repository, "latest") : Promise.resolve(null),
        notesRepo === "" ? Promise.resolve(new Map<string, ReleaseNotes>()) : notes.notes(notesRepo).catch((error: unknown) => errorMessage(error)),
      ]);
      // Notes that couldn't be fetched this time (GitHub down, or its anonymous limit of 60 an hour reached): last
      // time's. That is no registry failure, so it isn't the list's error: the versions are fresh and updates work.
      if (typeof notesByVersion !== "string") this.#notes = notesByVersion;
      else this.#options.log?.warn("could not read the LLM engine's release notes; keeping the last ones", { error: notesByVersion });
      const latestAt = latest === null ? -1 : digests.indexOf(latest);
      this.#list = {
        repository,
        releases: versions
          .map((version, index) => ({ version, digest: digests[index] ?? null, latest: index === latestAt, notes: this.#notes.get(version) ?? null }))
          .slice(Math.max(0, latestAt))
          .slice(0, RELEASES_OFFERED),
        checkedAt: this.#now(),
        error: null,
      };
    } catch (error) {
      this.#list = { repository, releases: previous?.releases ?? [], checkedAt: previous?.checkedAt ?? null, error: errorMessage(error) };
    }
  }
}
