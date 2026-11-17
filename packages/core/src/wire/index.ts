// @portal/core/wire: what the gateway, the web server and the browser share. Nothing in this folder imports from
// outside it (web/lib/client-imports.test.ts checks), so client components can take values from it; the package's
// main entry re-exports it and brings SQLite along.
export * from "./kinds.ts";
export * from "./energy-locations.ts";
export * from "./versions.ts";
