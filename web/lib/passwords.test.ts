import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "./passwords.ts";

test("hashes are argon2id and verify only the right password", async () => {
  const stored = await hashPassword("s3cret-pass");
  assert.match(stored, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await verifyPassword(stored, "s3cret-pass"), true);
  assert.equal(await verifyPassword(stored, "wrong-pass"), false);
});

test("unknown users (no stored hash) never verify, and malformed hashes fail closed", async () => {
  assert.equal(await verifyPassword(null, "anything"), false);
  assert.equal(await verifyPassword("not-a-hash", "anything"), false);
});
