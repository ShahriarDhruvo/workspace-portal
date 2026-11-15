// Agent versions as the portal handles them: npm versions of Qwen Code and DeepSeek Harness, which also
// name the workspace images (workspace-portal/workspace:<agent>-<version>).
//
// One pattern for every place a version comes in: the .env defaults (config.ts), the selection file
// (agent-versions.ts), the control API and the npm registry's dist-tags. deploy/lib.sh (valid_version)
// uses the same expression. It admits nothing that could break out of an image tag, a build argument
// or a KEY=VALUE line. Unanchored, the same expression finds the version in an agent CLI's
// `--version` output (findVersion; deploy/lib.sh image_agent_version greps for it too).
//
// compareVersions orders them by semver precedence, prereleases included, so that "an update is
// available" means newer and not just different: when the current version is 0.2.2-rc.3 (from the
// "next" channel) and "latest" says 0.2.2-rc.1, there is nothing to update to.

const VERSION_SYNTAX = String.raw`\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?`;
const VERSION_PATTERN = new RegExp(`^${VERSION_SYNTAX}$`);
const VERSION_IN_TEXT = new RegExp(VERSION_SYNTAX);
/** An image tag is at most 128 characters; `<agent>-` takes a few of them. */
const MAX_VERSION_LENGTH = 100;

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_VERSION_LENGTH && VERSION_PATTERN.test(value);
}

/** The first version-looking word of `text` (an agent CLI's `--version` output), or null. */
export function findVersion(text: string): string | null {
  return VERSION_IN_TEXT.exec(text)?.[0] ?? null;
}

interface SemVer {
  core: [bigint, bigint, bigint];
  /** Dot-separated prerelease identifiers; empty for a release. */
  prerelease: string[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(version: string): SemVer | null {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function sign(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

/** semver §11: numeric identifiers compare as numbers and sort before alphanumeric ones. */
function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return sign(BigInt(a), BigInt(b));
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a === b ? 0 : a > b ? 1 : -1;
}

/**
 * Semver precedence of two versions: negative when a < b, 0 when equal (build metadata ignored),
 * positive when a > b. A release sorts after its prereleases. null when either is not semver
 * (VERSION_PATTERN also admits forms like 1.2.3.4, which have no defined order).
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const order = sign(left.core[i]!, right.core[i]!);
    if (order !== 0) return order;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const order = compareIdentifiers(left.prerelease[i]!, right.prerelease[i]!);
    if (order !== 0) return order;
  }
  return sign(BigInt(left.prerelease.length), BigInt(right.prerelease.length));
}

/** `candidate` is a newer version than `current`; false when either can't be ordered. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return (compareVersions(candidate, current) ?? 0) > 0;
}

/** Newest first; versions that can't be ordered go last, in text order. */
export function byNewestVersion(a: string, b: string): number {
  const order = compareVersions(b, a);
  if (order !== null) return order;
  const aOrdered = parseSemver(a) !== null;
  const bOrdered = parseSemver(b) !== null;
  if (aOrdered !== bOrdered) return aOrdered ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
