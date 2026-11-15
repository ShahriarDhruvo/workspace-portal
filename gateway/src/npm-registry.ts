// The npm registry, asked which agent versions exist: a package's dist-tags (latest, next, …) and
// whether one exact version is published. The gateway runs on the host network, so it reaches the
// registry the same way the image builds do. fetch is injected so tests need no network; every call
// has a timeout, because a hanging registry must not hold up the admin console.
export interface NpmRegistry {
  /** The package's dist-tags (tag → version). Rejects with RegistryError. */
  distTags(packageName: string): Promise<Record<string, string>>;
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
/** dist-tags documents are a few hundred bytes; Qwen Code's has dozens of tags. */
const MAX_DIST_TAGS_BYTES = 256 * 1024;

export interface NpmRegistryOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/** `@scope/name` → `@scope%2Fname`, as the registry spells scoped packages in paths. */
export function packagePath(packageName: string): string {
  return packageName.startsWith("@") ? `@${encodeURIComponent(packageName.slice(1))}` : encodeURIComponent(packageName);
}

export function createNpmRegistry(options: NpmRegistryOptions = {}): NpmRegistry {
  const fetchFn = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? NPM_REGISTRY_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  const unreachable = (error: unknown): RegistryError => {
    const reason = (error as Error).name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : (error as Error).message;
    return new RegistryError(`The npm registry is unreachable (${reason}).`);
  };
  const get = async (url: string): Promise<Response> => {
    try {
      return await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    } catch (error) {
      throw unreachable(error);
    }
  };

  return {
    async distTags(packageName) {
      const response = await get(`${baseUrl}/-/package/${packagePath(packageName)}/dist-tags`);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new RegistryError(`The npm registry answered ${response.status} for ${packageName}'s release channels.`);
      }
      // The timeout covers the body too: a registry that sends headers and then stalls is unreachable as well.
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw unreachable(error);
      }
      if (text.length > MAX_DIST_TAGS_BYTES) throw new RegistryError(`The npm registry's answer for ${packageName} is too large.`);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new RegistryError(`The npm registry's answer for ${packageName} is not JSON.`);
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RegistryError(`The npm registry's answer for ${packageName} is not a list of release channels.`);
      const tags: Record<string, string> = {};
      for (const [tag, version] of Object.entries(body)) if (typeof version === "string") tags[tag] = version;
      return tags;
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
