import { test } from "node:test";
import assert from "node:assert/strict";
import { THEME_CANVAS, parseTheme, themeBootStyle, themeClass, themeCookie } from "./theme.ts";

test("parseTheme: only 'light' is light; a missing or unknown cookie value is the default, dark", () => {
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("dark"), "dark");
  for (const value of [undefined, null, "", "Light", "LIGHT", " light", "system", "light; x=1"]) {
    assert.equal(parseTheme(value), "dark", String(value));
  }
});

test("themeCookie saves the theme for a year on every path, SameSite=Lax", () => {
  assert.equal(themeCookie("light"), "portal_theme=light; Path=/; Max-Age=31536000; SameSite=Lax");
  assert.equal(themeCookie("dark"), "portal_theme=dark; Path=/; Max-Age=31536000; SameSite=Lax");
});

test("the html class and the pre-paint style follow the theme", () => {
  assert.equal(themeClass("dark"), "theme-dark");
  assert.equal(themeClass("light"), "theme-light");
  assert.equal(themeBootStyle("dark"), `html{background:${THEME_CANVAS.dark};color-scheme:dark}`);
  assert.equal(themeBootStyle("light"), "html{background:#ffffff;color-scheme:light}");
});
