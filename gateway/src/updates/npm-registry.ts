// The npm registry, asked which agent versions exist: a package's document (its dist-tags, every version with
// its publish time, and its repository, for the release notes) and whether one exact version is published. The
// gateway runs on the host network, so it reaches the registry the same way the image builds do. fetch is injected so
// tests need no network; every call has a timeout, because a hanging registry must not hold up the admin console.
//
// Publish times are only in the full document ("packument"; the abbreviated one npm install uses has none). Qwen
// Code's, with a nightly build a day, is about 1.9 MB of JSON, 230 kB gzipped on the wire (fetch asks for gzip). The
// registry answers a request that sends the last answer's ETag with 304 and no body while nothing was published, so
// the release cache (release-cache.ts) downloads it again only after a release.
import { readBoundedText } from "../lib/bounded-body.ts";
import { isGitHubRepo } from "./github-releases.ts";
import { isVersion } from "@portal/core";

/** One published version (an unpublished one is gone from the document). */
export interface PublishedVersion {
  version: string;
  /** Epoch ms; null when the document has no time for it. */
  publishedAt: number | null;
  /** npm marks it deprecated: its publisher advises against installing it. */
  deprecated: boolean;
}

/** What the gateway keeps of a package's document. */
export interface NpmPackage {
  /** dist-tag → version: latest, next, nightly… */
  distTags: Record<string, string>;
  versions: PublishedVersion[];
  /** owner/name of the GitHub repository the package's `repository` field names; null for none, or another host. */
  githubRepo: string | null;
}

export interface NpmRegistry {
  /**
   * The package's document; null when it hasn't changed since the answer that came with `etag` (the registry's 304).
   * Rejects with RegistryError.
   */
  packument(packageName: string, etag?: string | null): Promise<{ etag: string | null; package: NpmPackage } | null>;
  /** Whether that exact version is published. Rejects with RegistryError. */
  hasVersion(packageName: string, version: string): Promise<boolean>;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const TIMEOUT_MS = 10_000;
/** Qwen Code's document is about 1.9 MB and grows by some 2.6 kB a version. */
const MAX_PACKUMENT_BYTES = 32 * 1024 * 1024;

export interface NpmRegistryOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxPackumentBytes?: number;
}

/** `@scope/name` → `@scope%2Fname`, as the registry spells scoped packages in paths. */
export function packagePath(packageName: string): string {
  return packageName.startsWith("@") ? `@${encodeURIComponent(packageName.slice(1))}` : encodeURIComponent(packageName);
}

/**
 * The GitHub repository a package.json `repository` field names, in any of the forms npm accepts: "owner/name",
 * "github:owner/name", or a URL (https, git+https, git, ssh) on github.com, alone or as `{ url }`.
 */
export function githubRepository(repository: unknown): string | null {
  const value = typeof repository === "string" ? repository : (repository as { url?: unknown } | null)?.url;
  if (typeof value !== "string") return null;
  const shorthand = /^(?:github:)?([^/:@\s]+\/[^/:@\s#]+)$/.exec(value);
  const url = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?\/?(?:[#?].*)?$/.exec(value);
  const scp = /^git@github\.com:([^/]+\/[^/#?]+?)(?:\.git)?$/.exec(value);
  const repo = (shorthand ?? url ?? scp)?.[1]?.replace(/\.git$/, "") ?? null;
  return repo !== null && isGitHubRepo(repo) ? repo : null;
}

/** The parts of a package document the gateway uses; anything malformed is left out. */
export function readPackument(body: unknown): NpmPackage | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const doc = body as { "dist-tags"?: unknown; versions?: unknown; time?: unknown; repository?: unknown };
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const distTags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(record(doc["dist-tags"]))) if (typeof version === "string") distTags[tag] = version;
  const times = record(doc.time);
  const versions: PublishedVersion[] = [];
  for (const [version, manifest] of Object.entries(record(doc.versions))) {
    if (!isVersion(version)) continue;
    const time = times[version];
    const publishedAt = typeof time === "string" ? Date.parse(time) : NaN;
    const deprecated = record(manifest).deprecated;
    versions.push({
      version,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      deprecated: typeof deprecated === "string" && deprecated !== "",
    });
  }
  return { distTags, versions, githubRepo: githubRepository(doc.repository) };
}

export function createNpmRegistry(options: NpmRegistryOptions = {}): NpmRegistry {
  const fetchFn = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? NPM_REGISTRY_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxPackumentBytes = options.maxPackumentBytes ?? MAX_PACKUMENT_BYTES;

  const unreachable = (error: unknown): RegistryError => {
    const reason = (error as Error).name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : (error as Error).message;
    return new RegistryError(`The npm registry is unreachable (${reason}).`);
  };
  // One signal for the request and its body: a registry that sends headers and then stalls is unreachable as well.
  const get = async (url: string, headers: Record<string, string> = {}): Promise<Response> => {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      return await fetchFn(url, { headers: { accept: "application/json", ...headers }, signal, redirect: "follow" });
    } catch (error) {
      throw unreachable(error);
    }
  };

  return {
    async packument(packageName, etag) {
      const response = await get(`${baseUrl}/${packagePath(packageName)}`, etag ? { "if-none-match": etag } : {});
      if (response.status === 304 && etag) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new RegistryError(`The npm registry answered ${response.status} for ${packageName}.`);
      }
      let text: string | null;
      try {
        text = await readBoundedText(response, maxPackumentBytes);
      } catch (error) {
        throw unreachable(error);
      }
      if (text === null) throw new RegistryError(`The npm registry's answer for ${packageName} is too large.`);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new RegistryError(`The npm registry's answer for ${packageName} is not JSON.`);
      }
      const pkg = readPackument(body);
      if (pkg === null) throw new RegistryError(`The npm registry's answer for ${packageName} is not a package.`);
      return { etag: response.headers.get("etag"), package: pkg };
    },

    async hasVersion(packageName, version) {
      const response = await get(`${baseUrl}/${packagePath(packageName)}/${encodeURIComponent(version)}`);
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return true;
      if (response.status === 404) return false;
      throw new RegistryError(`The npm registry answered ${response.status} for ${packageName}@${version}.`);
    },
  };
}
