// What an API key used, on a day or over a stretch, and how to add it up. Without server imports: the API page's
// components add up what lib/api-keys.ts loaded.
import { sumKnown } from "./live-format.ts";

export interface KeyUse {
  /** Requests that reached the LLM server, and those of them it failed. */
  requests: number;
  failed: number;
  tokensIn: number;
  tokensOut: number;
  /** Its share of the LLM server's measured energy; null when none was measured. */
  energyWh: number | null;
  /** That energy at each day's price; null without energy, a place or a price. */
  cost: number | null;
  /** A price stands in for a month not yet published. */
  costEstimate: boolean;
}

export function sumUse(uses: readonly KeyUse[]): KeyUse {
  const sum = (pick: (use: KeyUse) => number | null): number | null => sumKnown(uses.map(pick));
  return {
    requests: sum((use) => use.requests) ?? 0,
    failed: sum((use) => use.failed) ?? 0,
    tokensIn: sum((use) => use.tokensIn) ?? 0,
    tokensOut: sum((use) => use.tokensOut) ?? 0,
    energyWh: sum((use) => use.energyWh),
    cost: sum((use) => use.cost),
    costEstimate: uses.some((use) => use.costEstimate),
  };
}
