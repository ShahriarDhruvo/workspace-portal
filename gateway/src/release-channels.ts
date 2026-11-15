// Release channels: the npm dist-tags the admin may update an agent to by name. Packages carry other
// tags too (Qwen Code has dozens of experiment tags such as `jobbench` or `gdpval-*`), which are no
// release anyone should install by accident, so only these are offered, in this order.
import { isVersion } from "./versions.ts";

export const RELEASE_CHANNELS = ["latest", "next", "preview", "beta", "rc", "alpha", "nightly"] as const;

export interface ReleaseChannel {
  tag: string;
  version: string;
}

/** The offered channels a package has, "latest" first; tags with an unusable version are left out. */
export function releaseChannels(distTags: Readonly<Record<string, string>>): ReleaseChannel[] {
  const channels: ReleaseChannel[] = [];
  for (const tag of RELEASE_CHANNELS) {
    const version = Object.hasOwn(distTags, tag) ? distTags[tag] : undefined;
    if (isVersion(version)) channels.push({ tag, version });
  }
  return channels;
}

/** Shaped like a dist-tag (as opposed to a mistyped version): worth asking the registry about. */
export function isChannelName(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value);
}
