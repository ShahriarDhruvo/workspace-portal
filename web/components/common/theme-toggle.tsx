"use client";

import { Button } from "@/components/ui/button";
import { MoonIcon, SunIcon } from "@/components/ui/icons";
import { setTheme, useTheme } from "./theme";

/** The top bars' theme switch: a sun in the dark theme (to go light), a moon in the light one. */
export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Switch to the ${next} theme`} onClick={() => setTheme(next)}>
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
