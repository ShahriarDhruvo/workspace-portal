// node web-preview.mjs <dsh package dir>
// Points DeepSeek Harness's web preview, the sidebar Browser, at the web apps running in the workspace. The Browser is
// a frame in the person's own browser, where localhost is their own computer; dsh has no setting for this. One edit:
// an address of the workspace's own (localhost, 127.x.x.x, 0.0.0.0, [::1]) becomes
// `<this page's host>:<its port + PREVIEW_PORT_OFFSET>/__portal/port/<port>/<path>`, which the gateway answers with the
// workspace's port <port> (gateway/src/proxy/preview-proxy.ts); any other address stays. The tab keeps the typed
// host name as its title.
// The edit is in parseBrowserAddress, which every address the Browser opens goes through (the address bar, a new tab,
// a chat link) and which gets the page's own origin; on Desktop it gets none, and nothing changes there.
// dsh names a client file's URL after its modification time (dsh-client-modules), so browsers fetch the edited one.
// All or nothing: when the code isn't there exactly once, the edited file doesn't parse, or the edited function
// doesn't send the examples below where they belong, the script names the problem, writes nothing and fails the
// build, so an update to that dsh version fails and the current one stays.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The gateway serves a workspace's web apps on its agent port + this (gateway/src/config.ts, PREVIEW_PORT_OFFSET;
 * a gateway test checks the two agree).
 */
const PREVIEW_PORT_OFFSET = 10000;

/** Marks the edit; also how a second run knows the work is done. */
const MARKER = "/* workspace-portal: web preview */";

/**
 * The preview address of `u` (a URL) from a page at origin `p`, or `u` itself: when there is no page origin (Desktop),
 * the host isn't a loopback one, the page has no port, or `u` already is this page's preview port.
 */
const PREVIEW_ADDRESS =
  `(u,p)=>{if(p===void 0||p==="null"||!/^(?:localhost|127(?:\\.\\d{1,3}){3}|0\\.0\\.0\\.0|\\[::1\\])$/i.test(u.hostname))return u;` +
  `let w;try{w=new URL(p)}catch{return u}const q=Number(w.port)+${PREVIEW_PORT_OFFSET};` +
  `if(!w.port||q>65535||(u.hostname===w.hostname&&u.port===String(q)))return u;` +
  `return new URL("/__portal/port/"+(u.port||(u.protocol==="https:"?"443":"80"))+u.pathname+u.search+u.hash,w.protocol+"//"+w.hostname+":"+q)}`;

// Whatever the layout: dsh has shipped this file formatted (0.2.2-rc.1) and minified (0.2.2-rc.5), with "" or ``.
const FUNCTION = /function parseBrowserAddress\(([\w$]+),\s*([\w$]+)\)\s*\{/g;
/** In the function, the target of an accepted address: `kind: …, url: url.href, title: url.hostname`. */
const TARGET =
  /(kind:\s*([\w$]+)\.protocol\s*===\s*(["`])https:\3\s*\?\s*\3https\3\s*:\s*\3http\3,\s*url:\s*)\2\.href(,\s*title:\s*\2\.hostname)/g;

/** What the edited function must answer: [input, page origin, the target's url (null: refused)]. */
const EXAMPLES = [
  ["http://localhost:3000/app?x=1#top", "https://portal.lan:5101", "https://portal.lan:6101/__portal/port/3000/app?x=1#top"],
  ["localhost:5173", "http://192.168.1.20:5102", "http://192.168.1.20:6102/__portal/port/5173/"],
  ["127.0.0.1:8080/api", "https://portal.lan:5101", "https://portal.lan:6101/__portal/port/8080/api"],
  ["http://0.0.0.0:4000", "https://portal.lan:5101", "https://portal.lan:6101/__portal/port/4000/"],
  ["http://[::1]:9000/", "https://portal.lan:5101", "https://portal.lan:6101/__portal/port/9000/"],
  ["https://example.com/docs", "https://portal.lan:5101", "https://example.com/docs"],
  ["https://portal.lan:6101/__portal/port/3000/", "https://portal.lan:5101", "https://portal.lan:6101/__portal/port/3000/"],
  // The portal itself at localhost (a test install): its preview port stays as it is.
  ["http://localhost:6101/__portal/port/3000/", "http://localhost:5101", "http://localhost:6101/__portal/port/3000/"],
  ["http://localhost:3000/", undefined, "http://localhost:3000/"],
  ["https://portal.lan:5101/", "https://portal.lan:5101", null],
];

/** dsh-client-ui-sidebar-browser's client file, resolved the way dsh itself resolves its dependencies. */
function clientFile(dshDir) {
  const require = createRequire(join(dshDir, "package.json"));
  const pkg = require.resolve("@deepseek-ai/dsh-client-ui-sidebar-browser/package.json");
  const { exports } = JSON.parse(readFileSync(pkg, "utf8"));
  const client = exports?.["./client"];
  const path = typeof client === "string" ? client : client?.default;
  if (typeof path !== "string") throw new Error(`${pkg} exports no ./client`);
  return join(dirname(pkg), path);
}

/** Why the file doesn't parse, or null when it does (`node --check`: nothing runs). */
function parseError(code) {
  const dir = mkdtempSync(join(tmpdir(), "web-preview-"));
  try {
    const file = join(dir, "client.js");
    writeFileSync(file, code);
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status === 0) return null;
    const lines = (result.stderr || result.error?.message || "unknown error").trim().split("\n");
    return lines.find((line) => /Error/.test(line)) ?? lines[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The function declared at `start`, as a source string. */
const declaration = (source) => `${source}\nreturn parseBrowserAddress;`;

/**
 * Where the function declared at `start` ends: after the first "}" at which the source from `start` compiles. An
 * earlier "}" leaves its body open, or a string or template unterminated, so it doesn't.
 */
function functionEnd(code, start) {
  for (let end = code.indexOf("}", start); end !== -1; end = code.indexOf("}", end + 1)) {
    try {
      new Function(declaration(code.slice(start, end + 1)));
      return end + 1;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error("parseBrowserAddress has no end");
}

/** The function declared at `start`, on its own: its source runs without the rest of the bundle. */
function functionAt(code, start) {
  return new Function(declaration(code.slice(start, functionEnd(code, start))))();
}

/** The edited file, or throws naming what doesn't fit. */
function edit(code) {
  const headers = [...code.matchAll(FUNCTION)];
  if (headers.length !== 1) throw new Error(`parseBrowserAddress is in the file ${headers.length} times, expected once`);
  const [header] = headers;
  const origin = header[2];
  const end = functionEnd(code, header.index);
  const targets = [...code.matchAll(TARGET)].filter((match) => match.index > header.index && match.index < end);
  if (targets.length !== 1) throw new Error(`parseBrowserAddress's accepted target is in it ${targets.length} times, expected once`);
  const [target] = targets;
  const replaced = `${target[1]}${MARKER}(${PREVIEW_ADDRESS})(${target[2]}, ${origin}).href${target[4]}`;
  const edited = code.slice(0, target.index) + replaced + code.slice(target.index + target[0].length);
  const error = parseError(edited);
  if (error) throw new Error(`the edited file doesn't parse: ${error}`);
  const parse = functionAt(edited, header.index);
  for (const [input, page, expected] of EXAMPLES) {
    const result = parse(input, page);
    const actual = result.ok ? result.target.url : null;
    if (actual !== expected) throw new Error(`${JSON.stringify(input)} from ${page}: ${actual}, expected ${expected}`);
  }
  return edited;
}

function main(dshDir) {
  if (!dshDir) throw new Error("usage: node web-preview.mjs <dsh package dir>");
  const file = clientFile(dshDir);
  const code = readFileSync(file, "utf8");
  if (code.includes(MARKER)) return console.log(`web-preview: ${file} is edited already`);
  writeFileSync(file, edit(code));
  console.log(`web-preview: ${file}: loopback addresses go to the preview port`);
}

try {
  main(process.argv[2]);
} catch (error) {
  console.error(`web-preview: ${error.message}; nothing was changed`);
  process.exit(1);
}
