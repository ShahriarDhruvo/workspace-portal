"use client";

import type { ReactNode } from "react";
import { THEMES, type Theme } from "@/lib/theme";
import { setTheme, useTheme } from "@/components/common/theme";
import { Field, FieldContent, FieldLabel, FieldTitle } from "@/components/ui/field";
import { MoonIcon, SunIcon } from "@/components/ui/icons";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

const CHOICES: Record<Theme, { label: string; icon: ReactNode }> = {
  dark: { label: "Dark", icon: <MoonIcon /> },
  light: { label: "Light", icon: <SunIcon /> },
};

/** Settings' theme choice, the same switch as the top bars' button: it applies at once and is kept in a cookie. */
export function ThemePicker() {
  const theme = useTheme();
  return (
    <RadioGroup
      value={theme}
      onValueChange={(value) => setTheme(value === "light" ? "light" : "dark")}
      aria-label="Theme"
      className="grid-cols-2"
    >
      {THEMES.map((each) => (
        <FieldLabel key={each} htmlFor={`theme-${each}`}>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>
                {CHOICES[each].icon}
                {CHOICES[each].label}
              </FieldTitle>
            </FieldContent>
            <RadioGroupItem value={each} id={`theme-${each}`} />
          </Field>
        </FieldLabel>
      ))}
    </RadioGroup>
  );
}
