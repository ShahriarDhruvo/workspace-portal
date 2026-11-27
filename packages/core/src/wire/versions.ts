// Agent versions as the portal handles them: npm versions of Qwen Code, DeepSeek Harness and OpenCode, which also
// name the workspace images (workspace-portal/workspace:<agent>-<version>). One pattern for every place a version
// comes in (the .env defaults, the selection file, the control API, the web app's forms, the npm registry's
// dist-tags), the same expression as deploy/lib.sh valid_version: it admits nothing that could break out of an image
// tag, a build argument or a KEY=VALUE line, and so none of OpenCode's snapshot builds ("0.0.0-beta-19507"), which
// are neither offered nor installed. Unanchored, it finds the version in an agent CLI's `--version` output
// (deploy/lib.sh check_workspace_image greps for it too).

const VERSION_SYNTAX = String.raw`\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?`;
const VERSION_PATTERN = new RegExp(`^${VERSION_SYNTAX}$`);
const VERSION_IN_TEXT = new RegExp(VERSION_SYNTAX);
/** An image tag is at most 128 characters; `<agent>-` takes a few of them. */
const MAX_VERSION_LENGTH = 100;

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_VERSION_LENGTH && VERSION_PATTERN.test(value);
}

/** A release, X.Y.Z: no prerelease, no build suffix, no leading v (Gufo's image tags; an agent's stable releases). */
export function isStableVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
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

function sign<T extends bigint | number | string>(a: T, b: T): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

/** semver §11: numeric identifiers compare as numbers and sort before alphanumeric ones. */
function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return sign(BigInt(a), BigInt(b));
  if (numericA !== numericB) return numericA ? -1 : 1;
  return sign(a, b);
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
  return sign(left.prerelease.length, right.prerelease.length);
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
  return sign(a, b);
}
