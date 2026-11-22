// node default-profile.mjs <dsh package dir> [--check]
// Switches on Auto review (@deepseek-ai/dsh-experimental-auto-review: before each tool call the session's own model
// judges it; an allowed call runs with Full access, a denied one asks the person), which dsh comes with but leaves
// off. Once for each person, in their own web profile ($DSH_HOME/profiles/web), so it is theirs to switch off under
// Plugins like any other plugin:
//   * no profile yet: dsh's own initProfile (dsh-app-boot) creates it, as dsh would at its start, from dsh's web
//     template (PROFILE_TEMPLATES in dsh-official-bundles) plus Auto review;
//   * a profile from before: Auto review is added to its bundles, unless they list it.
// A marker in the profile records that it was done, so a person's later choice stays.
// start-dsh runs it before dsh; a failure there is reported and dsh starts all the same. With --check (the image
// build), it changes nothing and fails unless dsh still has all of that: initProfile, resolveProfileDir, the web
// template and the Auto review bundle.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PROFILE = "web";
const AUTO_REVIEW = "@deepseek-ai/dsh-experimental-auto-review";
const MARKER = ".workspace-portal-auto-review";

/** What of dsh this uses, resolved as dsh resolves its dependencies; throws when any of it is gone. */
async function fromDsh(dshDir) {
  const require = createRequire(join(dshDir, "package.json"));
  const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
  require.resolve(`${AUTO_REVIEW}/package.json`);
  const { PROFILE_TEMPLATES } = await load("@deepseek-ai/dsh-official-bundles");
  const { initProfile, resolveProfileDir } = await load("@deepseek-ai/dsh-app-boot");
  const template = PROFILE_TEMPLATES?.[PROFILE]?.bundles;
  if (!Array.isArray(template) || template.length === 0 || !template.every((name) => typeof name === "string")) {
    throw new Error(`dsh-official-bundles has no ${PROFILE} profile template`);
  }
  if (typeof initProfile !== "function" || typeof resolveProfileDir !== "function") {
    throw new Error("dsh-app-boot exports no initProfile or resolveProfileDir");
  }
  return { template, initProfile, resolveProfileDir };
}

function writeJson(file, value) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** What was done to the profile in `dir`, in a few words. */
function seed(dir, { template, initProfile }) {
  if (existsSync(join(dir, MARKER))) return "done before";
  const manifestFile = join(dir, "package.json");
  let outcome;
  if (!existsSync(manifestFile)) {
    initProfile(dir, [...template, AUTO_REVIEW]);
    outcome = "new profile, with Auto review";
  } else {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) throw new Error(`${manifestFile} lists no dsh.profile.bundles`);
    if (bundles.includes(AUTO_REVIEW)) outcome = "Auto review listed already";
    else {
      const profile = { ...manifest.dsh.profile, bundles: [...bundles, AUTO_REVIEW] };
      writeJson(manifestFile, { ...manifest, dsh: { ...manifest.dsh, profile } });
      outcome = "Auto review added";
    }
  }
  writeFileSync(join(dir, MARKER), "Auto review was switched on here once; Plugins switches it off.\n", { mode: 0o600 });
  return outcome;
}

async function main([dshDir, flag]) {
  if (!dshDir) throw new Error("usage: node default-profile.mjs <dsh package dir> [--check]");
  const dsh = await fromDsh(dshDir);
  if (flag === "--check") {
    return console.log(`default-profile: dsh's ${PROFILE} template is ${dsh.template.join(", ")}; ${AUTO_REVIEW} is there`);
  }
  const home = process.env.DSH_HOME;
  if (!home) throw new Error("DSH_HOME is not set");
  console.log(`default-profile: ${seed(dsh.resolveProfileDir(PROFILE, home), dsh)}`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`default-profile: ${error.message}`);
  process.exit(1);
}
