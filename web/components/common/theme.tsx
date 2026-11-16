"use client";

import { createContext, use, useSyncExternalStore, type ReactNode } from "react";
import { THEME_CANVAS, THEMES, themeClass, themeCookie, type Theme } from "@/lib/theme";

// The theme in the browser. The root layout renders <html> with the cookie's theme class; switching saves the
// cookie and swaps the class at once (every colour is a CSS variable, so nothing reloads), and the components
// that depend on the theme (the toggle, Settings, the workspace iframe's address) follow through useTheme.

const THEME_EVENT = "portal-theme-change";

/** The theme the server rendered: what useTheme answers until hydration, so the markup matches. */
const ServerTheme = createContext<Theme>("dark");

export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <ServerTheme value={theme}>{children}</ServerTheme>;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}

function documentTheme(): Theme {
  return document.documentElement.classList.contains(themeClass("light")) ? "light" : "dark";
}

export function useTheme(): Theme {
  const serverTheme = use(ServerTheme);
  return useSyncExternalStore(subscribe, documentTheme, () => serverTheme);
}

/** Switches the page to `theme` and saves it for the next visits. */
export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const each of THEMES) root.classList.toggle(themeClass(each), each === theme);
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_CANVAS[theme]);
  document.cookie = themeCookie(theme);
  window.dispatchEvent(new Event(THEME_EVENT));
}
