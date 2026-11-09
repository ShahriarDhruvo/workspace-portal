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
} from "drizzle-orm/sqlite-core";

export const ROLES = ["admin", "user"] as const;
export type Role = (typeof ROLES)[number];

export const WORKSPACE_STATUSES = ["stopped", "starting", "running", "stopping", "error"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
