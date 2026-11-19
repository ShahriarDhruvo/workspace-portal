// Append-only: never edit a shipped migration, add one. migrate() applies them by PRAGMA user_version.
// Keep schema.ts in step.
export const MIGRATIONS: readonly string[] = [
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
    last_login_at        INTEGER,
    agent                TEXT    CHECK (agent IN ('qwen', 'dsh')),
    online_allowed       INTEGER NOT NULL DEFAULT 1 CHECK (online_allowed IN (0, 1))
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
    updated_at       INTEGER NOT NULL,
    agent            TEXT    CHECK (agent IN ('qwen', 'dsh')),
    kind             TEXT    NOT NULL DEFAULT 'private' CHECK (kind IN ('private', 'online'))
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

  CREATE TABLE host_daily (
    day        TEXT    NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    role       TEXT    NOT NULL CHECK (role IN ('portal', 'llm')),
    energy_wh  REAL,
    rx_bytes   INTEGER NOT NULL DEFAULT 0,
    tx_bytes   INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (day, role)
  );

  CREATE TABLE host_meter (
    role     TEXT    PRIMARY KEY CHECK (role IN ('portal', 'llm')),
    instance TEXT    NOT NULL,
    at       INTEGER NOT NULL,
    energy_j REAL,
    rx_bytes INTEGER,
    tx_bytes INTEGER
  );

  CREATE TABLE energy_prices (
    location     TEXT    NOT NULL CHECK (location GLOB '[A-Z][A-Z]-[A-Z][A-Z]'),
    period_start TEXT    NOT NULL CHECK (period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-01'),
    period_end   TEXT    NOT NULL CHECK (period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-01' AND period_end > period_start),
    period       TEXT    NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR period GLOB '[0-9][0-9][0-9][0-9]-S[12]'),
    price        REAL    NOT NULL CHECK (price > 0),
    currency     TEXT    NOT NULL CHECK (currency IN ('USD', 'EUR')),
    source       TEXT    NOT NULL CHECK (source IN ('eia', 'eurostat')),
    fetched_at   INTEGER NOT NULL,
    PRIMARY KEY (location, period_start)
  );

  CREATE TABLE portal_settings (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE workspace_sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL CHECK (kind IN ('private', 'online')),
    agent         TEXT    CHECK (agent IN ('qwen', 'dsh')),
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    requests      INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    read_tokens   INTEGER NOT NULL DEFAULT 0,
    read_ms       REAL    NOT NULL DEFAULT 0,
    write_tokens  INTEGER NOT NULL DEFAULT 0,
    write_ms      REAL    NOT NULL DEFAULT 0,
    llm_ms        INTEGER NOT NULL DEFAULT 0,
    energy_j      REAL,
    energy_ms     INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX workspace_sessions_open ON workspace_sessions (user_id) WHERE ended_at IS NULL;
  CREATE INDEX workspace_sessions_order ON workspace_sessions (ended_at, started_at);
  `,
  `
  CREATE TABLE api_keys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    token_hash TEXT    NOT NULL UNIQUE,
    hint       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );

  CREATE TABLE api_key_usage (
    key_id        INTEGER NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
    day           TEXT    NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    requests      INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    energy_j      REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (key_id, day)
  );
  `,
];
