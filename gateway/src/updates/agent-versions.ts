// The current version of each agent: what new workspaces of that agent start with, and with it their
// image. This module is the gateway's only source of both.
//
// The .env versions (Config.workspace.defaultVersions) are the defaults, what a fresh install builds.
// The admin's choice is kept in PORTAL_DATA_DIR/config/agent-versions.env, KEY=VALUE lines with the
// .env keys (QWEN_CODE_VERSION=0.27.4) and # comments; a missing file or key means the default. The
// gateway reads it at boot and writes it after an update in the admin console; deploy/update-image.sh
// writes it too (lib.sh agent_version_set) and then restarts the gateway, and deploy/lib.sh
// agent_version reads it first, so install.sh and verify-isolation.sh act on the current versions as
// well.
//
// Both writers change only their own agent's line of the file as it is on disk at that moment (the
// gateway reads it again before writing), so neither undoes a version the other has just written.
// Writes are atomic (a temp file in the same directory, then rename), mode 0600 in a 0700 directory:
// the gateway runs as root, so both are root's, like the rest of config/.
import fs from "node:fs";
import path from "node:path";
import { AGENT_KINDS, type AgentKind } from "@portal/core";
import { driverFor } from "../agents/index.ts";
import type { Config } from "../config.ts";
import { workspaceImage } from "../docker/image-names.ts";
import type { Logger } from "../lib/log.ts";
import { writeFileAtomic } from "../workspaces/paths.ts";
import { isVersion } from "../lib/versions.ts";

const HEADER = [
  "# The agent versions new workspaces start with (the admin console and deploy/update-image.sh write",
  "# this file). A missing key means the default from .env.",
];

/**
 * KEY=VALUE lines, read the way deploy/lib.sh env_value reads them: the last line of a key wins,
 * quotes are removed, and an unquoted value ends at " #".
 */
export function parseVersionsFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if (value.startsWith('"')) value = value.slice(1).split('"')[0]!;
    else if (value.startsWith("'")) value = value.slice(1).split("'")[0]!;
    else value = value.split(" #")[0]!.trimEnd();
    entries.set(match[1]!, value);
  }
  return entries;
}

/**
 * The file's text with KEY set to VALUE, as deploy/lib.sh agent_version_set sets it: the key's lines
 * go and one new line is appended; every other line (other keys, comments, anything unknown) stays as
 * it is. No file yet (null): a header and the line.
 */
export function withVersion(text: string | null, key: string, value: string): string {
  const lines = text === null ? [...HEADER] : text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [...lines.filter((line) => !line.startsWith(`${key}=`)), `${key}=${value}`, ""].join("\n");
}

export interface AgentVersionsOptions {
  file: string;
  defaults: Readonly<Record<AgentKind, string>>;
  log: Logger;
}

export class AgentVersions {
  readonly #file: string;
  readonly #defaults: Readonly<Record<AgentKind, string>>;
  readonly #current = new Map<AgentKind, string>();

  /** Reads the selection file; a missing or unreadable file, or an invalid version in it, means the defaults. */
  constructor(options: AgentVersionsOptions) {
    this.#file = options.file;
    this.#defaults = options.defaults;
    const entries = readEntries(options.file, options.log);
    for (const kind of AGENT_KINDS) {
      const key = driverFor(kind).release.versionKey;
      const chosen = entries.get(key);
      if (chosen === undefined || chosen === "") continue;
      if (isVersion(chosen)) this.#current.set(kind, chosen);
      else options.log.error(`${key} in ${options.file} is not a version; using the default`, { value: chosen, default: options.defaults[kind] });
    }
  }

  static fromConfig(config: Config, log: Logger): AgentVersions {
    return new AgentVersions({ file: config.agentVersionsFile, defaults: config.workspace.defaultVersions, log });
  }

  /** The version new workspaces of this agent start with. */
  current(kind: AgentKind): string {
    return this.#current.get(kind) ?? this.#defaults[kind];
  }

  /** The current version and its image, as one consistent pair. */
  selection(kind: AgentKind): { version: string; image: string } {
    const version = this.current(kind);
    return { version, image: workspaceImage(kind, version) };
  }

  defaultVersion(kind: AgentKind): string {
    return this.#defaults[kind];
  }

  /**
   * Makes `version` current: saved first, so a failed write (or an unreadable file) changes nothing.
   * Only this agent's line changes, in the file as it is now: deploy/update-image.sh may have written
   * another agent's version since the gateway read it (it restarts the gateway afterwards).
   */
  set(kind: AgentKind, version: string): void {
    if (!isVersion(version)) throw new Error(`not a version: ${JSON.stringify(version)}`);
    const dir = path.dirname(this.#file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.#file, withVersion(readText(this.#file), driverFor(kind).release.versionKey, version), 0o600);
    this.#current.set(kind, version);
  }
}

/** The file's text; null when there is none yet. */
function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readEntries(file: string, log: Logger): Map<string, string> {
  try {
    return parseVersionsFile(readText(file) ?? "");
  } catch (error) {
    log.error("cannot read the agent versions; using the defaults", { file, error });
    return new Map();
  }
}
