// The places Admin > Energy can price electricity for, and where each one's price comes from. The gateway downloads
// every place's published prices (gateway/src/energy-prices.ts) into energy_prices; the admin picks one in
// Settings (portal_settings.energy_price_location). Both sources publish without an account or key.
//   * United States: EIA's average price to residential customers in the state, per month (Electric Power
//     Monthly, Table 5.6.A), about two months after the month. EIA writes cents per kWh.
//   * Europe: Eurostat's household price with all taxes, consumption band 2,500-4,999 kWh a year, per half year
//     (nrg_pc_204), in euros per kWh. Eurostat's codes, so Greece is EL and Kosovo XK; some of its countries are
//     not in the EU.
// No imports: the web app's client components load this file on its own (@portal/db/energy-locations), as the
// package's main entry brings SQLite with it.

export const ENERGY_PRICE_SOURCES = ["eia", "eurostat"] as const;
export type EnergyPriceSource = (typeof ENERGY_PRICE_SOURCES)[number];

export const ENERGY_CURRENCIES = ["USD", "EUR"] as const;
export type EnergyCurrency = (typeof ENERGY_CURRENCIES)[number];

export type EnergyRegion = "us" | "europe";

export interface EnergyLocation {
  /** "US-FL", "EU-DE": the region and the source's own code. */
  id: string;
  region: EnergyRegion;
  /** The source's code: a US state's postal code, Eurostat's country code. */
  code: string;
  /** As the source writes it (EIA's row label for a state). */
  name: string;
  source: EnergyPriceSource;
  currency: EnergyCurrency;
}

export const ENERGY_REGION_NAMES: Readonly<Record<EnergyRegion, string>> = { us: "United States", europe: "Europe" };

export const ENERGY_SOURCE_NAMES: Readonly<Record<EnergyPriceSource, string>> = { eia: "EIA", eurostat: "Eurostat" };

// The 50 states and DC, by postal code, named as EIA's table names them.
const US_STATES: ReadonlyArray<readonly [string, string]> = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"],
  ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"],
  ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"],
  ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"],
  ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
];

// Eurostat's countries with household prices in recent years (not its EU and euro-area totals; the United
// Kingdom stopped in 2019 and Ukraine has none lately).
const EUROPE: ReadonlyArray<readonly [string, string]> = [
  ["AL", "Albania"], ["AT", "Austria"], ["BE", "Belgium"], ["BA", "Bosnia and Herzegovina"], ["BG", "Bulgaria"],
  ["HR", "Croatia"], ["CY", "Cyprus"], ["CZ", "Czechia"], ["DK", "Denmark"], ["EE", "Estonia"],
  ["FI", "Finland"], ["FR", "France"], ["GE", "Georgia"], ["DE", "Germany"], ["EL", "Greece"],
  ["HU", "Hungary"], ["IS", "Iceland"], ["IE", "Ireland"], ["IT", "Italy"], ["XK", "Kosovo"],
  ["LV", "Latvia"], ["LI", "Liechtenstein"], ["LT", "Lithuania"], ["LU", "Luxembourg"], ["MT", "Malta"],
  ["MD", "Moldova"], ["ME", "Montenegro"], ["NL", "Netherlands"], ["MK", "North Macedonia"], ["NO", "Norway"],
  ["PL", "Poland"], ["PT", "Portugal"], ["RO", "Romania"], ["RS", "Serbia"], ["SK", "Slovakia"],
  ["SI", "Slovenia"], ["ES", "Spain"], ["SE", "Sweden"], ["TR", "Türkiye"],
];

/** Every place, United States then Europe, each A to Z by name. */
export const ENERGY_LOCATIONS: readonly EnergyLocation[] = [
  ...[...US_STATES]
    .sort(([, a], [, b]) => a.localeCompare(b, "en"))
    .map(([code, name]): EnergyLocation => ({ id: `US-${code}`, region: "us", code, name, source: "eia", currency: "USD" })),
  ...[...EUROPE]
    .sort(([, a], [, b]) => a.localeCompare(b, "en"))
    .map(([code, name]): EnergyLocation => ({ id: `EU-${code}`, region: "europe", code, name, source: "eurostat", currency: "EUR" })),
];

const BY_ID = new Map(ENERGY_LOCATIONS.map((location) => [location.id, location]));

export function energyLocation(id: string | null | undefined): EnergyLocation | null {
  return (id && BY_ID.get(id)) || null;
}

export function isEnergyLocationId(value: unknown): value is string {
  return typeof value === "string" && BY_ID.has(value);
}

/** "Florida, US" and "Georgia, US" against "Georgia": a name that also says which region (audit entries). */
export function energyLocationLabel(location: EnergyLocation): string {
  return location.region === "us" ? `${location.name}, US` : location.name;
}
