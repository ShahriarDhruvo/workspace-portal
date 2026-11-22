// node portal-theme.mjs <dsh package dir>
// DeepSeek Harness's dark theme in the blacks of Qwen Code's Web Shell, which the portal's own dark theme copies
// (web/app/theme.css): as shipped, dsh's dark surfaces are a bluish grey (#151517) and its frame stands out against
// the portal's top bar. Its light theme stays as it is. dsh has no setting for this. Two edits:
//   1. a stylesheet in the web frontend's index.html that sets dsh's dark surface tokens to the Web Shell's colours
//      (SURFACES below). Its selector outweighs the theme's own `body[data-ds-dark-theme]`, so it wins wherever the
//      theme's stylesheet lands in the page;
//   2. the theme's boot background, which colours the page before any script runs, in the same black.
// Everything that sits on these surfaces (text, borders, buttons, menus) keeps dsh's own colours.
// All or nothing: when the theme no longer defines a token this sets, or a file doesn't have what the edit expects
// exactly once, the script names each such problem, writes nothing and fails the build, so an update to that dsh
// version fails and the current one stays.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

/** Marks what this script adds to index.html; also how a second run knows the work is done. */
const MARKER = "data-workspace-portal";

/** The Web Shell's dark colours (its --background, --sidebar-background, --card, --sidebar-accent and --muted). */
const BACKGROUND = "#0a0a0a";
const SIDEBAR = "#0d0d0d";
const CARD = "#171717";
const ACCENT = "#1e1e1e";
const MUTED = "#262626";

/** dsh's dark surface tokens, each with its colour here and, as a comment, what dsh draws with it. */
const SURFACES = [
  ["--dsw-alias-bg-base", BACKGROUND, "the page: the chat, its header and status bar"],
  ["--dsw-alias-bg-document-preview", BACKGROUND, "the file preview"],
  ["--dsw-specific-sidebar-fill", SIDEBAR, "the sidebar"],
  ["--dsw-specific-sidebar-nav-item-active", ACCENT, "the sidebar's current session"],
  ["--dsw-alias-bg-layer-1", CARD, "panels on the page"],
  ["--dsw-alias-bg-layer-2", ACCENT, "panels on panels, settings cards"],
  ["--dsw-alias-bg-layer-3", MUTED, "the topmost panels"],
  ["--dsw-specific-input-major", CARD, "the message box"],
  ["--dsw-specific-bubble", MUTED, "the person's own messages"],
  ["--dsw-alias-markdown-code-block", CARD, "code blocks"],
  ["--dsw-alias-markdown-code-segment-unselected", CARD, "a code block's tabs"],
  // The fades over a thinking block's last lines: from the page's colour, and a selected block's, to clear.
  ["--dsw-linear-gradient-think", `linear-gradient(180deg, ${BACKGROUND} 20.19%, ${BACKGROUND}00 100%)`, "thinking"],
  ["--dsw-linear-think-select", `linear-gradient(180deg, ${CARD} 20.19%, ${CARD}00 100%)`, "selected thinking"],
];

/** (0,1,2) over the theme's (0,1,1): the order the stylesheets land in doesn't matter. */
const STYLE = `html body[data-ds-dark-theme] {\n${SURFACES.map(([name, value, use]) => `  ${name}: ${value}; /* ${use} */`).join("\n")}\n}`;

/** The theme's boot background, as dsh writes it (formatted or minified, "" or ``), and the colour it gets here. */
const BOOT = /\bDARK_BACKGROUND\s*=\s*(["'`])#151517\1/g;
const BOOT_EDITED = `DARK_BACKGROUND = "${BACKGROUND}"`;

/** A package's file, resolved the way dsh itself resolves its dependencies. */
function packageFile(dshDir, name, file) {
  const require = createRequire(join(dshDir, "package.json"));
  return join(dirname(require.resolve(`${name}/package.json`)), file);
}

/** Why the module doesn't parse, or null when it does (`node --check`: nothing runs). */
function parseError(code) {
  const dir = mkdtempSync(join(tmpdir(), "portal-theme-"));
  try {
    const file = join(dir, "module.mjs");
    writeFileSync(file, code);
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status === 0) return null;
    const lines = (result.stderr || result.error?.message || "unknown error").trim().split("\n");
    return lines.find((line) => /Error/.test(line)) ?? lines[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The tokens SURFACES sets that the theme's dark rules don't define: each would set nothing. */
function missingTokens(themeClient) {
  const dark = [...themeClient.matchAll(/body\[data-ds-dark-theme\]\s*\{([^}]*)\}/g)].map((rule) => rule[1]).join(";");
  return SURFACES.map(([name]) => name).filter((name) => !new RegExp(`(?:^|[;\\s])${name}\\s*:`).test(dark));
}

function main(dshDir) {
  if (!dshDir) throw new Error("usage: node portal-theme.mjs <dsh package dir>");
  const indexFile = packageFile(dshDir, "@deepseek-ai/dsh-web-frontend", "dist/index.html");
  const bootFile = packageFile(dshDir, "@deepseek-ai/dsh-client-ui-theme", "lib/index.js");
  const themeClientFile = packageFile(dshDir, "@deepseek-ai/dsh-client-ui-theme", "lib/client.js");
  const html = readFileSync(indexFile, "utf8");
  if (html.includes(MARKER)) return console.log(`portal-theme: ${indexFile} is edited already`);
  const boot = readFileSync(bootFile, "utf8");

  const problems = [];
  const missing = missingTokens(readFileSync(themeClientFile, "utf8"));
  if (missing.length > 0) problems.push(`the dark theme no longer defines ${missing.join(", ")}`);
  const heads = html.split("</head>").length - 1;
  if (heads !== 1) problems.push(`index.html has ${heads} </head>, expected one`);
  const boots = [...boot.matchAll(BOOT)].length;
  if (boots !== 1) problems.push(`the theme's boot background #151517 is in it ${boots} times, expected once`);
  let editedBoot = boot;
  if (boots === 1) {
    editedBoot = boot.replace(BOOT, BOOT_EDITED);
    const error = parseError(editedBoot);
    if (error) problems.push(`the edited boot theme doesn't parse: ${error}`);
  }
  if (problems.length > 0) throw new Error(problems.join("; "));

  writeFileSync(bootFile, editedBoot);
  writeFileSync(indexFile, html.replace("</head>", () => `<style ${MARKER}>\n${STYLE}\n</style>\n  </head>`));
  console.log(`portal-theme: the dark theme in Qwen Code's blacks (${indexFile}, ${bootFile})`);
}

try {
  main(process.argv[2]);
} catch (error) {
  console.error(`portal-theme: ${error.message}; nothing was changed`);
  process.exit(1);
}
