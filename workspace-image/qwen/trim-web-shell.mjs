// Trims Qwen Code's Web Shell to what the portal's users use, in place, at image build time (Dockerfile,
// qwen stage, right after `npm install -g @qwen-code/qwen-code`):
//   * the left rail keeps only Home and the sidebar toggle: no Activity view, Plugins, Channels, Channel
//     events, Live, Scheduled Tasks, PR watches, Goals, nor the "More" menu (Settings, theme, Session
//     Overview, Split View, Daemon Status, Local files, Use this computer);
//   * the chat header loses Mobile access (pairing a phone with Local Control, which the gateway blocks);
//   * every new session starts with Plan mode on (the composer's + menu toggle), running the approved plan
//     in the approval mode the composer shows, as when a person turns the toggle on;
//   * the Web preview shows the workspace's own web apps: it loads its address in the person's browser, where
//     http://localhost:3000 is the person's own computer, so localhost, 127.x.x.x and 0.0.0.0 go to the
//     workspace's preview port instead (the gateway's preview-proxy.ts), and its frame may lock the pointer
//     (mouse look in a game) and show alert/confirm dialogs.
// Qwen Code has no setting for any of this: the Web Shell app hard-codes the options of its shell component,
// and `tools.approvalMode: "plan"` would also start the terminal's `qwen` and headless `qwen -p` in plan
// mode (headless can't leave it, so it could change nothing) and run approved plans with "Ask" approval.
//
// Two layers, each working without the other:
//   1. The app bundle: the shell component's own options (sidebar.primaryNav and footer items, showLive,
//      header.showMobileAccess) and the Plan toggle's initial state for a new session. Covers every layout
//      (rail, expanded sidebar, phone drawer) and language. The edited bundle gets a new file name (an import
//      map in index.html points the other chunks at it): browsers keep the shipped one cached as immutable.
//   2. A stylesheet in index.html, keyed on the Web Shell's data-* attributes and icon names, never on its
//      generated class names: the rail shows only Home and the toggle, and the Activity and Mobile access
//      buttons are hidden. Covers the desktop layouts even when a later version no longer fits layer 1.
//
// Never fails the build: an edit that no longer fits (the code it expects isn't there exactly once, or
// the result doesn't parse) is skipped with a warning, and that part of the Web Shell stays as shipped.
//
// Usage: node trim-web-shell.mjs <qwen-code package dir>
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Marks what this script adds to index.html; also how a second run knows the work is done. */
const MARKER = "data-workspace-portal";

/**
 * Layer 2. `:has()` and the lucide icon classes are what the Web Shell's own markup offers that is stable
 * across languages and builds (its aria-labels are translated, its class names hashed).
 */
const STYLE = [
  "nav[data-web-shell-navigation-rail] button:not([data-web-shell-home-trigger]):not([data-web-shell-sidebar-collapse]),",
  "[data-sidebar-shell] button:has(> svg.lucide-bell),",
  "header button:has(> svg.lucide-qr-code) { display: none !important; }",
].join("\n");

/**
 * Layer 1, edits of the Web Shell app's bundle. Each pattern must match exactly once. Minified names are
 * matched as `[\w$]+`, so a rebuild of the same code still fits; anything else is a different version.
 */
/**
 * The gateway serves a workspace's web apps on its agent port + this (gateway/src/config.ts, PREVIEW_PORT_OFFSET;
 * a gateway test checks the two agree).
 */
const PREVIEW_PORT_OFFSET = 1000;

/**
 * The Web preview's address, as the person's browser can reach it: a loopback address of the workspace becomes
 * `<this page's host>:<its port + PREVIEW_PORT_OFFSET>/__portal/port/<port>/<path>`, which the gateway answers
 * with the workspace's port <port>. `u` is the address (a URL), `p` this page's address; any other address stays.
 */
const PREVIEW_ADDRESS =
  `(u,p)=>{if(!/^(?:localhost|127(?:\\.\\d{1,3}){3}|0\\.0\\.0\\.0)$/i.test(u.hostname))return u;` +
  `const w=new URL(p),q=Number(w.port)+${PREVIEW_PORT_OFFSET};if(!w.port||q>65535)return u;` +
  `return new URL("/__portal/port/"+(u.port||(u.protocol==="https:"?"443":"80"))+u.pathname+u.search+u.hash,w.protocol+"//"+w.hostname+":"+q)}`;

const EDITS = [
  {
    name: "sidebar: only Home, New session and the toggle",
    // sidebar:{enabled:!0,showLive:!0,primaryNav:{items:<all>},footer:{items:<More menu + collapse>}}
    // The Web Shell keeps its rail (Home, the toggle) only while primaryNav lists an entry besides
    // "newTask": "agents" stays for that. Its button shows only with Qwen Code's agent collaboration,
    // off by default (and the stylesheet hides it anyway). No Live, no Tasks/Channels switch.
    pattern: /(sidebar:\{enabled:!0,showLive:)!0(,primaryNav:\{items:)[\w$]+(\},footer:\{items:)[^{}]+(\}\})/g,
    replace: (_, a, b, c, d) => `${a}!1,showSessionSourceSwitch:!1${b}["newTask","agents"]${c}["collapse"]${d}`,
  },
  {
    name: "header: no Mobile access",
    pattern: /(header:\{showMobileAccess:)!0/g,
    replace: (_, a) => `${a}!1`,
  },
  {
    name: "Plan mode on for new sessions",
    // The effect that sets the Plan toggle (tb) from the session's mode: without a session, an
    // execution mode ("auto", ...) becomes Plan running in that mode; a session shows its own mode.
    //   const T=ce.currentMode,...,a1e(T??"default"))},[ce.currentMode,ce.planExecutionMode,ce.sessionId,ns])
    pattern:
      /(const ([\w$]+)=([\w$]+)\.currentMode,[\s\S]{0,400}?[\w$]+\()\2\?\?"default"(\)\)\},\[\3\.currentMode,\3\.planExecutionMode,\3\.sessionId,[\w$]+\]\))/g,
    replace: (_, head, mode, state, tail) =>
      `${head}(!${state}.sessionId&&${mode}&&${mode}!=="plan")?"plan":(${mode}??"default")${tail}`,
  },
  {
    name: "Web preview: the workspace's own addresses through the gateway",
    // The preview's address check, which both the address bar and the links opened from messages go through:
    //   function Eie(e,t,n){try{const s=new URL(e.trim());if(…)return;const r=[…],o=new URL(s);return o.protocol=
    //   "https:",r.includes(xB(s))||r.includes(xB(o))?void 0:s}catch{return}}
    // (t: this page's address). The address it accepts goes through PREVIEW_ADDRESS; the frame, its frame-src,
    // the refresh and "Open externally" all use what it returns.
    pattern: /(function [\w$]+\(([\w$]+),([\w$]+),[\w$]+\)\{try\{const ([\w$]+)=new URL\(\2\.trim\(\)\);[^{}]{0,400}?\?void 0:)\4(\}catch\{return\}\})/g,
    replace: (_, head, _address, page, parsed, tail) => `${head}(${PREVIEW_ADDRESS})(${parsed},${page})${tail}`,
  },
  {
    name: "Web preview: pointer lock and dialogs in its frame",
    // <iframe title="${o8(t)}" src="${o8(e.href)}" sandbox="allow-scripts allow-same-origin allow-forms" ...>
    // The sandbox keeps the app in its frame (no popups, no navigating the page); a game still needs the mouse.
    pattern: /(src="\$\{[\w$]+\([\w$]+\.href\)\}" sandbox="allow-scripts allow-same-origin allow-forms)"/g,
    replace: (_, head) => `${head} allow-pointer-lock allow-modals"`,
  },
];

const log = (message) => console.log(`trim-web-shell: ${message}`);
const warn = (message) => console.warn(`trim-web-shell: warning: ${message}`);

/** Why the JavaScript doesn't parse as a module, or null when it does (`node --check` on a copy: nothing runs). */
function parseError(code) {
  const dir = mkdtempSync(join(tmpdir(), "trim-web-shell-"));
  try {
    const file = join(dir, "bundle.mjs");
    writeFileSync(file, code);
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status === 0) return null;
    const lines = (result.stderr || result.error?.message || "unknown error").trim().split("\n");
    return lines.find((line) => /Error/.test(line)) ?? lines[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Layer 1: the edited bundle and its new name, or null when no edit applies. Throws when the result doesn't parse. */
function editBundle(assets, entry) {
  let code = readFileSync(join(assets, entry), "utf8");
  let applied = 0;
  for (const edit of EDITS) {
    const count = code.match(edit.pattern)?.length ?? 0;
    if (count !== 1) {
      warn(`${edit.name}: not applied (the code it edits was found ${count} times, expected once)`);
      continue;
    }
    code = code.replace(edit.pattern, edit.replace);
    applied++;
    log(`${edit.name}: applied`);
  }
  if (applied === 0) return null;
  const error = parseError(code);
  if (error) throw new Error(`the edited code doesn't parse: ${error}`);
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 10);
  return { code, name: entry.replace(/\.js$/, `.portal-${hash}.js`) };
}

function main(packageDir) {
  if (!packageDir) throw new Error("usage: node trim-web-shell.mjs <qwen-code package dir>");
  const webShell = join(packageDir, "web-shell");
  const indexFile = join(webShell, "index.html");
  const html = readFileSync(indexFile, "utf8");
  if (html.includes(MARKER)) return log("already trimmed");
  if (!html.includes("</head>")) return warn("index.html has no </head>; the Web Shell stays as shipped");

  // Function replacements throughout: a replacement string would interpret `$` sequences.
  let page = html.replace("</head>", () => `<style ${MARKER}>\n${STYLE}\n</style>\n  </head>`);
  const entries = [...html.matchAll(/<script\b[^>]*><\/script>/g)]
    .map(([tag]) => ({ tag, src: /\bsrc="\/assets\/([^"/?#]+\.js)"/.exec(tag)?.[1] }))
    .filter(({ tag, src }) => src && /\btype="module"/.test(tag));
  if (entries.length !== 1) {
    warn(`index.html loads ${entries.length} module scripts, expected one; only the stylesheet applies`);
  } else {
    try {
      const [entry] = entries;
      const bundle = editBundle(join(webShell, "assets"), entry.src);
      if (!bundle) throw new Error("no edit applies");
      writeFileSync(join(webShell, "assets", bundle.name), bundle.code);
      const map = JSON.stringify({ imports: { [`/assets/${entry.src}`]: `/assets/${bundle.name}` } });
      const tag = entry.tag.replace(`/assets/${entry.src}`, () => `/assets/${bundle.name}`);
      page = page.replace(entry.tag, () => `<script type="importmap" ${MARKER}>${map}</script>\n    ${tag}`);
      log(`app bundle: assets/${bundle.name}`);
    } catch (error) {
      warn(`the app bundle stays as shipped (${error.message}); only the stylesheet applies`);
    }
  }
  writeFileSync(indexFile, page);
  log("stylesheet: applied");
}

try {
  main(process.argv[2]);
} catch (error) {
  warn(`${error.message}; the Web Shell stays as shipped`);
}
