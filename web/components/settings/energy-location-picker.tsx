"use client";

import { useOptimistic, useState, useTransition } from "react";
import { ENERGY_LOCATIONS, ENERGY_REGION_NAMES, type EnergyRegion } from "@portal/core/wire";
import { setEnergyLocation } from "@/lib/actions/energy";
import { FormError } from "@/components/forms/form-error";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

const REGIONS: EnergyRegion[] = ["us", "europe"];

interface EnergyLocationPickerProps {
  /** The place picked now; null before the admin's first pick. */
  chosen: string | null;
  /** The place's current price ("14.99 ¢/kWh · August 2026 · EIA"), or why there is none yet. */
  summary: string | null;
  /** The id of the visible title that names the choice. */
  labelledBy: string;
}

/**
 * Settings' electricity price place (admin only): the US states and Eurostat's countries, grouped, saved as soon as
 * one is picked; under it the place's current price. The page re-renders with the new place's price once saved.
 */
export function EnergyLocationPicker({ chosen, summary, labelledBy }: EnergyLocationPickerProps) {
  const [value, setValue] = useOptimistic(chosen);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function choose(next: string) {
    setError(null);
    startSaving(async () => {
      setValue(next);
      const result = await setEnergyLocation(next);
      if (!result.ok) setError(result.message);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Select value={value ?? undefined} onValueChange={choose} disabled={saving}>
          <SelectTrigger aria-labelledby={labelledBy} aria-busy={saving || undefined} className="w-full sm:w-72">
            <SelectValue placeholder="Choose a location" />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-80">
            {REGIONS.map((region) => (
              <SelectGroup key={region}>
                <SelectLabel>{ENERGY_REGION_NAMES[region]}</SelectLabel>
                {ENERGY_LOCATIONS.filter((location) => location.region === region).map((location) => (
                  <SelectItem key={location.id} value={location.id}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        {saving ? <Spinner aria-hidden="true" className="text-muted-foreground" /> : null}
      </div>
      {summary && !saving ? <p className="text-13 text-muted-foreground tabular-nums">{summary}</p> : null}
      {error ? <FormError>{error}</FormError> : null}
    </div>
  );
}
