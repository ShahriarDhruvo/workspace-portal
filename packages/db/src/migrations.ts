// Ordered, append-only schema migrations. Applied by migrate() using PRAGMA user_version,
// inside an IMMEDIATE transaction so the web app and the gateway can both call it at startup.
// Never edit a migration that has shipped; add a new one instead. Keep schema.ts in sync.
export const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    username             TEXT    NOT NULL UNIQUE,
    first_name           TEXT    NOT NULL,
    middle_name          TEXT,
    last_name            TEXT    NOT NULL,
    password_hash        TEXT    NOT NULL,
    role                 TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    active               INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    last_login_at        INTEGER
  );
  CREATE UNIQUE INDEX users_one_admin ON users (role) WHERE role = 'admin';

  CREATE TABLE sessions (
    id                TEXT    PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    acting_as_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at        INTEGER NOT NULL,
    last_seen_at      INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    user_agent        TEXT
  );
  CREATE INDEX sessions_user_id    ON sessions (user_id);
  CREATE INDEX sessions_acting_as  ON sessions (acting_as_user_id);
  CREATE INDEX sessions_expires_at ON sessions (expires_at);

  CREATE TABLE workspaces (
    user_id          INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    container_id     TEXT,
    container_name   TEXT,
    ip               TEXT,
    status           TEXT    NOT NULL DEFAULT 'stopped'
                     CHECK (status IN ('stopped', 'starting', 'running', 'stopping', 'error')),
    started_at       INTEGER,
    stopped_at       INTEGER,
    last_activity_at INTEGER,
    stop_reason      TEXT,
    last_error       TEXT,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE login_attempts (
    username         TEXT    PRIMARY KEY,
    failures         INTEGER NOT NULL DEFAULT 0,
    first_failure_at INTEGER,
    locked_until     INTEGER
  );

  CREATE TABLE audit_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    at             INTEGER NOT NULL,
    actor_user_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    action         TEXT    NOT NULL,
    target_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    details        TEXT
  );
  CREATE INDEX audit_log_at ON audit_log (at);

  CREATE TABLE llm_usage (
    user_id           INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    day               TEXT    NOT NULL,
    requests          INTEGER NOT NULL DEFAULT 0,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  `,
  // 2: workspaces run one of several agents (AGENT_KINDS); null for rows from before the choice.
  `
  ALTER TABLE workspaces ADD COLUMN agent TEXT CHECK (agent IN ('qwen', 'dsh'));
  UPDATE workspaces SET agent = 'qwen' WHERE container_id IS NOT NULL OR started_at IS NOT NULL;
  `,
];
