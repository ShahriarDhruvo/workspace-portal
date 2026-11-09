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
 * Opens a database file so its owner can be changed through the descriptor (fchown), or returns null
 * when it doesn't exist. The caller closes the descriptor.
 *
 * The directory belongs to the web app's account, so whoever controls that account can put anything
 * at these names, such as a symlink to /var/run/docker.sock or a hard link to a root-owned file, for
 * the root gateway to chown. So the last path component is never followed (O_NOFOLLOW), and the
 * opened file must be a regular file with a single link; anything else is refused with an error.
 * O_NONBLOCK keeps a planted FIFO from blocking the open; O_NOCTTY keeps a tty from becoming ours.
 */
export function openForOwnershipChange(name: string): number | null {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_NOCTTY } = fs.constants;
  let fd: number;
  try {
    fd = fs.openSync(name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error(`Refusing to change the owner of ${name}: it is a symbolic link.`);
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Refusing to change the owner of ${name}: it is not a regular file.`);
    if (stat.nlink !== 1) {
      throw new Error(`Refusing to change the owner of ${name}: it has ${stat.nlink} hard links, expected 1.`);
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
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
    // O_CREAT | O_EXCL: fails on anything already at the name, a symlink included, without following it.
    fs.writeFileSync(file, "", { mode: 0o600, flag: "wx" }); // an empty file is an empty database
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (const name of [file, `${file}-wal`, `${file}-shm`]) {
    const fd = openForOwnershipChange(name);
    if (fd === null) continue;
    try {
      const stat = fs.fstatSync(fd);
      if (stat.uid !== dir.uid || stat.gid !== dir.gid) fs.fchownSync(fd, dir.uid, dir.gid);
    } finally {
      fs.closeSync(fd);
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
