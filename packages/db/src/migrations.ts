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
  // 3: each user picks the agent their workspace starts with (Settings); null = the install's default, the first
  // agent of WORKSPACE_AGENTS. Existing users keep the agent their workspace ran last.
  `
  ALTER TABLE users ADD COLUMN agent TEXT CHECK (agent IN ('qwen', 'dsh'));
  UPDATE users SET agent = (SELECT agent FROM workspaces WHERE workspaces.user_id = users.id);
  `,
  // 4: each server's energy and network totals per local day (the gateway's energy meter), the meter's last
  // reading, and the electricity price over time (Admin > Usage).
  `
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

  CREATE TABLE energy_rates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    effective_from TEXT    NOT NULL UNIQUE CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    cents_per_kwh  REAL    NOT NULL CHECK (cents_per_kwh >= 0),
    note           TEXT,
    created_at     INTEGER NOT NULL
  );

  -- Tampa Electric (TECO) residential service, first 1,000 kWh a month: every per-kWh charge (energy, fuel,
  -- capacity, conservation, environmental, storm protection, clean energy transition, storm surcharge) plus the
  -- 2.5641% gross receipts tax; the daily basic service charge is left out. From TECO's rate notices and the
  -- Florida PSC's orders, each from the first billing cycle of its month.
  INSERT INTO energy_rates (effective_from, cents_per_kwh, note, created_at) VALUES
    ('2024-01-01', 12.163, 'TECO residential, first 1,000 kWh, with gross receipts tax', 0),
    ('2024-06-01', 11.459, 'TECO residential, first 1,000 kWh, with gross receipts tax (fuel cut)', 0),
    ('2025-01-01', 13.235, 'TECO residential, first 1,000 kWh, with gross receipts tax', 0),
    ('2025-03-01', 15.281, 'TECO residential, first 1,000 kWh, with gross receipts tax (storm surcharge)', 0),
    ('2025-06-01', 15.478, 'TECO residential, first 1,000 kWh, with gross receipts tax (fuel credit ended)', 0),
    ('2026-01-01', 16.305, 'TECO residential, first 1,000 kWh, with gross receipts tax', 0),
    ('2026-08-01', 14.258, 'TECO residential, first 1,000 kWh, with gross receipts tax (storm surcharge ended)', 0);
  `,
  // 5: every user has a Private and an Online workspace (WORKSPACE_KINDS), one running at a time. The workspace row
  // keeps the kind of its current or last container; existing rows are the Private one. The admin can bar a user
  // from Online.
  `
  ALTER TABLE users ADD COLUMN online_allowed INTEGER NOT NULL DEFAULT 1 CHECK (online_allowed IN (0, 1));
  ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'private' CHECK (kind IN ('private', 'online'));
  `,
  // 6: electricity prices come from public sources (energy-locations.ts) for a place the admin picks, instead of
  // the hand-kept list of migration 4, which goes. The gateway fills energy_prices; the place is a portal setting,
  // unset until the admin picks one. Audit entries of the old price changes stay as they were.
  `
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

  DROP TABLE energy_rates;
  `,
];
