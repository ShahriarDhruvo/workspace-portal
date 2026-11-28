// Release notes from GitHub, for Admin > Updates: one anonymous request lists a repository's newest releases with their
// notes, or the newest commits of a branch (a program whose repository has no releases). GitHub allows 60 anonymous
// requests an hour per address, so the answers are cached (release-cache.ts) and asked for only while an admin has the
// Updates page open (its polls are what asks).
import { failureReason, fetchBounded, isVersion, type ReleaseNotes } from "@portal/core";

/**
 * Releases asked for, newest first: GitHub's maximum for one request. Qwen Code's repository also publishes nightlies,
 * previews and other products, and OpenCode's the releases of OpenCode 1 and of its other programs, so it takes 100
 * to cover the versions offered and older ones still on the server.
 */
const PER_PAGE = 100;
/** Notes longer than this are cut (the page links to the full notes). */
const NOTES_CHARS = 12_000;
/**
 * 100 releases with long notes come to about 3 MB of JSON (Qwen Code's). OpenCode's come to 6 MB, nearly all of it
 * the list of some 33 files attached to each release.
 */
const MAX_BYTES = 32 * 1024 * 1024;

export interface GitHubRelease {
  /** The git tag, e.g. "v0.27.4" or "dsh-v0.2.2-rc.1". */
  tag: string;
  prerelease: boolean;
  notes: ReleaseNotes;
}

export interface GitHubCommit {
  /** The full 40-character id. */
  id: string;
  /** Its message as notes: the first line is the title, the rest the body, the committer's date the date. */
  notes: ReleaseNotes;
}

export interface GitHubReleases {
  /** The repository's (owner/name) newest releases, drafts left out. Rejects with GitHubError. */
  list(repo: string): Promise<GitHubRelease[]>;
  /** The `count` newest commits of the repository's `branch`, newest first. Rejects with GitHubError. */
  commits(repo: string, branch: string, count: number): Promise<GitHubCommit[]>;
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

const cutNotes = (body: string): string => (body.length > NOTES_CHARS ? `${body.slice(0, NOTES_CHARS)}\n\n…` : body);

export function createGitHubReleases(fetchImpl: typeof fetch = fetch): GitHubReleases {
  /** GitHub's JSON for `path` of the repository; `what` names the list in an error. */
  async function ask(repo: string, path: string, what: string): Promise<unknown> {
    if (!isGitHubRepo(repo)) throw new GitHubError(`${repo} is not a GitHub repository (owner/name)`);
    try {
      const { ok, status, text } = await fetchBounded(fetchImpl, `https://api.github.com/repos/${repo}/${path}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "workspace-portal", "x-github-api-version": "2022-11-28" },
        maxBytes: MAX_BYTES,
      });
      if (!ok) throw new GitHubError(`GitHub answered ${status} for ${repo}'s ${what}`);
      if (text === null) throw new GitHubError(`GitHub's list of ${repo}'s ${what} is too large`);
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError(`GitHub is unreachable (${failureReason(error)})`);
    }
  }
  return {
    async list(repo) {
      const releases = await ask(repo, `releases?per_page=${PER_PAGE}`, "releases");
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
            body: cutNotes(body),
            breaking: hasBreakingChanges(body),
          },
        });
      }
      return list;
    },
    async commits(repo, branch, count) {
      const what = `commits on ${branch}`;
      const commits = await ask(repo, `commits?sha=${encodeURIComponent(branch)}&per_page=${count}`, what);
      // Only the list's order says which commit is newer: an answer that is no list, or lacks an id, is refused whole.
      if (!Array.isArray(commits)) throw new GitHubError(`GitHub's answer for ${repo}'s ${what} is not a list`);
      return commits.map((entry: { sha?: unknown; commit?: { message?: unknown; committer?: { date?: unknown } | null } | null } | null) => {
        const id = entry?.sha;
        if (typeof id !== "string" || !/^[0-9a-f]{40}$/.test(id)) throw new GitHubError(`GitHub's list of ${repo}'s ${what} has an entry without a commit id`);
        const message = typeof entry?.commit?.message === "string" ? entry.commit.message : "";
        const [first = "", ...rest] = message.split("\n");
        const date = entry?.commit?.committer?.date;
        const committed = typeof date === "string" ? Date.parse(date) : NaN;
        return {
          id,
          notes: {
            title: first.trim() || id,
            url: `https://github.com/${repo}/commit/${id}`,
            publishedAt: Number.isFinite(committed) ? committed : null,
            body: cutNotes(rest.join("\n").trim()),
            breaking: hasBreakingChanges(message),
          },
        };
      });
    },
  };
}

/** What a "Breaking changes" section says when there are none: "No known breaking changes.", "None", "N/A". */
const NONE = /^(?:no|none|n\/a|nothing)\b/i;

/**
 * Whether release notes announce a breaking change, by the conventions changelogs follow, never guessed from a word
 * alone: a heading that names breaking changes (release-please's "⚠ BREAKING CHANGES", Qwen Code's "Breaking Changes")
 * with an entry under it that isn't "none"; a line that starts "BREAKING CHANGE:" (a Conventional Commits footer) or
 * "Breaking change:"; an entry marked breaking the Conventional Commits way, "fix(deps)!: …".
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
