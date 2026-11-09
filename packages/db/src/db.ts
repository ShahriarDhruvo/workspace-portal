import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";
import { MIGRATIONS } from "./migrations.ts";

export type PortalDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Applies pending migrations. Safe to call from several processes at once. */
export function migrate(client: Database.Database): void {
  const apply = client.transaction(() => {
    const current = client.pragma("user_version", { simple: true }) as number;
    for (let i = current; i < MIGRATIONS.length; i++) {
      client.exec(MIGRATIONS[i]!);
    }
    if (current < MIGRATIONS.length) {
      client.pragma(`user_version = ${MIGRATIONS.length}`);
    }
  });
  apply.immediate();
}

/**
 * The web app runs as its own service account and owns the database directory; the gateway runs as
 * root. A database file created (or left) by root would be read-only for the web app, so when this
 * process is root the files are given to the directory's owner. SQLite itself then keeps the -wal and
 * -shm files it creates as root owned the same way as the database file.
 */
function alignOwnership(file: string): void {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const dir = fs.statSync(path.dirname(file));
  if (dir.uid === 0) return;
  try {
    fs.writeFileSync(file, "", { mode: 0o600, flag: "wx" }); // an empty file is an empty database
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (const name of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const stat = fs.statSync(name);
      if (stat.uid !== dir.uid || stat.gid !== dir.gid) fs.chownSync(name, dir.uid, dir.gid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Opens (and creates, if needed) the portal database with the pragmas both services rely on. */
export function openDatabase(file: string, options: { migrate?: boolean } = {}): PortalDb {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  alignOwnership(file);
  const client = new Database(file);
  client.pragma("journal_mode = WAL");
  client.pragma("busy_timeout = 5000");
  client.pragma("foreign_keys = ON");
  client.pragma("synchronous = NORMAL");
  if (options.migrate !== false) migrate(client);
  return drizzle({ client, schema }) as PortalDb;
}

const cacheKey = Symbol.for("@portal/db.instances");
type Cache = Map<string, PortalDb>;

/** Process-wide singleton per file path (survives Next.js dev-mode module reloads). */
export function getDatabase(file: string): PortalDb {
  const g = globalThis as unknown as Record<symbol, Cache | undefined>;
  const cache = (g[cacheKey] ??= new Map());
  let db = cache.get(file);
  if (!db) {
    db = openDatabase(file);
    cache.set(file, db);
  }
  return db;
}
