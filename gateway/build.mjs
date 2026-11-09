// Bundles the gateway (and @portal/db, drizzle) into dist/main.js.
//   node build.mjs                       bundle only
//   node build.mjs --runtime-deps <dir>  also copy the external packages and everything they depend
//                                        on into <dir>/node_modules (used by the Dockerfile)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Loaded from node_modules at runtime: native addons and packages with optional native deps. */
const EXTERNAL = ["better-sqlite3", "dockerode", "ws"];

await build({
  entryPoints: [path.join(here, "src/main.ts")],
  outfile: path.join(here, "dist/main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  external: EXTERNAL,
  logLevel: "info",
});

const flag = process.argv.indexOf("--runtime-deps");
if (flag !== -1) {
  const target = process.argv[flag + 1];
  if (!target) throw new Error("--runtime-deps needs a target directory");
  const count = stageRuntimeDeps(path.resolve(target));
  console.log(`staged ${count} runtime packages in ${path.join(path.resolve(target), "node_modules")}`);
}

/**
 * Copies the externals and their installed dependencies (`dependencies` and installed
 * `optionalDependencies`, recursively) to `<targetDir>/node_modules`, keeping nesting so Node
 * resolves the same versions it does here.
 */
function stageRuntimeDeps(targetDir) {
  const staged = new Map(); // destination -> source
  const pending = EXTERNAL.map((name) => ({ name, from: here, optional: false }));
  while (pending.length > 0) {
    const { name, from, optional } = pending.pop();
    const source = resolvePackageDir(name, from);
    if (!source) {
      if (optional) continue;
      throw new Error(`runtime dependency ${name} (needed from ${from}) is not installed`);
    }
    const destination = path.join(targetDir, nodeModulesPath(source));
    const previous = staged.get(destination);
    if (previous !== undefined) {
      if (previous !== source) throw new Error(`conflicting copies of ${name}: ${previous} and ${source}`);
      continue;
    }
    staged.set(destination, source);
    const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    for (const dep of Object.keys(manifest.dependencies ?? {})) pending.push({ name: dep, from: source, optional: false });
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) pending.push({ name: dep, from: source, optional: true });
  }
  for (const [destination, source] of staged) {
    const nested = path.join(source, "node_modules");
    fs.cpSync(source, destination, { recursive: true, filter: (file) => file !== nested });
  }
  return staged.size;
}

/** Node's lookup: <dir>/node_modules/<name>, walking up from `fromDir`. */
function resolvePackageDir(name, fromDir) {
  for (let dir = fs.realpathSync(fromDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

/** `/repo/node_modules/a/node_modules/b` -> `node_modules/a/node_modules/b`. */
function nodeModulesPath(packageDir) {
  const parts = packageDir.split(path.sep);
  const first = parts.indexOf("node_modules");
  if (first === -1) throw new Error(`${packageDir} is not inside node_modules`);
  return parts.slice(first).join(path.sep);
}
