// The LLM engine's releases, for Admin > Updates: the stable version tags of the engine's container
// image in its registry (any Docker Registry v2, with the anonymous token flow ghcr.io and Docker Hub
// use), their image digests, and their release notes from GitHub. Cached for 10 minutes like the
// agents' release channels (release-cache.ts): the console polls, and GitHub allows 60 anonymous
// requests an hour.
import { errorMessage } from "./log.ts";

const TTL_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const TIMEOUT_MS = 10_000;
/** Versions offered, newest first (older ones are of no use for an update). */
const VERSIONS_SHOWN = 8;
/** Release notes longer than this are cut (the console links to the full page). */
const NOTES_CHARS = 12_000;
const STABLE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export interface ReleaseNotes {
  title: string;
  url: string;
  publishedAt: number | null;
  /** Markdown, cut at NOTES_CHARS. */
  body: string;
  /** The notes announce breaking changes. */
  breaking: boolean;
}

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
      const body = (await (await get(repository, "tags/list?n=1000")).json()) as { tags?: unknown };
      return Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : [];
    },
    async digest(repository, tag) {
      const response = await get(repository, `manifests/${encodeURIComponent(tag)}`, { method: "HEAD", accept: MANIFEST_TYPES });
      const digest = response.headers.get("docker-content-digest");
      return digest !== null && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
    },
  };
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
  const body = (await response.json()) as { token?: unknown; access_token?: unknown };
  const token = typeof body.token === "string" ? body.token : body.access_token;
  if (typeof token !== "string" || token === "") throw new EngineReleaseError("the registry's token service sent no token");
  return token;
}

/** GitHub releases (anonymous: 60 requests an hour, hence the cache). */
export function createNotesClient(fetchImpl: typeof fetch = fetch): NotesClient {
  return {
    async notes(repo) {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "workspace-portal", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new EngineReleaseError(`GitHub answered ${response.status} for ${repo}'s releases`);
      }
      const releases = (await response.json()) as unknown;
      const notes = new Map<string, ReleaseNotes>();
      if (!Array.isArray(releases)) return notes;
      for (const release of releases as Array<Record<string, unknown>>) {
        const tag = typeof release.tag_name === "string" ? release.tag_name : "";
        if (!STABLE_TAG.test(tag) || release.draft === true || release.prerelease === true) continue;
        const body = typeof release.body === "string" ? release.body : "";
        const published = typeof release.published_at === "string" ? Date.parse(release.published_at) : NaN;
        notes.set(tag.replace(/^v/, ""), {
          title: typeof release.name === "string" && release.name !== "" ? release.name : tag,
          url: typeof release.html_url === "string" && release.html_url.startsWith("https://github.com/") ? release.html_url : `https://github.com/${repo}/releases`,
          publishedAt: Number.isFinite(published) ? published : null,
          body: body.length > NOTES_CHARS ? `${body.slice(0, NOTES_CHARS)}\n\n…` : body,
          breaking: /BREAKING CHANGE/i.test(body),
        });
      }
      return notes;
    },
  };
}

export interface EngineReleasesOptions {
  registry: RegistryClient;
  notes: NotesClient;
  /** GitHub owner/name of the release notes; "" = none. */
  notesRepo: string;
  now?: () => number;
}

/** The engine's releases, cached; a failed check keeps the last good list and is retried after a minute. */
export class EngineReleases {
  readonly #options: EngineReleasesOptions;
  readonly #now: () => number;
  #list: EngineReleaseList | null = null;
  #attemptedAt: number | null = null;
  #checking: Promise<void> | null = null;

  constructor(options: EngineReleasesOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async list(repository: string, options: { refresh?: boolean } = {}): Promise<EngineReleaseList> {
    const cached = this.#list?.repository === repository ? this.#list : null;
    const now = this.#now();
    const fresh = cached?.checkedAt != null && now - cached.checkedAt < TTL_MS;
    const retryDue = this.#attemptedAt === null || now - this.#attemptedAt >= RETRY_MS || cached === null;
    if (options.refresh || (!fresh && retryDue)) await this.#check(repository);
    return this.#list?.repository === repository ? this.#list : { repository, releases: [], checkedAt: null, error: null };
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
      const versions = tags.filter(isStableVersion).sort((a, b) => compareVersions(b, a)).slice(0, VERSIONS_SHOWN);
      const [digests, latest, notesByVersion] = await Promise.all([
        Promise.all(versions.map((version) => registry.digest(repository, version))),
        tags.includes("latest") ? registry.digest(repository, "latest") : Promise.resolve(null),
        notesRepo === "" ? Promise.resolve(new Map<string, ReleaseNotes>()) : notes.notes(notesRepo).catch((error: unknown) => errorMessage(error)),
      ]);
      const notesMap = typeof notesByVersion === "string" ? null : notesByVersion;
      this.#list = {
        repository,
        releases: versions.map((version, index) => ({
          version,
          digest: digests[index] ?? null,
          latest: latest !== null && digests[index] === latest,
          // Notes that couldn't be fetched this time keep last time's.
          notes: notesMap ? (notesMap.get(version) ?? null) : (previous?.releases.find((r) => r.version === version)?.notes ?? null),
        })),
        checkedAt: this.#now(),
        error: typeof notesByVersion === "string" ? `release notes: ${notesByVersion}` : null,
      };
    } catch (error) {
      this.#list = { repository, releases: previous?.releases ?? [], checkedAt: previous?.checkedAt ?? null, error: errorMessage(error) };
    }
  }
}
