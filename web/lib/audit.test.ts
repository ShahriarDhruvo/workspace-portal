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

test("a harness change names the agents; a first choice comes from nothing", () => {
  assert.equal(auditActionLabel("agent_preference_changed", true), "Changed harness");
  assert.equal(formatAuditDetails(JSON.stringify({ from: "qwen", to: "dsh" })), "From: Qwen Code · To: DeepSeek Harness");
  assert.equal(formatAuditDetails(JSON.stringify({ from: null, to: "qwen" })), "From: — · To: Qwen Code");
});

test("LLM engine updates, failures and image removals", () => {
  assert.equal(auditActionLabel("engine_updated", true), "LLM engine updated");
  assert.equal(auditActionLabel("engine_update_failed", false), "LLM engine update failed");
  assert.equal(auditActionLabel("engine_update_failed", true, '{"from":"0.31.0","to":"0.34.0","error":"Cancelled.","rolledBack":false}'), "LLM engine update cancelled");
  assert.equal(auditActionLabel("agent_update_failed", true, '{"agent":"qwen","error":"Cancelled"}'), "Agent update cancelled");
  assert.equal(auditActionLabel("agent_update_failed", true, '{"agent":"qwen","error":"Cancelled by a restart"}'), "Agent update failed");
  assert.equal(auditActionLabel("engine_image_removed", true), "LLM engine image removed");
  assert.equal(
    formatAuditDetails(JSON.stringify({ from: "0.34.0", to: "0.31.0" })),
    "From: 0.34.0 · To: 0.31.0",
  );
  assert.equal(
    formatAuditDetails(JSON.stringify({ version: "0.34.0", error: "Not ready after 120 s", rolledBack: true })),
    "Version: 0.34.0 · Error: Not ready after 120 s · Rolled back: yes",
  );
  assert.equal(
    formatAuditDetails(JSON.stringify({ version: "0.31.0", digest: "sha256:9a6e" })),
    "Version: 0.31.0 · Digest: sha256:9a6e",
  );
});

test("workspace kinds and the Online permission read as words", () => {
  assert.equal(auditActionLabel("workspace_files_erased", true), "Erased workspace files");
  assert.equal(auditActionLabel("user_online_access_changed", true), "Changed Online access");
  assert.equal(formatAuditDetails(JSON.stringify({ kind: "online", agent: "qwen" })), "Type: Online · Agent: Qwen Code");
  assert.equal(formatAuditDetails(JSON.stringify({ kind: "private" })), "Type: Private");
  assert.equal(formatAuditDetails(JSON.stringify({ kind: "rollback" })), "Type: rollback", "a kind that names no workspace, as it is");
  assert.equal(formatAuditDetails(JSON.stringify({ allowed: false })), "Allowed: no");
  assert.equal(formatAuditDetails(JSON.stringify({ username: "bob", onlineAllowed: true })), "Username: bob · Online workspace: yes");
});

test("electricity prices: the place by name", () => {
  assert.equal(auditActionLabel("energy_price_location_set", true), "Changed electricity price location");
  assert.equal(formatAuditDetails(JSON.stringify({ location: { from: null, to: "Florida, US" } })), "Location: — → Florida, US");
  assert.equal(formatAuditDetails(JSON.stringify({ location: { from: "Florida, US", to: "Germany" } })), "Location: Florida, US → Germany");
  assert.equal(formatAuditDetails('{"someKey":1}'), "Some key: 1", "a key without a label");
});
