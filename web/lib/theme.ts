// The portal's colour theme: dark (the default, as in the Qwen Code Web Shell) or light, kept in a cookie so the
// server renders the right one and the page never flashes the other. Pure; unit tested.

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = "portal_theme";
const THEME_COOKIE_MAX_AGE = 365 * 24 * 3600;

/** The canvas of each theme (--canvas in app/theme.css): <meta name="theme-color"> and the pre-paint background. */
export const THEME_CANVAS: Readonly<Record<Theme, string>> = { dark: "#0d0d0d", light: "#ffffff" };

/** The cookie's value as a theme: anything but "light" (missing, garbled, from an older version) is dark. */
export function parseTheme(value: string | null | undefined): Theme {
  return value === "light" ? "light" : "dark";
}

/** The class <html> carries for a theme; app/theme.css and the `dark:` variant key off it. */
export function themeClass(theme: Theme): string {
  return `theme-${theme}`;
}

/** document.cookie assignment that saves the choice for a year, for every page of the portal. */
export function themeCookie(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/**
 * Painted before any stylesheet loads, so a page never shows a flash of the wrong canvas: the html background
 * and colour scheme of the theme.
 */
export function themeBootStyle(theme: Theme): string {
  return `html{background:${THEME_CANVAS[theme]};color-scheme:${theme}}`;
}
