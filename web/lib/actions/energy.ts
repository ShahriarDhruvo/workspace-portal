"use server";

import { refresh } from "next/cache";
import { energyLocation } from "@portal/db";
import { getDb } from "../db";
import { loadPricePeriods, saveEnergyLocation } from "../energy";
import { gateway } from "../gateway";
import { requireAdmin } from "../session";

// Settings > Electricity price (admin only): the place whose published prices Admin > Energy prices energy at.
// Re-checks the admin role, accepts only a known place, and is audited (energy_price_location_set).

export type EnergyLocationResult = { ok: true } | { ok: false; message: string };

/**
 * Makes `location` (an energy-locations.ts id) the place prices come from. When none of its prices are stored yet
 * (a first pick before the gateway's first download got through), asks the gateway to download them now; a failed
 * download leaves the place picked, and Settings says the prices are not downloaded yet.
 */
export async function setEnergyLocation(location: string): Promise<EnergyLocationResult> {
  const session = await requireAdmin();
  const place = energyLocation(location);
  if (!place) return { ok: false, message: "There is no such place." };
  const db = getDb();
  saveEnergyLocation(db, place, session.user.id);
  if (loadPricePeriods(db, place).length === 0) await gateway.refreshEnergyPrices().catch(() => undefined);
  refresh();
  return { ok: true };
}
