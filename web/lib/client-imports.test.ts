// Client components may take only types from @portal/core: its main entry brings SQLite (node:fs), which no browser
// bundle can hold, and Next fails the page only once it is opened. Values come from @portal/core/wire (a folder that
// imports nothing from outside itself) or as props from a server component.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const WEB = path.join(import.meta.dirname, "..");
const WIRE = path.join(WEB, "..", "packages", "core", "src", "wire");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

test('"use client" files import only types from @portal/core', () => {
  const offenders = ["app", "components", "lib"]
    .flatMap((dir) => sources(path.join(WEB, dir)))
    .filter((file) => /^\s*["']use client["']/.test(fs.readFileSync(file, "utf8")))
    .flatMap((file) =>
      [...fs.readFileSync(file, "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+"@portal\/core"/gm)].map(() => path.relative(WEB, file)),
    );
  assert.deepEqual(offenders, []);
});

test("@portal/core/wire imports nothing from outside its folder", () => {
  const outside = sources(WIRE).flatMap((file) =>
    [...fs.readFileSync(file, "utf8").matchAll(/^(?:import\s+|(?:import|export)\s[^;]*?\sfrom\s+)"([^"]+)"/gm)]
      .filter(([, from]) => !/^\.\/[^/]+$/.test(from!))
      .map(([, from]) => `${path.basename(file)}: ${from}`),
  );
  assert.deepEqual(outside, []);
});
