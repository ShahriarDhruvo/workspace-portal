// Drizzle schema shared by the web app and the gateway.
// All timestamps are integer milliseconds since the Unix epoch.
// The SQL in migrations.ts must stay in sync with this file.
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  index,
  uniqueIndex,
  primaryKey,
  real,
} from "drizzle-orm/sqlite-core";

export const ROLES = ["admin", "user"] as const;
export type Role = (typeof ROLES)[number];

export const WORKSPACE_STATUSES = ["stopped", "starting", "running", "stopping", "error"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

/** The agents a workspace can run. A user's workspace runs one of them at a time. */
export const AGENT_KINDS = ["qwen", "dsh"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const AGENT_NAMES: Readonly<Record<AgentKind, string>> = { qwen: "Qwen Code", dsh: "DeepSeek Harness" };

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

/**
 * The two workspaces every user has. Each has its own files, UID, container, network and browser origin, and only
 * one of a user's two runs at a time. Private (the original kind) has no internet; Online reaches the public
 * internet but never the LAN, the servers or another container.
 */
export const WORKSPACE_KINDS = ["private", "online"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
export const WORKSPACE_KIND_NAMES: Readonly<Record<WorkspaceKind, string>> = { private: "Private", online: "Online" };

export function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return typeof value === "string" && (WORKSPACE_KINDS as readonly string[]).includes(value);
}

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull().unique(), // always stored lowercase
    firstName: text("first_name").notNull(),
    middleName: text("middle_name"),
    lastName: text("last_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ROLES }).notNull().default("user"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
    /** The agent this user's workspace starts with (Settings); null = the install's default (first of WORKSPACE_AGENTS). */
    agent: text("agent", { enum: AGENT_KINDS }),
    /** The admin lets this user start an Online workspace (ONLINE_WORKSPACES must be on as well). */
    onlineAllowed: integer("online_allowed", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastLoginAt: integer("last_login_at"),
  },
  (t) => [
    // Exactly one admin account can exist.
    uniqueIndex("users_one_admin").on(t.role).where(sql`role = 'admin'`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256 hex of the cookie token; the raw token is never stored
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Admin only: whose workspace this session is currently viewing.
    actingAsUserId: integer("acting_as_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("sessions_user_id").on(t.userId),
    index("sessions_acting_as").on(t.actingAsUserId),
    index("sessions_expires_at").on(t.expiresAt),
  ],
);

// Owned by the gateway: the last known state of each user's container.
export const workspaces = sqliteTable("workspaces", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  containerId: text("container_id"),
  containerName: text("container_name"),
  ip: text("ip"),
  status: text("status", { enum: WORKSPACE_STATUSES }).notNull().default("stopped"),
  /** The agent of the current container, or of the last one when stopped; null if never started. */
  agent: text("agent", { enum: AGENT_KINDS }),
  /** The kind of the current container, or of the last one when stopped ("private" for rows from before kinds). */
  kind: text("kind", { enum: WORKSPACE_KINDS }).notNull().default("private"),
  startedAt: integer("started_at"),
  stoppedAt: integer("stopped_at"),
  lastActivityAt: integer("last_activity_at"),
  stopReason: text("stop_reason"),
  lastError: text("last_error"),
  updatedAt: integer("updated_at").notNull(),
});

// Failed-login tracking per (lowercased) username, including names that do not exist.
export const loginAttempts = sqliteTable("login_attempts", {
  username: text("username").primaryKey(),
  failures: integer("failures").notNull().default(0),
  firstFailureAt: integer("first_failure_at"),
  lockedUntil: integer("locked_until"),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    // null = the system (gateway reaper, startup, ...)
    actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetUserId: integer("target_user_id").references(() => users.id, { onDelete: "set null" }),
    details: text("details"), // JSON string
  },
  (t) => [index("audit_log_at").on(t.at)],
);

// Written by the gateway's LLM proxy.
export const llmUsage = sqliteTable(
  "llm_usage",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: text("day").notNull(), // YYYY-MM-DD, server local time
    requests: integer("requests").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/** The two servers portal-hostd reports on: the portal's own and the LLM server. */
export const HOST_ROLES = ["portal", "llm"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

// Written by the gateway's energy meter: each server's totals per local day (YYYY-MM-DD, usageDay()), from its
// portal-hostd's running counters. Kept for good (two rows a day): Admin > Usage prices them per day.
export const hostDaily = sqliteTable(
  "host_daily",
  {
    day: text("day").notNull(),
    role: text("role", { enum: HOST_ROLES }).notNull(),
    /** Energy the server's measured power (hostd's `power.watts`) added up to; null while it can't be measured. */
    energyWh: real("energy_wh"),
    /** Bytes received and sent on the server's physical network interfaces. */
    rxBytes: integer("rx_bytes").notNull().default(0),
    txBytes: integer("tx_bytes").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.role] })],
);

// The energy meter's last reading of each portal-hostd's counters, so a gateway restart counts only what is new.
export const hostMeter = sqliteTable("host_meter", {
  role: text("role", { enum: HOST_ROLES }).primaryKey(),
  /** hostd's meter instance (new on each hostd start, when its counters begin again at zero). */
  instance: text("instance").notNull(),
  /** Epoch ms of the reading, on the gateway's clock. */
  at: integer("at").notNull(),
  energyJ: real("energy_j"),
  rxBytes: integer("rx_bytes"),
  txBytes: integer("tx_bytes"),
});

// The electricity price, one row per change, in force from its day until the next row's (Admin > Usage).
export const energyRates = sqliteTable("energy_rates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** YYYY-MM-DD, local. */
  effectiveFrom: text("effective_from").notNull().unique(),
  /** All per-kWh charges together, in US cents. */
  centsPerKwh: real("cents_per_kwh").notNull(),
  /** Where the price comes from, e.g. "TECO residential, first 1,000 kWh". */
  note: text("note"),
  createdAt: integer("created_at").notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type HostDaily = typeof hostDaily.$inferSelect;
export type EnergyRate = typeof energyRates.$inferSelect;
