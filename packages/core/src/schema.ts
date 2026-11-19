// Drizzle schema shared by the web app and the gateway.
// All timestamps are integer milliseconds since the Unix epoch.
// The SQL in migrations.ts must stay in sync with this file.
import { sql } from "drizzle-orm";
import { AGENT_KINDS, ENERGY_CURRENCIES, ENERGY_PRICE_SOURCES, HOST_ROLES, ROLES, WORKSPACE_KINDS, WORKSPACE_STATUSES } from "./wire/index.ts";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  /** The kind of the current container, or of the last one when stopped ("private" if never started). */
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

// Written by the gateway's energy meter: each server's totals per local day (YYYY-MM-DD, usageDay()), from its
// portal-hostd's running counters. Kept for good (two rows a day): Admin > Energy prices them per day.
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

// Published electricity prices (energy-locations.ts), one row per place and period, downloaded by the gateway
// (gateway/src/monitor/energy-prices.ts) for every place; Admin > Energy prices each day at its chosen place's.
export const energyPrices = sqliteTable(
  "energy_prices",
  {
    /** An energy-locations.ts id: "US-FL", "EU-DE". */
    location: text("location").notNull(),
    /** YYYY-MM-DD, the period's first day. */
    periodStart: text("period_start").notNull(),
    /** YYYY-MM-DD, the day after the period's last. */
    periodEnd: text("period_end").notNull(),
    /** As the source names it: "2026-08" (a month, EIA) or "2026-S1" (a half year, Eurostat). */
    period: text("period").notNull(),
    /** In `currency` per kWh (EIA's 14.99 cents is 0.1499). */
    price: real("price").notNull(),
    currency: text("currency", { enum: ENERGY_CURRENCIES }).notNull(),
    source: text("source", { enum: ENERGY_PRICE_SOURCES }).notNull(),
    /** Epoch ms of the download that last wrote the row (sources revise recent figures). */
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.location, t.periodStart] })],
);

// Portal-wide settings the admin changes in the browser, one row per key (PORTAL_SETTING_KEYS); a missing row is
// "not set".
const PORTAL_SETTING_KEYS = ["energy_price_location"] as const;
export type PortalSettingKey = (typeof PORTAL_SETTING_KEYS)[number];

export const portalSettings = sqliteTable("portal_settings", {
  key: text("key", { enum: PORTAL_SETTING_KEYS }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Written by the gateway (session-log.ts): each run of a user's workspace, from Start to its stop, and what its LLM
// requests added up to. Kept for good; Admin > Usage lists them, the running ones first.
export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: WORKSPACE_KINDS }).notNull(),
    agent: text("agent", { enum: AGENT_KINDS }),
    /** The workspace's startedAt: when Start was pressed. */
    startedAt: integer("started_at").notNull(),
    /** When it stopped; null while it runs. */
    endedAt: integer("ended_at"),
    /** Requests that reached the LLM server, and those of them it failed (not those the workspace hung up on). */
    requests: integer("requests").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    /** As the answers' `usage` counts them, like llm_usage: tokens in (cached ones included) and out. */
    promptTokens: integer("prompt_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** From the engine's timings: prompt tokens served from its cache, read, and written, with its compute time. */
    cachedTokens: integer("cached_tokens").notNull().default(0),
    readTokens: integer("read_tokens").notNull().default(0),
    readMs: real("read_ms").notNull().default(0),
    writeTokens: integer("write_tokens").notNull().default(0),
    writeMs: real("write_ms").notNull().default(0),
    /** The requests' time from reaching the LLM server to their last byte, added up. */
    llmMs: integer("llm_ms").notNull().default(0),
    /**
     * Its share of the LLM server's measured energy while its requests ran (shared with the requests running at the
     * same time), and the time that share covers; null while none was measured.
     */
    energyJ: real("energy_j"),
    energyMs: integer("energy_ms").notNull().default(0),
  },
  (t) => [
    uniqueIndex("workspace_sessions_open").on(t.userId).where(sql`${t.endedAt} IS NULL`),
    index("workspace_sessions_order").on(t.endedAt, t.startedAt),
  ],
);

// A user's keys to the LLM API (/llm/api, gateway/src/service/llm-api.ts), created and revoked on the web app's API
// page. A revoked key stays, for what it used.
export const apiKeys = sqliteTable("api_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** sha256 hex of the key (hashSessionToken); the key itself is never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  /** The key's last four characters, to tell one's keys apart. */
  hint: text("hint").notNull(),
  createdAt: integer("created_at").notNull(),
  /** null while it works. */
  revokedAt: integer("revoked_at"),
});

// Written by the gateway (key-usage.ts): what each key's requests added up to per local day (usageDay()).
export const apiKeyUsage = sqliteTable(
  "api_key_usage",
  {
    keyId: integer("key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    /** Requests that reached the LLM server, and those of them it failed. */
    requests: integer("requests").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Its share of the LLM server's measured energy while its requests ran; 0 while none was measured. */
    energyJ: real("energy_j").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.day] })],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceSession = typeof workspaceSessions.$inferSelect;
