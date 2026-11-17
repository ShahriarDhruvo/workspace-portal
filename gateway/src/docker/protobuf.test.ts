import { test } from "node:test";
import assert from "node:assert/strict";
import { ProtobufError, readFields, readVarint } from "./protobuf.ts";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

test("readVarint reads base-128 varints up to 64 bits", () => {
  assert.deepEqual(readVarint(bytes(0x00), 0), { value: 0n, next: 1 });
  assert.deepEqual(readVarint(bytes(0x7f), 0), { value: 127n, next: 1 });
  assert.deepEqual(readVarint(bytes(0x80, 0x01), 0), { value: 128n, next: 2 });
  assert.deepEqual(readVarint(bytes(0xac, 0x02), 0), { value: 300n, next: 2 });
  assert.deepEqual(readVarint(bytes(0xff, 0x08, 0x96, 0x01), 2), { value: 150n, next: 4 }, "from an offset");
  const max = bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01);
  assert.deepEqual(readVarint(max, 0), { value: 2n ** 64n - 1n, next: 10 });
  assert.throws(() => readVarint(bytes(0x80, 0x80), 0), ProtobufError, "truncated");
  assert.throws(() => readVarint(new Uint8Array(11).fill(0x80), 0), ProtobufError, "too long");
});

test("readFields yields varint and length-delimited fields in wire order, skipping fixed-width ones", () => {
  // 1: varint 150, 2: "hi", 3: fixed64, 4: fixed32, 2: "" (repeated), 5: nested { 1: 1 }
  const message = bytes(0x08, 0x96, 0x01, 0x12, 0x02, 0x68, 0x69, 0x19, 1, 2, 3, 4, 5, 6, 7, 8, 0x25, 1, 2, 3, 4, 0x12, 0x00, 0x2a, 0x02, 0x08, 0x01);
  const fields = [...readFields(message)].map((f) => (f.wireType === 0 ? [f.field, f.value] : [f.field, Buffer.from(f.value).toString("hex")]));
  assert.deepEqual(fields, [
    [1, 150n],
    [2, "6869"],
    [2, ""],
    [5, "0801"],
  ]);
  assert.deepEqual([...readFields(new Uint8Array())], []);
});

test("readFields refuses truncated messages, groups and field 0", () => {
  for (const [what, message] of [
    ["length past the end", bytes(0x12, 0x05, 0x68)],
    ["huge length", bytes(0x12, 0xff, 0xff, 0xff, 0xff, 0x0f)],
    ["fixed64 past the end", bytes(0x19, 1, 2)],
    ["start group", bytes(0x0b)],
    ["end group", bytes(0x0c)],
    ["field 0", bytes(0x00, 0x01)],
    ["truncated key", bytes(0x80)],
  ] as const) {
    assert.throws(() => [...readFields(message)], ProtobufError, what);
  }
});
