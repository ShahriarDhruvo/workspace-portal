import assert from "node:assert/strict";
import test from "node:test";
import { cn } from "./utils.ts";

test("cn keeps a custom font size next to a text colour", () => {
  assert.equal(cn("text-13 text-muted-foreground"), "text-13 text-muted-foreground");
  assert.equal(cn("text-12 text-subtle-foreground", "text-danger"), "text-12 text-danger");
});

test("cn lets the later class win within the custom scale and the theme colours", () => {
  assert.equal(cn("text-16 font-medium", "text-24"), "font-medium text-24");
  assert.equal(cn("text-muted-foreground", "text-foreground"), "text-foreground");
  assert.equal(cn("border border-transparent", "border-input"), "border border-input");
  assert.equal(cn("bg-input/30 hover:bg-input/50", "bg-primary"), "hover:bg-input/50 bg-primary");
});

test("cn drops a line height that a later font size resets, but keeps one set after it", () => {
  assert.equal(cn("leading-snug", "text-24"), "text-24");
  assert.equal(cn("text-14 leading-snug"), "text-14 leading-snug");
});

test("cn joins conditional classes and skips falsy ones", () => {
  assert.equal(cn("h-8", false && "hidden", undefined, null, ["px-2.5", { "font-mono": true, italic: false }]), "h-8 px-2.5 font-mono");
});
