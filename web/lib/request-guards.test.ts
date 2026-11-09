import { test } from "node:test";
import assert from "node:assert/strict";
import { checkApiAccess, isSameOrigin } from "./request-guards.ts";

function post(headers: Record<string, string>): Request {
  return new Request("http://portal.test/api/workspace/start", { method: "POST", headers });
}

test("isSameOrigin accepts only an Origin naming this host and port", () => {
  assert.ok(isSameOrigin(post({ host: "portal.test:3000", origin: "http://portal.test:3000" })));
  assert.ok(isSameOrigin(post({ host: "portal.test", origin: "https://portal.test" })));
  // A workspace port on the same host is same-site, so its cookies come along; it must still be refused.
  assert.ok(!isSameOrigin(post({ host: "portal.test:3000", origin: "http://portal.test:3107" })));
  assert.ok(!isSameOrigin(post({ host: "portal.test:3000", origin: "http://evil.test:3000" })));
  assert.ok(!isSameOrigin(post({ host: "portal.test:3000" })), "no Origin");
  assert.ok(!isSameOrigin(post({ host: "portal.test:3000", origin: "null" })), "opaque origin");
  assert.ok(!isSameOrigin(post({ host: "portal.test:3000", origin: "not a url" })));
  assert.ok(
    !isSameOrigin(post({ host: "portal.test:3000", origin: "http://evil.test", "x-forwarded-host": "evil.test" })),
    "X-Forwarded-Host is ignored",
  );
});

const user = { role: "user", mustChangePassword: false } as const;
const admin = { role: "admin", mustChangePassword: false } as const;

test("checkApiAccess: signed out 401, temporary password 403, admin routes for the admin only", () => {
  assert.deepEqual(checkApiAccess(null), {
    problem: { status: 401, error: "unauthorized", message: "You are signed out." },
  });

  const temporary = { user: { ...user, mustChangePassword: true } };
  const refused = checkApiAccess(temporary);
  assert.ok("problem" in refused);
  assert.equal(refused.problem.status, 403);
  assert.equal(refused.problem.error, "password_change_required");
  const adminWithTemporary = checkApiAccess({ user: { ...admin, mustChangePassword: true } }, { admin: true });
  assert.ok("problem" in adminWithTemporary && adminWithTemporary.problem.error === "password_change_required");

  const plain = { user };
  assert.deepEqual(checkApiAccess(plain), { session: plain });
  const forbidden = checkApiAccess(plain, { admin: true });
  assert.ok("problem" in forbidden);
  assert.deepEqual([forbidden.problem.status, forbidden.problem.error], [403, "forbidden"]);

  const adminSession = { user: admin };
  assert.deepEqual(checkApiAccess(adminSession, { admin: true }), { session: adminSession });
});
