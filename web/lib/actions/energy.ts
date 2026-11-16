"use server";

import { getDb } from "../db";
import { energyPriceSchema, saveEnergyPrice } from "../energy";
import { requireAdmin } from "../session";
import { fieldErrors, formText, type FieldErrors } from "../validation";

// Admin > Usage: the electricity price the energy card prices each day at. Re-checks the admin role, validates
// its input with zod, and is audited (energy_rate_set), like the other admin actions.

const FIELDS = ["effectiveFrom", "centsPerKwh", "note"] as const;
type PriceValues = Record<(typeof FIELDS)[number], string>;

export type EnergyPriceState =
  | { status: "idle" }
  | { status: "invalid"; fieldErrors: FieldErrors; values: PriceValues }
  | { status: "saved"; at: number };

/** Sets the price in force from a day on; a price that starts that same day is replaced. */
export async function setEnergyPrice(_previous: EnergyPriceState, formData: FormData): Promise<EnergyPriceState> {
  const session = await requireAdmin();
  const values = formText(formData, FIELDS);
  const parsed = energyPriceSchema.safeParse(values);
  if (!parsed.success) return { status: "invalid", fieldErrors: fieldErrors(parsed.error), values };
  saveEnergyPrice(getDb(), parsed.data, session.user.id);
  return { status: "saved", at: Date.now() };
}
