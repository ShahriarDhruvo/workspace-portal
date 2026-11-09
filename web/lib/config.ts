import "server-only";
import path from "node:path";

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

const dataDir = text("PORTAL_DATA_DIR", "/srv/workspace-portal");

export const config = {
  dataDir,
  dbFile: path.join(dataDir, "db", "portal.sqlite"),
  /** User N's workspace is served by the gateway on port agentPortBase + N (its own browser origin). */
  agentPortBase: positiveInt("AGENT_PORT_BASE", 3100),
  agentPortCount: positiveInt("AGENT_PORT_COUNT", 200),
  /** The gateway control API on 127.0.0.1. */
  controlPort: positiveInt("CONTROL_PORT", 4002),
  controlSecret: process.env.GATEWAY_CONTROL_SECRET?.trim() ?? "",
  cookieSecure: process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase() === "true",
  sessionTtlSeconds: positiveInt("SESSION_TTL_HOURS", 168) * 3600,
  idleTimeoutMinutes: positiveInt("IDLE_TIMEOUT_MINUTES", 30),
} as const;

/** The admin account created on first start when no admin exists. */
export function adminSeedSettings() {
  return {
    username: text("ADMIN_USERNAME", "admin"),
    password: process.env.ADMIN_PASSWORD ?? "",
    firstName: text("ADMIN_FIRST_NAME", "Portal"),
    middleName: process.env.ADMIN_MIDDLE_NAME ?? "",
    lastName: text("ADMIN_LAST_NAME", "Admin"),
  };
}
