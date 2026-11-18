// node adapt-presets.mjs <dsh package dir>   (with the yaml package beside this script)
// Disables, in the agent presets dsh ships (dsh-web-app/presets/*.patch.yml), the rows that need what
// lockdown.patch.yml turns off (OFFLINE_ROWS): with them a preset is reported broken. A patch can't do it, because
// it replaces a preset row's whole config, and a preset restated in the lockdown goes stale with every dsh release.
// The edits are spliced into the source text at the ranges the parser reports, so the rest of each file stays byte
// for byte as shipped (writing the parsed document back would re-fold some scalars).
// Exits 1, failing the image build, when the presets are missing or don't parse, a file declares no preset, or a
// listed row is still enabled afterwards.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

/** Preset rows that can't work in a workspace, by plugin name. */
const OFFLINE_ROWS = new Set([
  "@deepseek-ai/dsh-tool-web", // web_search, web_fetch: need the `web` plugin (search is the portal's MCP server)
  "@deepseek-ai/dsh-plugin-manager/tools", // plugin installs: need the npm registry
  "@deepseek-ai/dsh-plugin-market/tools", // plugin market: needs the npm registry
]);

/** dsh-web-app's presets directory, resolved the way dsh itself resolves its dependency. */
function presetsDir(dshDir) {
  const webApp = createRequire(join(dshDir, "package.json")).resolve("@deepseek-ai/dsh-web-app/package.json");
  return join(dirname(webApp), "presets");
}

function presetFiles(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith(".patch.yml")).sort();
  if (files.length === 0) throw new Error(`no *.patch.yml in ${dir}`);
  return files.map((name) => join(dir, name));
}

/** The `config.plugins` list of every preset the patch file declares (inserted or patched rows). */
function presetPluginLists(doc) {
  if (!isSeq(doc.contents)) throw new Error("not a patch list");
  return doc.contents.items.flatMap((patch) => {
    const rows = isMap(patch) && isSeq(patch.get("insert")) ? patch.get("insert").items : [patch];
    return rows.map((row) => (isMap(row) ? row.getIn(["config", "plugins"]) : undefined)).filter(isSeq);
  });
}

/** Every plugin row of a list, including those inside group rows (`group: true`, `config: [rows]`). */
function* pluginRows(list) {
  for (const row of list.items) {
    if (!isMap(row)) continue;
    yield row;
    if (row.get("group") === true && isSeq(row.get("config"))) yield* pluginRows(row.get("config"));
  }
}

function offlineRows(doc) {
  return presetPluginLists(doc).flatMap((list) => [...pluginRows(list)]).filter((row) => OFFLINE_ROWS.has(row.get("name")));
}

/** A literal `disabled: true`; a `!!js` condition is not (it may evaluate to false). */
function isDisabled(row) {
  const node = row.get("disabled", true);
  return isScalar(node) && node.value === true;
}

function pair(row, key) {
  return row.items.find((item) => isScalar(item.key) && item.key.value === key);
}

/**
 * The text edit that makes a row `disabled: true`. An existing `disabled` value is replaced where it
 * stands, from its tag or anchor (`!!js …`) to its end, so a comment after it and the line break stay;
 * with no value (`disabled:`, `disabled: # why`) `true` goes right after the colon. Without the key, it
 * is added on a new line after `name`, at the same indentation.
 */
function disableEdit(text, row) {
  if (row.flow) throw new Error(`row ${row.get("id")} is a flow mapping; can't edit it in place`);
  const disabled = pair(row, "disabled");
  if (disabled) {
    const colon = text.indexOf(":", disabled.key.range[1]);
    const start = colon + 1 + /^[ \t]*/.exec(text.slice(colon + 1))[0].length;
    const end = disabled.value?.range[1] ?? start;
    if (end <= start) return { start: colon + 1, end: colon + 1, text: " true" };
    // A block value's range ends past its last line break, and a block scalar's starts with its header
    // line (`|`, `>-`), which may carry the comment.
    const block = isScalar(disabled.value) && disabled.value.type.startsWith("BLOCK");
    const comment = block ? (/[ \t]#[^\n]*/.exec(text.slice(disabled.value.range[0], end).split("\n")[0])?.[0] ?? "") : "";
    return { start, end, text: `true${comment}${text[end - 1] === "\n" ? "\n" : ""}` };
  }
  const name = pair(row, "name");
  const indent = name.key.range[0] - (text.lastIndexOf("\n", name.key.range[0]) + 1);
  const lineEnd = text.indexOf("\n", name.value.range[1]);
  const at = lineEnd === -1 ? text.length : lineEnd;
  return { start: at, end: at, text: `\n${" ".repeat(indent)}disabled: true` };
}

function applyEdits(text, edits) {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text);
}

function parse(text) {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(doc.errors[0].message);
  return doc;
}

/** The document's data without the `disabled` keys of the listed rows: all an adaptation may change. */
function dataBesidesOfflineRows(doc) {
  return JSON.stringify(doc.toJS(), function (key, value) {
    return key === "disabled" && OFFLINE_ROWS.has(this.name) ? undefined : value;
  });
}

function checkAdapted(original, text) {
  const adapted = parse(text);
  const enabled = offlineRows(adapted).filter((row) => !isDisabled(row));
  if (enabled.length > 0) throw new Error(`still enabled: ${enabled.map((row) => row.get("id")).join(", ")}`);
  if (dataBesidesOfflineRows(adapted) !== dataBesidesOfflineRows(original)) throw new Error("the edit changed other rows");
}

/** Disables the file's offline rows; returns a one-line summary. */
function adaptFile(file) {
  const text = readFileSync(file, "utf8");
  const doc = parse(text);
  if (presetPluginLists(doc).length === 0) throw new Error("declares no preset (no config.plugins)");
  const rows = offlineRows(doc).filter((row) => !isDisabled(row));
  if (rows.length === 0) return "unchanged";
  const adapted = applyEdits(text, rows.map((row) => disableEdit(text, row)));
  checkAdapted(doc, adapted);
  writeFileSync(file, adapted);
  return `disabled ${rows.map((row) => row.get("id")).join(", ")}`;
}

function main(dshDir) {
  if (!dshDir) throw new Error("usage: node adapt-presets.mjs <dsh package dir>");
  const dir = presetsDir(dshDir);
  console.log(`adapt-presets: ${dir}`);
  for (const file of presetFiles(dir)) {
    try {
      console.log(`  ${file.slice(dir.length + 1)}: ${adaptFile(file)}`);
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
  }
}

try {
  main(process.argv[2]);
} catch (error) {
  console.error(`adapt-presets: ${error.message}`);
  process.exit(1);
}
