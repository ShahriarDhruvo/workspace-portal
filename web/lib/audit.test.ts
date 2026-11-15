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

test("an admin leaving a workspace shows why: switched to another user, or signed out", () => {
  assert.equal(auditActionLabel("admin_exited_workspace", true), "Left workspace");
  assert.equal(formatAuditDetails(JSON.stringify({ reason: "switched" })), "Reason: switched");
  assert.equal(formatAuditDetails(JSON.stringify({ reason: "signed_out" })), "Reason: signed out");
  assert.equal(formatAuditDetails(null), "", "a plain Exit has no details");
});

test("agent updates and image removals name the agent and versions", () => {
  assert.equal(auditActionLabel("agent_updated", true), "Agent updated");
  assert.equal(
    formatAuditDetails(JSON.stringify({ agent: "qwen", from: "0.27.0", to: "0.27.4", rebuild: false })),
    "Agent: Qwen Code · From: 0.27.0 · To: 0.27.4 · From scratch: no",
  );
  assert.equal(
    formatAuditDetails(JSON.stringify({ agent: "dsh", version: "0.2.2-rc.3", error: "Cancelled" })),
    "Agent: DeepSeek Harness · Version: 0.2.2-rc.3 · Error: Cancelled",
  );
  assert.equal(formatAuditDetails(JSON.stringify({ agent: "dsh", version: "0.2.1" })), "Agent: DeepSeek Harness · Version: 0.2.1");
  assert.equal(formatAuditDetails(JSON.stringify({ agent: "claude" })), "Agent: claude", "an unknown agent as it is");
  assert.equal(
    formatAuditDetails(JSON.stringify({ error: 'lockdown.patch.yml does not fit dsh "$DSH_VERSION"' })),
    'Error: lockdown.patch.yml does not fit dsh "$DSH_VERSION"',
    "free text keeps its underscores",
  );
});
