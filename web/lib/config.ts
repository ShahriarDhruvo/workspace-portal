import "server-only";
import path from "node:path";
import type { AdminSeedSettings } from "./seed";

// Runtime configuration from the environment (see .env.example at the repo root).

function text(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}").`);
  }
  return value;
}

/** The gateway refuses to start with a shorter one (gateway/src/config.ts); so does the portal. */
const MIN_CONTROL_SECRET_LENGTH = 16;

/**
 * The control API's bearer token, which is also the HMAC key of every workspace browser token. A missing
 * or short one is an error, never an empty key. Read on use rather than at import: `next build` loads
 * this module without the runtime environment.
 */
function controlSecret(): string {
  const value = process.env.GATEWAY_CONTROL_SECRET?.trim() ?? "";
  if (value.length < MIN_CONTROL_SECRET_LENGTH) {
    throw new Error(
      value.length === 0
        ? "GATEWAY_CONTROL_SECRET is required (deploy/install.sh generates it in .env)."
        : `GATEWAY_CONTROL_SECRET must be at least ${MIN_CONTROL_SECRET_LENGTH} characters.`,
    );
  }
  return value;
}

const dataDir = text("PORTAL_DATA_DIR", "/srv/workspace-portal");

export const config = {
  dataDir,
  dbFile: path.join(dataDir, "db", "portal.sqlite"),
  /** User N's workspace is served by the gateway on port agentPortBase + N (its own browser origin). */
  agentPortBase: positiveInt("AGENT_PORT_BASE", 3100),
  agentPortCount: positiveInt("AGENT_PORT_COUNT", 200),
  /** The gateway control API on 127.0.0.1. */
  controlPort: positiveInt("CONTROL_PORT", 4002),
  get controlSecret(): string {
    return controlSecret();
  },
  cookieSecure: process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase() === "true",
  sessionTtlSeconds: positiveInt("SESSION_TTL_HOURS", 168) * 3600,
  idleTimeoutMinutes: positiveInt("IDLE_TIMEOUT_MINUTES", 30),
} as const;

/** Throws when a setting the server can't run without is missing. Called once at server start. */
export function checkRuntimeConfig(): void {
  controlSecret();
}

/** The admin account created on first start when no admin exists (seed.ts). */
export function adminSeedSettings(): AdminSeedSettings {
  return {
    username: text("ADMIN_USERNAME", "admin"),
    password: process.env.ADMIN_PASSWORD ?? "",
    firstName: text("ADMIN_FIRST_NAME", "Portal"),
    middleName: process.env.ADMIN_MIDDLE_NAME ?? "",
    lastName: text("ADMIN_LAST_NAME", "Admin"),
  };
}
