import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentImageSchema,
  agentUpdateSchema,
  changePasswordSchema,
  fieldErrors,
  formText,
  loginSchema,
  newUserSchema,
  normalizeName,
  profileSchema,
  usernameSchema,
} from "./validation.ts";

const validUser = { firstName: "Ada", middleName: "", lastName: "Lovelace", username: "ada", password: "correct horse" };

test("names accept letters from any script plus spaces, hyphens, apostrophes and periods", () => {
  for (const name of ["José", "Zoë", "O'Brien", "O’Brien", "Anne-Marie", "St. John", "李", "Nguyễn", "Mary Ann", "Đặng", "Ольга"]) {
    const result = profileSchema.safeParse({ firstName: name, middleName: "", lastName: "Smith" });
    assert.ok(result.success, `${name} should be accepted`);
  }
  // Decomposed "é" (e + combining acute) is normalized to NFC.
  const decomposed = profileSchema.parse({ firstName: "José", middleName: "", lastName: "X" });
  assert.equal(decomposed.firstName, "José");
});

test("names are trimmed, collapse inner whitespace, and an empty middle name becomes null", () => {
  const parsed = profileSchema.parse({ firstName: "  Ada  ", middleName: "   ", lastName: " King   Lovelace " });
  assert.deepEqual(parsed, { firstName: "Ada", middleName: null, lastName: "King Lovelace" });
  assert.equal(normalizeName("\tA \n B "), "A B");
});

test("names reject digits, symbols, emoji, punctuation-only and over-long values", () => {
  for (const bad of ["R2D2", "a@b", "Ann😀", "...", "-", "x".repeat(51), "Bob_Smith"]) {
    const result = profileSchema.safeParse({ firstName: bad, middleName: "", lastName: "Smith" });
    assert.equal(result.success, false, `${JSON.stringify(bad)} should be rejected`);
  }
  assert.ok(profileSchema.safeParse({ firstName: "é".repeat(50), middleName: "", lastName: "S" }).success);
  const missing = profileSchema.safeParse({ firstName: "   ", middleName: "", lastName: "" });
  assert.equal(missing.success, false);
  assert.deepEqual(fieldErrors(missing.error!), { firstName: "Enter a first name.", lastName: "Enter a last name." });
  const badMiddle = profileSchema.safeParse({ firstName: "A", middleName: "4", lastName: "B" });
  assert.equal(badMiddle.success, false);
  assert.ok(fieldErrors(badMiddle.error!).middleName);
});

test("usernames are lowercased and must match ^[a-z0-9][a-z0-9._-]{2,31}$", () => {
  assert.equal(usernameSchema.parse("  Alice.B "), "alice.b");
  for (const ok of ["abc", "a_b", "a-b", "0pal", "a".repeat(32)]) assert.ok(usernameSchema.safeParse(ok).success, ok);
  for (const bad of ["ab", "_abc", ".abc", "a b", "a".repeat(33), "ålice", "a/b", ""]) {
    assert.equal(usernameSchema.safeParse(bad).success, false, bad);
  }
});

test("new users need a password of at least 8 characters", () => {
  assert.ok(newUserSchema.safeParse(validUser).success);
  const short = newUserSchema.safeParse({ ...validUser, password: "1234567" });
  assert.equal(short.success, false);
  assert.equal(fieldErrors(short.error!).password, "Use at least 8 characters.");
  assert.ok(newUserSchema.safeParse({ ...validUser, password: "12345678" }).success);
});

test("change password requires a matching confirmation and a different password", () => {
  const ok = changePasswordSchema.safeParse({ currentPassword: "old-pass", newPassword: "new-pass-1", confirmPassword: "new-pass-1" });
  assert.ok(ok.success);
  const mismatch = changePasswordSchema.safeParse({ currentPassword: "old-pass", newPassword: "new-pass-1", confirmPassword: "new-pass-2" });
  assert.equal(fieldErrors(mismatch.error!).confirmPassword, "The passwords don't match.");
  const same = changePasswordSchema.safeParse({ currentPassword: "same-pass", newPassword: "same-pass", confirmPassword: "same-pass" });
  assert.ok(fieldErrors(same.error!).newPassword);
});

test("login input is normalized and bounded", () => {
  assert.deepEqual(loginSchema.parse({ username: " Admin ", password: "x" }), { username: "admin", password: "x" });
  assert.equal(loginSchema.safeParse({ username: "", password: "x" }).success, false);
  assert.equal(loginSchema.safeParse({ username: "a", password: "" }).success, false);
});

test("formText reads strings and maps missing fields to empty strings", () => {
  const data = new FormData();
  data.set("firstName", "Ada");
  data.set("file", new Blob(["x"]));
  assert.deepEqual(formText(data, ["firstName", "middleName", "file"]), { firstName: "Ada", middleName: "", file: "" });
});

test("agent updates take an exact version, never a release channel, and the rebuild checkbox", () => {
  assert.deepEqual(agentUpdateSchema.parse({ agent: "qwen", version: " 0.27.4 ", rebuild: "" }), {
    agent: "qwen",
    version: "0.27.4",
    rebuild: false,
  });
  assert.deepEqual(agentUpdateSchema.parse({ agent: "dsh", version: "0.2.2-rc.3", rebuild: "on" }), {
    agent: "dsh",
    version: "0.2.2-rc.3",
    rebuild: true,
  });
  // A channel would be resolved again by the gateway, maybe to a newer version than the one confirmed.
  const channel = agentUpdateSchema.safeParse({ agent: "dsh", version: "next", rebuild: "" });
  assert.equal(channel.success, false);
  assert.deepEqual(fieldErrors(channel.error!), { version: "Enter a version like 0.27.4." });
  // Every bad version, an empty one included, gets the same message.
  for (const version of ["", "  ", "0.27", "v0.27.4", "0.27.4 && reboot", "latest", `0.27.4-${"a".repeat(100)}`]) {
    const parsed = agentUpdateSchema.safeParse({ agent: "qwen", version, rebuild: "" });
    assert.equal(parsed.success, false, JSON.stringify(version));
    assert.deepEqual(fieldErrors(parsed.error!), { version: "Enter a version like 0.27.4." }, JSON.stringify(version));
  }
  const unknown = agentUpdateSchema.safeParse({ agent: "claude", version: "0.27.4", rebuild: "" });
  assert.equal(unknown.success, false);
  assert.deepEqual(fieldErrors(unknown.error!), { agent: "Unknown agent." });
});

test("agent images are named by exact versions only", () => {
  assert.deepEqual(agentImageSchema.parse({ agent: "qwen", version: "0.26.0" }), { agent: "qwen", version: "0.26.0" });
  for (const version of ["", "latest", "0.26.0;rm", "../0.26.0", `0.26.0-${"a".repeat(100)}`]) {
    const parsed = agentImageSchema.safeParse({ agent: "qwen", version });
    assert.equal(parsed.success, false, version);
    assert.deepEqual(fieldErrors(parsed.error!), { version: "Enter a version like 0.27.4." }, version);
  }
});
