// Portal-wide settings (portal_settings): one value per key, a missing row meaning "not set".
import { eq } from "drizzle-orm";
import type { PortalDb } from "./db.ts";
import { portalSettings, type PortalSettingKey } from "./schema.ts";

export function readSetting(db: PortalDb, key: PortalSettingKey): string | null {
  return db.select({ value: portalSettings.value }).from(portalSettings).where(eq(portalSettings.key, key)).get()?.value ?? null;
}

/** Sets the value, or removes it (null). */
export function writeSetting(db: PortalDb, key: PortalSettingKey, value: string | null, now = Date.now()): void {
  if (value === null) {
    db.delete(portalSettings).where(eq(portalSettings.key, key)).run();
    return;
  }
  db.insert(portalSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: portalSettings.key, set: { value, updatedAt: now } })
    .run();
}
