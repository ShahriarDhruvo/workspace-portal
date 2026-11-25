// What every workspace's agent is told before its first prompt, whichever harness it runs: the facts of its workspace
// that it cannot find out by looking (whose it is, where the portal is, what is kept, what the network reaches, how
// the person gets to see a web server), then the portal's own instructions: a Markdown file in the data folder
// (config/instructions.md, which a fresh install copies from instructions.md), read at every start. A driver puts the
// text in the workspace's settings directory; its settings.ts says how the harness comes to read it.
import fs from "node:fs";
import type { WorkspaceKind } from "@portal/core";
import type { HarnessConfig, WorkspaceFacts } from "./harness.ts";
import { AgentConfigError } from "./shared.ts";

/** The text's name in a settings directory: the one every harness knows instructions by. */
export const INSTRUCTIONS_FILE = "AGENTS.md";
/** The admin's file may be this long: every request to the model carries it. */
export const MAX_INSTRUCTIONS_BYTES = 32 * 1024;

const NETWORK: Record<WorkspaceKind, string> = {
  private:
    "Network: none. Nothing can be downloaded or installed (npm, pip, cargo, go get, git clone), so use what is installed and what the project already has. The search tools are the only way to the web.",
  online: "Network: the internet, for downloads, package registries and git. The LAN and the machine the workspace runs on are out of reach.",
};

/** A workspace's instructions. Throws AgentConfigError when the admin's file can't be used. */
export function agentInstructions(config: HarnessConfig, { kind, person, place }: WorkspaceFacts): string {
  const facts = [
    "# This workspace",
    "",
    "You work in a Workspace Portal workspace: a Linux container that belongs to one person, who uses it from a web browser on another computer.",
    "",
    `- The person: ${person}.`,
    ...(place === null ? [] : [`- Place: the portal's server is in ${place}.`]),
    "- Files: projects belong in /workspace, and /home/user is the home folder. Both are kept. Everything else is read-only, and /tmp is emptied at every start.",
    "- Nothing in /tmp can be run (it is mounted noexec): build and run programs in /workspace or the home folder.",
    `- ${NETWORK[kind]}`,
    "- Installed: Node.js with npm and pnpm, Python 3 with uv and ruff, Go, Rust with cargo, rustfmt and clippy, GCC and G++ with make and gdb, Bash with shellcheck and shfmt, PowerShell (pwsh), git, ripgrep, jq and curl. There is no root, no apt and no Docker.",
    "- Web servers: make a server listen on 0.0.0.0, not on localhost only (`next dev -H 0.0.0.0`, `vite --host 0.0.0.0`). The person opens it with the Preview button in the portal's bar, which appears while a server runs. Tell them its port. Never give them a localhost link: in their browser, localhost is their own computer.",
    ...(config.workspace.browser
      ? ["- The browser tools run a headless Chromium inside this workspace, where http://localhost:<port> is this workspace: use them to look at what you built."]
      : []),
  ].join("\n");
  const admin = adminInstructions(config.instructionsFile);
  return `${admin === "" ? facts : `${facts}\n\n${admin}`}\n`;
}

/** The admin's file, trimmed; "" when there is none. */
function adminInstructions(file: string): string {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new AgentConfigError(`cannot read the instructions file ${file}: ${(error as Error).message}`);
  }
  if (Buffer.byteLength(text) > MAX_INSTRUCTIONS_BYTES) {
    throw new AgentConfigError(`the instructions file ${file} is longer than ${MAX_INSTRUCTIONS_BYTES / 1024} KiB: every request to the model carries it.`);
  }
  return text.trim();
}
