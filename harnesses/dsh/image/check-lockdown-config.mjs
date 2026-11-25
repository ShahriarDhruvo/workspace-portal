// node check-lockdown-config.mjs <dsh package dir> <lockdown.patch.yml> <composed profile>
// The second half of check-lockdown.sh, on the profile dsh --dump-config composed with the lockdown: fails unless
// every setting a lockdown row gives (its config) is one the row's plugin declares, with a value the plugin's schema
// takes. dsh composes a setting its plugin doesn't declare without a word, and the plugin ignores it, so a setting a
// dsh update renamed or removed (agent-team's defaultEnabled, say) would quietly stop applying. Each plugin is
// imported, as dsh resolves it, to read its schema (its Config); none is started. A row missing from the composition
// is check-lockdown.sh's to report. The lockdown holds no !!js expression, and this check refuses one.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function main([dshDir, lockdownFile, composedFile]) {
  if (!composedFile) {
    throw new Error("usage: node check-lockdown-config.mjs <dsh package dir> <lockdown.patch.yml> <composed profile>");
  }
  const require = createRequire(join(dshDir, "package.json"));
  const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
  // dsh's own YAML parser. The composition holds dsh's !!js expressions: read as text, never run.
  const { default: yaml } = await load("js-yaml");
  const expression = new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (source) => ({ source }) });
  const read = (file, schema) => {
    const rows = yaml.load(readFileSync(file, "utf8"), { schema });
    if (!Array.isArray(rows)) throw new Error(`${file} is not a list of rows`);
    return rows;
  };

  // Each id of the composition with its plugin's name, groups' rows included.
  const names = new Map();
  const index = (rows) => {
    for (const row of rows) {
      if (typeof row?.id === "string") names.set(row.id, row.name);
      if (row?.group && Array.isArray(row.config)) index(row.config);
    }
  };
  index(read(composedFile, yaml.DEFAULT_SCHEMA.extend([expression])));

  const problems = [];
  const checked = [];
  for (const row of read(lockdownFile, yaml.DEFAULT_SCHEMA)) {
    if (row?.config === undefined || !names.has(row.id)) continue;
    const name = names.get(row.id);
    const where = `${row.id} (${name})`;
    let schema;
    try {
      const plugin = await load(name);
      schema = (plugin.default ?? plugin).Config ?? plugin.Config;
    } catch (error) {
      problems.push(`${where}: the plugin does not load: ${error.message}`);
      continue;
    }
    if (typeof schema !== "function" || schema.type !== "object" || typeof schema.dict !== "object") {
      problems.push(`${where}: its Config is not an object schema, which this check reads`);
      continue;
    }
    if (row.config === null || typeof row.config !== "object" || Array.isArray(row.config)) {
      problems.push(`${where}: its config is not a mapping`);
      continue;
    }
    const declared = Object.keys(schema.dict);
    for (const key of Object.keys(row.config).filter((key) => !Object.hasOwn(schema.dict, key))) {
      problems.push(`${where} has no setting ${key} (it has: ${declared.join(", ") || "none"})`);
    }
    try {
      schema(row.config);
    } catch (error) {
      problems.push(`${where}: ${error.message}`);
    }
    checked.push(row.id);
  }
  if (problems.length > 0) {
    throw new Error(`${lockdownFile} gives settings dsh's plugins don't take:\n  ${problems.join("\n  ")}`);
  }
  console.log(`check-lockdown: every setting of ${lockdownFile} is its plugin's own (${checked.join(", ") || "no row gives one"})`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`check-lockdown: ${error.message}`);
  process.exit(1);
}
