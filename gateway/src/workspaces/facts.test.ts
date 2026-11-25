import { test } from "node:test";
import assert from "node:assert/strict";
import { users, writeSetting } from "@portal/core";
import { tempDb } from "../../test/fakes.ts";
import { workspaceFacts } from "./facts.ts";

test("a workspace's facts are the person's full name and the place the admin picked", () => {
  const db = tempDb();
  const userId = db.insert(users).values({ username: "ana", firstName: "Ana", middleName: "de", lastName: "Lima", passwordHash: "x", createdAt: 1, updatedAt: 1 }).returning().get().id;
  assert.deepEqual(workspaceFacts(db, userId, "online"), { kind: "online", person: "Ana de Lima", place: null });
  writeSetting(db, "energy_price_location", "US-FL");
  assert.deepEqual(workspaceFacts(db, userId, "private"), { kind: "private", person: "Ana de Lima", place: "Florida, US" });
  writeSetting(db, "energy_price_location", "EU-DE");
  assert.equal(workspaceFacts(db, userId, "private").place, "Germany");
  assert.throws(() => workspaceFacts(db, userId + 1, "private"), /^Error: user \d+ does not exist$/);
});
