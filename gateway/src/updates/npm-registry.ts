// The npm registry, asked which agent versions exist: a package's document (its dist-tags, every version with its
// publish time, and its repository, for the release notes) and whether one exact version is published. Every call has
// a timeout: a hanging registry must not hold up the admin console.
//
// Publish times are only in the full document ("packument"; the abbreviated one npm install uses has none). Qwen
// Code's is about 1.9 MB of JSON, 230 kB gzipped on the wire. A request that sends the last answer's ETag is answered
// 304 without a body while nothing was published, so the release cache downloads it again only after a release.
import { failureReason, fetchBounded, FETCH_TIMEOUT_MS } from "../lib/bounded-body.ts";
import { HttpError } from "../lib/http-util.ts";
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
   * Rejects with a registryError.
   */
  packument(packageName: string, etag?: string | null): Promise<{ etag: string | null; package: NpmPackage } | null>;
  /** Whether that exact version is published. Rejects with a registryError. */
  hasVersion(packageName: string, version: string): Promise<boolean>;
}

/** The registry did not answer, or not with what was asked for. */
export const registryError = (message: string): HttpError => new HttpError(502, "registry_unreachable", message);

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
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
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxPackumentBytes = options.maxPackumentBytes ?? MAX_PACKUMENT_BYTES;

  /** The answer to a GET; its body is read (up to `maxBytes`) only when asked for. A stalled body is unreachable as well. */
  const get = (url: string, maxBytes?: number, headers: Record<string, string> = {}) =>
    fetchBounded(fetchFn, url, { headers: { accept: "application/json", ...headers }, redirect: "follow", timeoutMs, maxBytes }).catch((error: unknown) => {
      throw registryError(`The npm registry is unreachable (${failureReason(error, timeoutMs)}).`);
    });

  return {
    async packument(packageName, etag) {
      const { ok, status, headers, text } = await get(`${baseUrl}/${packagePath(packageName)}`, maxPackumentBytes, etag ? { "if-none-match": etag } : {});
      if (status === 304 && etag) return null;
      if (!ok) throw registryError(`The npm registry answered ${status} for ${packageName}.`);
      if (text === null) throw registryError(`The npm registry's answer for ${packageName} is too large.`);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw registryError(`The npm registry's answer for ${packageName} is not JSON.`);
      }
      const pkg = readPackument(body);
      if (pkg === null) throw registryError(`The npm registry's answer for ${packageName} is not a package.`);
      return { etag: headers.get("etag"), package: pkg };
    },

    async hasVersion(packageName, version) {
      const { ok, status } = await get(`${baseUrl}/${packagePath(packageName)}/${encodeURIComponent(version)}`);
      if (ok) return true;
      if (status === 404) return false;
      throw registryError(`The npm registry answered ${status} for ${packageName}@${version}.`);
    },
  };
}
