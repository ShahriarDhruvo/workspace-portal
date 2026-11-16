"use client";

import { setTheme, useTheme } from "@/components/common/theme";
import { MoonIcon, SunIcon } from "@/components/ui/icons";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** The chosen item stands out, filled and in full contrast; the other's label is muted and only lights up on hover. */
const ITEM = "data-[state=off]:text-muted-foreground data-[state=off]:hover:bg-transparent data-[state=off]:hover:text-foreground";

/**
 * Settings' theme choice, a two-way switch: the same as the top bar's button, it applies at once and is kept in a
 * cookie. `labelledBy` names it after its visible label.
 */
export function ThemePicker({ labelledBy }: { labelledBy: string }) {
  const theme = useTheme();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={0}
      value={theme}
      // A press on the theme already chosen would clear the choice: there is always one.
      onValueChange={(value) => {
        if (value === "dark" || value === "light") setTheme(value);
      }}
      aria-labelledby={labelledBy}
    >
      <ToggleGroupItem value="dark" className={ITEM}>
        <MoonIcon />
        Dark
      </ToggleGroupItem>
      <ToggleGroupItem value="light" className={ITEM}>
        <SunIcon />
        Light
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
