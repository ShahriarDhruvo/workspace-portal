import "server-only";
import { adminSeedSettings, checkRuntimeConfig } from "./config";
import { getDb } from "./db";
import { seedAdmin } from "./seed";

/**
 * Runs once when the server starts (instrumentation.ts; Next skips it during `next build`). It refuses to
 * start rather than run without the control secret: every gateway call would be rejected, and workspace
 * tokens would be signed with an empty key. Then it creates the admin account if there is none.
 */
export async function startServer(): Promise<void> {
  try {
    checkRuntimeConfig();
  } catch (error) {
    console.error(`[config] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  await seedAdmin(getDb(), adminSeedSettings());
}
