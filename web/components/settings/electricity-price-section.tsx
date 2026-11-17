import { usageDay } from "@portal/core";
import { getDb } from "@/lib/db";
import { loadEnergyLocation, loadPricePeriods, priceOn, priceSummary } from "@/lib/energy";
import { gateway } from "@/lib/gateway";
import { Section } from "@/components/layout/section";
import { CardContent } from "@/components/ui/card";
import { EnergyLocationPicker } from "./energy-location-picker";

/**
 * Settings' Electricity price card (the page renders it for the admin only): where Admin > Energy's prices come
 * from, with that place's price today. When the place has no prices yet, the gateway's last download says why.
 */
export async function ElectricityPriceSection() {
  const db = getDb();
  const location = loadEnergyLocation(db);
  const price = priceOn(loadPricePeriods(db, location), usageDay(new Date()));
  let downloadError: string | null = null;
  if (location && !price) {
    downloadError = await gateway
      .energyPrices()
      .then((status) => status[location.source].error)
      .catch(() => null);
  }
  return (
    <Section id="electricity" title="Electricity price">
      <CardContent>
        <EnergyLocationPicker chosen={location?.id ?? null} summary={priceSummary(location, price, downloadError)} labelledBy="electricity-title" />
      </CardContent>
    </Section>
  );
}
