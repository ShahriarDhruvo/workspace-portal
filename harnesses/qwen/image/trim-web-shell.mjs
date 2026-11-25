// node trim-web-shell.mjs <qwen-code package dir>
// Trims Qwen Code's Web Shell in place, in the image build:
//   * the left rail keeps Home and the sidebar toggle: no Activity, Plugins, Channels, Channel events, Live,
//     Scheduled Tasks, PR watches, Goals or "More" menu;
//   * the chat header loses Mobile access (pairing a phone, which the gateway blocks);
//   * a finished turn keeps its answer on screen when background tasks get replies after it: as shipped, the last
//     reply alone stays and the answer is folded into "Processed" with the turn's steps;
//   * the Web preview shows the workspace's web apps: in the person's browser localhost is their own computer, so
//     localhost, 127.x.x.x and 0.0.0.0 go to the workspace's preview port (the gateway's preview proxy), and its
//     frame may lock the pointer and show alert and confirm dialogs;
//   * the dialog that asks what to do with a dropped file holds its three buttons: as shipped it is 24rem wide, less
//     than they need in English and Russian, and its content sticks out of it;
//   * a file dropped or attached in the Web Shell may be as large as the gateway's upload limit, and goes to disk
//     as it arrives: as shipped the daemon holds each upload in memory whole, up to 50 MiB.
// Qwen Code has no setting for these: the app hard-codes its shell component's options, and the upload limit is a
// constant.
// Three layers:
//   1. The app bundle: the shell component's options, a turn's visible replies and the Web preview, for every
//      layout and language. The edited bundle gets a new file name (an import map in index.html points the other
//      chunks at it), because browsers keep the shipped one cached as immutable.
//   2. A stylesheet in index.html, keyed on the Web Shell's data-* attributes and icon names, not on its generated
//      class names: on the desktop layouts it hides the buttons layer 1 removes, and the rail's agents button,
//      which layer 1 keeps; and it sizes the dropped-file dialog.
//   3. The daemon's upload route.
// All or nothing: when an edit no longer fits (its code isn't there exactly once, or the result doesn't parse) or
// the app lacks what the stylesheet keys on, the script names each such change, writes nothing and fails the
// build, so an update to that Qwen Code version fails and the current one stays.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // Wide enough for the English buttons in one row; longer ones wrap instead of widening the dialog's grid.
  "[data-web-shell-drop-choice-dialog] { max-width: min(32rem, calc(100% - 2rem)) !important; }",
  '[data-web-shell-drop-choice-dialog] [data-slot="dialog-footer"] { flex-wrap: wrap; }',
].join("\n");

/** What the stylesheet keys on, as the app's code holds it: the data-* attributes, and lucide icons by name. */
const STYLE_HOOKS = [
  /"data-web-shell-navigation-rail"/,
  /"data-web-shell-home-trigger"/,
  /"data-web-shell-sidebar-collapse"/,
  /"data-sidebar-shell"/,
  /"data-web-shell-drop-choice-dialog"/,
  /"data-slot":"dialog-footer"/,
  // cn("bell",…) is the icon whose svg has the class lucide-bell.
  /`lucide-\$\{[\w$]+\}`/,
  /\("bell",[\w$]+\)/,
  /\("qr-code",[\w$]+\)/,
];

/**
 * Layer 1, edits of the Web Shell app's bundle. Each pattern must match exactly once. Minified names are
 * matched as `[\w$]+`, so a rebuild of the same code still fits; anything else is a different version.
 */
/**
 * The gateway serves a workspace's web apps on its agent port + this (gateway/src/config.ts, PREVIEW_PORT_OFFSET;
 * a gateway test checks the two agree).
 */
const PREVIEW_PORT_OFFSET = 10000;

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
    name: "a turn's answer stays visible when background tasks get replies after it",
    // A finished turn shows its last reply and folds the rest into "Processed …". Walking back from that reply,
    // the shipped loop keeps the reply before it too, but only with nothing but a task's "completed" row between
    // the two. A background turn puts its start row and the reply's thinking there, so the answer was folded away:
    //   for(let de=M-1;de>y;de--){const we=e[de];if(we.type!=="message")break;
    //   if(we.message.role==="system"&&we.message.source==="background_task_completed")Z=!0;
    //   else if(Z&&we.message.role==="assistant")P=de,Z=!1;else break}
    // (e: the turn's rows, M: the last reply, P: the first row kept; 0.28.3 skips "mod_log" rows first). The walk
    // now goes to the turn's start and keeps every reply that ended the turn or a background turn: the last text
    // before a background turn began or a task completed, unless tool calls came after it.
    pattern:
      /for\(let ([\w$]+)=([\w$]+)-1;\1>([\w$]+);\1--\)\{const ([\w$]+)=([\w$]+)\[\1\];if\(\4\.type!=="message"\)break;(?:if\(!\(\4\.message\.role==="system"&&\4\.message\.source==="mod_log"\)\))?if\(\4\.message\.role==="system"&&\4\.message\.source==="background_task_completed"\)([\w$]+)=!0;else if\(\6&&\4\.message\.role==="assistant"\)([\w$]+)=\1,\6=!1;else break\}/g,
    replace: (_, i, last, start, row, rows, crossed, from) =>
      `for(let ${i}=${last}-1,portalWork=!1;${i}>${start};${i}--){const ${row}=${rows}[${i}],` +
      `portalRole=${row}.type==="message"?${row}.message.role:"",portalSource=portalRole==="system"?${row}.message.source:"";` +
      `if(portalSource==="background_task_completed"||portalSource==="background_notification_turn_started")${crossed}=!0,portalWork=!1;` +
      `else if(${row}.type==="parallel_agents"||portalRole==="tool_group"||portalRole==="plan")portalWork=!0;` +
      `else if(${crossed}&&!portalWork&&portalRole==="assistant"&&${row}.message.content?.trim())${from}=${i},${crossed}=!1}`,
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

/** Layer 3. The upload limit in bytes, which the gateway sets (../driver.ts; its test checks the name). */
const UPLOAD_LIMIT_ENV = "WORKSPACE_PORTAL_UPLOAD_LIMIT_BYTES";

/**
 * In place of the upload route's express.raw(): the request itself is the body. The daemon's atomic write
 * (FileHandle.writeFile) takes it chunk by chunk, counting and hashing on the way, as the write's result needs both.
 * An encoded body is refused (415), as express.raw does, and so is a byte over the limit. A second write, which only
 * a file appearing under the same name mid-upload asks for, fails instead of writing nothing. The limit's edit
 * alone would let one upload fill the workspace's memory, which all or nothing rules out.
 */
const STREAMED_BODY =
  '(req,res,next)=>{const encoding=req.headers["content-encoding"];if(encoding&&encoding!=="identity")return next({status:415});' +
  "let used=false;req.body={length:0,async*[Symbol.asyncIterator](){" +
  'if(used)throw new Error("the upload was already written");used=true;' +
  'const hash=process.getBuiltinModule("node:crypto").createHash("sha256");' +
  "for await(const chunk of req){this.length+=chunk.length;" +
  'if(this.length>MAX_UPLOAD_BYTES)throw new FsError("file_too_large","upload exceeds "+MAX_UPLOAD_BYTES+" bytes");' +
  'hash.update(chunk);yield chunk}this.hash="sha256:"+hash.digest("hex")}};next()}';

const UPLOAD_EDITS = [
  {
    name: "uploads: the limit",
    // var MAX_UPLOAD_BYTES=50*1024*1024; also what the daemon tells the Web Shell, which checks a file before sending it.
    pattern: /(var MAX_UPLOAD_BYTES=)(50\*1024\*1024;)/g,
    replace: (_, head, shipped) => `${head}Number(process.env.${UPLOAD_LIMIT_ENV})||${shipped}`,
  },
  {
    name: "uploads: the body as a stream",
    pattern: /import_express\d*\.default\.raw\(\{type:"application\/octet-stream",limit:MAX_UPLOAD_BYTES,inflate:false\}\)/g,
    replace: () => STREAMED_BODY,
  },
  {
    name: "uploads: the size and hash of a stream",
    // function writeBufferToTemp(input){await input.handle.writeFile(input.buf);…
    //   return{sizeBytes:input.buf.length,hash:hashBuffer(input.buf),stat:st}}
    pattern: /(function writeBufferToTemp\(([\w$]+)\)\{await \2\.handle\.writeFile\(\2\.buf\);[\s\S]{0,800}?return\{sizeBytes:\2\.buf\.length,hash:)(hashBuffer\(\2\.buf\))/g,
    replace: (_, head, input, shipped) => `${head}${input}.buf.hash??${shipped}`,
  },
];

/** The changes that don't fit this version; any of them fails the build. */
const problems = [];
const log = (message) => console.log(`trim-web-shell: ${message}`);

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

/** The JavaScript files of a directory, by name. */
const scripts = (dir) => new Map(readdirSync(dir).filter((name) => name.endsWith(".js")).map((name) => [name, readFileSync(join(dir, name), "utf8")]));

/**
 * Applies each edit to the one file of `files` that holds its code exactly once, and notes a problem for each
 * edit that isn't there exactly once or a file that doesn't parse afterwards. Returns the edited files.
 */
function applyEdits(files, edits, where) {
  const edited = new Map();
  for (const edit of edits) {
    const found = [...files].flatMap(([name, code]) => (code.match(edit.pattern) ?? []).map(() => name));
    if (found.length !== 1) {
      problems.push(`${edit.name}: its code is in ${where} ${found.length} times, expected once`);
      continue;
    }
    const [name] = found;
    edited.set(name, (edited.get(name) ?? files.get(name)).replace(edit.pattern, edit.replace));
  }
  for (const [name, code] of edited) {
    const error = parseError(code);
    if (error) problems.push(`${where}${name}, edited, doesn't parse: ${error}`);
  }
  return edited;
}

/** Every file to write, by path: nothing is written unless all of it fits. */
function adapt(packageDir) {
  const writes = new Map();
  const chunks = join(packageDir, "chunks");
  for (const [name, code] of applyEdits(scripts(chunks), UPLOAD_EDITS, "chunks/")) writes.set(join(chunks, name), code);

  const webShell = join(packageDir, "web-shell");
  const assets = join(webShell, "assets");
  const indexFile = join(webShell, "index.html");
  const html = readFileSync(indexFile, "utf8");
  const app = scripts(assets);
  for (const hook of STYLE_HOOKS) if (![...app.values()].some((code) => hook.test(code))) problems.push(`the stylesheet keys on ${hook.source}, which is not in web-shell/assets/`);
  if (!html.includes("</head>")) problems.push("web-shell/index.html has no </head> to add the stylesheet to");
  const entries = [...html.matchAll(/<script\b[^>]*><\/script>/g)]
    .map(([tag]) => ({ tag, src: /\bsrc="\/assets\/([^"/?#]+\.js)"/.exec(tag)?.[1] }))
    .filter(({ tag, src }) => src && /\btype="module"/.test(tag));
  if (entries.length !== 1) {
    problems.push(`web-shell/index.html loads ${entries.length} module scripts, expected one`);
    return writes;
  }
  const [entry] = entries;
  const code = applyEdits(new Map([[entry.src, app.get(entry.src)]]), EDITS, "web-shell/assets/").get(entry.src) ?? "";
  const bundle = entry.src.replace(/\.js$/, `.portal-${createHash("sha256").update(code).digest("hex").slice(0, 10)}.js`);
  writes.set(join(assets, bundle), code);
  // Function replacements throughout: a replacement string would interpret `$` sequences.
  const map = JSON.stringify({ imports: { [`/assets/${entry.src}`]: `/assets/${bundle}` } });
  const tag = entry.tag.replace(`/assets/${entry.src}`, () => `/assets/${bundle}`);
  writes.set(
    indexFile,
    html
      .replace("</head>", () => `<style ${MARKER}>\n${STYLE}\n</style>\n  </head>`)
      .replace(entry.tag, () => `<script type="importmap" ${MARKER}>${map}</script>\n    ${tag}`),
  );
  return writes;
}

function main(packageDir) {
  if (!packageDir) throw new Error("usage: node trim-web-shell.mjs <qwen-code package dir>");
  const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (readFileSync(join(packageDir, "web-shell", "index.html"), "utf8").includes(MARKER)) return log(`Qwen Code ${version} is adapted already`);
  const writes = adapt(packageDir);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`trim-web-shell: ${problem}`);
    throw new Error(`Qwen Code ${version} doesn't take ${problems.length} of the portal's changes (above); nothing was changed`);
  }
  for (const [file, code] of writes) writeFileSync(file, code);
  log(`Qwen Code ${version}: ${[...EDITS, ...UPLOAD_EDITS].length} edits and the stylesheet applied, in ${[...writes.keys()].map((file) => file.slice(packageDir.length + 1)).join(", ")}`);
}

try {
  main(process.argv[2]);
} catch (error) {
  console.error(`trim-web-shell: ${error.message}`);
  process.exit(1);
}
