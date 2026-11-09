import { test } from "node:test";
import assert from "node:assert/strict";
import { generateTemporaryPassword } from "./password-generator.ts";
import { newPasswordSchema } from "./validation.ts";

test("temporary passwords are three groups of four unambiguous characters", () => {
  for (let i = 0; i < 200; i++) {
    const password = generateTemporaryPassword();
    assert.match(password, /^[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}$/);
    assert.ok(newPasswordSchema.safeParse(password).success);
  }
});

test("temporary passwords do not repeat", () => {
  const seen = new Set(Array.from({ length: 1000 }, generateTemporaryPassword));
  assert.equal(seen.size, 1000);
});
