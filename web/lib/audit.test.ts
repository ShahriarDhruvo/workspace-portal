import { test } from "node:test";
import assert from "node:assert/strict";
import { auditActionLabel, auditActorFallback, auditDetailsSubject, formatAuditDetails } from "./audit.ts";

test("action labels", () => {
  assert.equal(auditActionLabel("login_failed", false), "Failed sign-in");
  assert.equal(auditActionLabel("workspace_stopped", true), "Stopped workspace");
  assert.equal(auditActionLabel("workspace_stopped", false), "Workspace stopped");
  assert.equal(auditActionLabel("some_future_action", false), "Some future action");
  assert.equal(auditActorFallback("login_failed"), "—");
  assert.equal(auditActorFallback("workspace_stopped"), "System");
  assert.equal(auditActorFallback("login"), "Deleted user");
  assert.equal(auditActorFallback("password_changed"), "Deleted user");
});

test("details are rendered as readable key/value pairs", () => {
  assert.equal(formatAuditDetails(null), "");
  assert.equal(formatAuditDetails('{"username":"bob","reason":"wrong_password"}'), "Username: bob · Reason: wrong password");
  assert.equal(formatAuditDetails('{"firstName":{"from":"Bob","to":"Rob"}}'), "First name: Bob → Rob");
  assert.equal(formatAuditDetails("not json"), "not json");
});

test("subject of a deleted user comes from details", () => {
  assert.equal(auditDetailsSubject('{"username":"bob","name":"Bob Smith"}'), "Bob Smith");
  assert.equal(auditDetailsSubject('{"username":"bob"}'), "bob");
  assert.equal(auditDetailsSubject("{}"), null);
});
