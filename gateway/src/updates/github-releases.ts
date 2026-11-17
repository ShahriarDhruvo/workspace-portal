// Release notes from GitHub, for Admin > Updates: the LLM engine's (engine-releases.ts) and the agents'
// (release-cache.ts). One anonymous request lists a repository's newest releases with their notes. GitHub allows 60
// anonymous requests an hour per address, so both callers cache the answer, and they only ask while an admin has the
// Updates page open (its polls are what asks).
//
// Whether notes announce breaking changes is read from the conventions changelogs use, never guessed from a word
// alone: Qwen Code's notes always have a "Breaking Changes" heading, mostly followed by "No known breaking changes."
import { readBoundedText } from "../lib/bounded-body.ts";
import { isVersion } from "../lib/versions.ts";

const TIMEOUT_MS = 10_000;
/**
 * Releases asked for, newest first: GitHub's maximum for one request. Qwen Code also publishes nightlies, previews
 * and other products (a desktop app, an SDK) there, so its newest 30 covered only 12 days (8 stable releases) in
 * November 2026; 100 cover the five versions offered plus older ones still on the server.
 */
const PER_PAGE = 100;
/** Notes longer than this are cut (the page links to the full notes). */
export const NOTES_CHARS = 12_000;
/** 100 releases with long notes come to about 3 MB of JSON (Qwen Code's). */
const MAX_BYTES = 8 * 1024 * 1024;

export interface ReleaseNotes {
  title: string;
  /** The release's page on github.com. */
  url: string;
  publishedAt: number | null;
  /** Markdown, cut at NOTES_CHARS. */
  body: string;
  /** The notes announce breaking changes (hasBreakingChanges). */
  breaking: boolean;
}

export interface GitHubRelease {
  /** The git tag, e.g. "v0.27.4" or "dsh-v0.2.2-rc.1". */
  tag: string;
  prerelease: boolean;
  notes: ReleaseNotes;
}

export interface GitHubReleases {
  /** The repository's (owner/name) newest releases, drafts left out. Rejects with GitHubError. */
  list(repo: string): Promise<GitHubRelease[]>;
}

export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

/** owner/name as GitHub allows them. */
export function isGitHubRepo(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(value) && !value.endsWith("/.") && !value.endsWith("/..");
}

export function createGitHubReleases(fetchImpl: typeof fetch = fetch): GitHubReleases {
  return {
    async list(repo) {
      if (!isGitHubRepo(repo)) throw new GitHubError(`${repo} is not a GitHub repository (owner/name)`);
      let releases: unknown;
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=${PER_PAGE}`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "workspace-portal", "x-github-api-version": "2022-11-28" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new GitHubError(`GitHub answered ${response.status} for ${repo}'s releases`);
        }
        const text = await readBoundedText(response, MAX_BYTES);
        if (text === null) throw new GitHubError(`GitHub's list of ${repo}'s releases is too large`);
        releases = JSON.parse(text);
      } catch (error) {
        if (error instanceof GitHubError) throw error;
        const reason = (error as Error).name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000} s` : (error as Error).message;
        throw new GitHubError(`GitHub is unreachable (${reason})`);
      }
      if (!Array.isArray(releases)) return [];
      const list: GitHubRelease[] = [];
      for (const release of releases as Array<Record<string, unknown>>) {
        const tag = typeof release.tag_name === "string" ? release.tag_name : "";
        if (tag === "" || release.draft === true) continue;
        const body = typeof release.body === "string" ? release.body : "";
        const published = typeof release.published_at === "string" ? Date.parse(release.published_at) : NaN;
        list.push({
          tag,
          prerelease: release.prerelease === true,
          notes: {
            title: typeof release.name === "string" && release.name !== "" ? release.name : tag,
            url: typeof release.html_url === "string" && release.html_url.startsWith("https://github.com/") ? release.html_url : `https://github.com/${repo}/releases`,
            publishedAt: Number.isFinite(published) ? published : null,
            body: body.length > NOTES_CHARS ? `${body.slice(0, NOTES_CHARS)}\n\n…` : body,
            breaking: hasBreakingChanges(body),
          },
        });
      }
      return list;
    },
  };
}

/** What a "Breaking changes" section says when there are none: "No known breaking changes.", "None", "N/A". */
const NONE = /^(?:no|none|n\/a|nothing)\b/i;

/**
 * Whether release notes announce a breaking change, by the conventions changelogs follow: a heading that names
 * breaking changes (release-please's "⚠ BREAKING CHANGES", Qwen Code's "Breaking Changes") with an entry under it
 * that isn't "none"; a line that starts "BREAKING CHANGE:" (a Conventional Commits footer) or "Breaking change:"; an
 * entry marked breaking the Conventional Commits way, "fix(deps)!: …".
 */
export function hasBreakingChanges(markdown: string): boolean {
  let inBreakingSection = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("<!--")) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      inBreakingSection = /breaking/i.test(heading[1] ?? "");
      continue;
    }
    const entry = line.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
    const text = entry.replace(/[*_`]/g, "").trim();
    if (text === "") continue;
    if (inBreakingSection && !NONE.test(text)) return true;
    if (/^\W*breaking[ -]changes?\s*:/i.test(text)) return true;
    if (entry !== line && /^[a-z]+(?:\([^)]*\))?!:/i.test(text)) return true;
  }
  return false;
}

/**
 * The npm version a release tag is for: "v1.2.3" or "1.2.3", or in a repository of several products, the package's
 * own "<name>-v1.2.3" or "<name>@1.2.3" (`name` without its scope). null for any other tag: another product of the
 * same repository ("desktop-v0.27.4" in Qwen Code's) is no release of the package.
 */
export function tagVersion(tag: string, packageName: string): string | null {
  const name = packageName.replace(/^@[^/]+\//, "");
  for (const prefix of ["v", "", `${name}-v`, `${name}@`, `${packageName}@`]) {
    if (!tag.startsWith(prefix)) continue;
    const version = tag.slice(prefix.length);
    if (isVersion(version)) return version;
  }
  return null;
}
