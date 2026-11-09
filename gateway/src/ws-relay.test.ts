import { test } from "node:test";
import assert from "node:assert/strict";
import { relayCloseCode } from "./ws-relay.ts";

test("relayCloseCode only passes codes that may be sent", () => {
  for (const code of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 4001, 4999]) {
    assert.equal(relayCloseCode(code), code);
  }
  assert.equal(relayCloseCode(1005), 1000, "no status received");
  assert.equal(relayCloseCode(1006), 1011, "abnormal closure");
  for (const code of [0, 999, 1004, 1015, 1016, 2999, 5000]) assert.equal(relayCloseCode(code), 1011, String(code));
});
