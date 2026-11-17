import "server-only";
import { getDatabase, type PortalDb } from "@portal/core";
import { config } from "./config";

/** The shared portal database (opened, and migrated, on first use). */
export function getDb(): PortalDb {
  return getDatabase(config.dbFile);
}
