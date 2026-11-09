import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { llmUsage, openDatabase, users } from "@portal/db";
import {
  extractUsage,
  JsonUsageParser,
  recordUsage,
  SseUsageParser,
  usageDay,
  usageParserFor,
  usageTap,
  type UsageParser,
} from "./usage.ts";

function feed(parser: UsageParser, chunks: Buffer[]): UsageParser {
  for (const chunk of chunks) parser.write(chunk);
  parser.end();
  return parser;
}

/** Every way of cutting `body` into two reads, plus one byte per read. */
function splits(body: Buffer): Buffer[][] {
  const out: Buffer[][] = [[...body].map((byte) => Buffer.from([byte]))];
  for (let i = 0; i <= body.length; i++) out.push([body.subarray(0, i), body.subarray(i)]);
  return out;
}

const SSE = Buffer.from(
  [
    'data: {"id":"1","choices":[{"delta":{"content":"héllo 👋"}}],"usage":null}',
    "",
    'data: {"id":"1","choices":[{"delta":{"content":" wörld"}}],"usage":null}',
    "",
    'data: {"id":"1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}',
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n"),
);

test("extractUsage reads chat-completions and responses naming", () => {
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), { promptTokens: 3, completionTokens: 4 });
  assert.deepEqual(extractUsage({ usage: { input_tokens: 5, output_tokens: 6 } }), { promptTokens: 5, completionTokens: 6 });
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 7 } }), { promptTokens: 7, completionTokens: 0 });
  assert.equal(extractUsage({ usage: null }), null);
  assert.equal(extractUsage({ usage: { prompt_tokens: -1, completion_tokens: "2" } }), null);
  assert.equal(extractUsage([1, 2]), null);
  assert.equal(extractUsage("x"), null);
});

test("SSE: the last event carrying usage wins, wherever the reads are split", () => {
  for (const chunks of splits(SSE)) {
    assert.deepEqual(feed(new SseUsageParser(), chunks).usage, { promptTokens: 12, completionTokens: 34 });
  }
});

test("SSE: CRLF lines, multi-line data, and a stream that ends without a blank line", () => {
  const crlf = Buffer.from('data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\r\n\r\n');
  assert.deepEqual(feed(new SseUsageParser(), [crlf]).usage, { promptTokens: 1, completionTokens: 2 });

  const multiline = Buffer.from('event: x\ndata: {"usage":\ndata: {"prompt_tokens":3,"completion_tokens":4}}\n\n');
  assert.deepEqual(feed(new SseUsageParser(), [multiline]).usage, { promptTokens: 3, completionTokens: 4 });

  const unterminated = Buffer.from('data:{"usage":{"prompt_tokens":5,"completion_tokens":6}}');
  assert.deepEqual(feed(new SseUsageParser(), [unterminated]).usage, { promptTokens: 5, completionTokens: 6 });

  const later = Buffer.from(
    'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n: comment\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":9}}\n\n',
  );
  assert.deepEqual(feed(new SseUsageParser(), [later]).usage, { promptTokens: 2, completionTokens: 9 });

  assert.equal(feed(new SseUsageParser(), [Buffer.from("data: [DONE]\n\n")]).usage, null);
});

test("SSE: an oversized line is skipped without breaking later events", () => {
  const huge = `data: ${"x".repeat(2 * 1024 * 1024)}\n\n`;
  const body = Buffer.from(`${huge}data: {"usage":{"prompt_tokens":8,"completion_tokens":9}}\n\n`);
  const chunks: Buffer[] = [];
  for (let i = 0; i < body.length; i += 64 * 1024) chunks.push(body.subarray(i, i + 64 * 1024));
  assert.deepEqual(feed(new SseUsageParser(), chunks).usage, { promptTokens: 8, completionTokens: 9 });
});

test("JSON: usage from the whole body, wherever the reads are split", () => {
  const body = Buffer.from(
    JSON.stringify({ id: "x", choices: [{ message: { content: "ünïcode ✓" } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }),
  );
  for (const chunks of splits(body)) {
    assert.deepEqual(feed(new JsonUsageParser(), chunks).usage, { promptTokens: 10, completionTokens: 20 });
  }
  assert.equal(feed(new JsonUsageParser(), [Buffer.from("{not json")]).usage, null);
});

test("usageParserFor picks by content type and skips compressed bodies", () => {
  assert.ok(usageParserFor({ "content-type": "text/event-stream; charset=utf-8" }) instanceof SseUsageParser);
  assert.ok(usageParserFor({ "content-type": "application/json" }) instanceof JsonUsageParser);
  assert.ok(usageParserFor({ "content-type": "application/json", "content-encoding": "identity" }) instanceof JsonUsageParser);
  assert.equal(usageParserFor({ "content-type": "application/json", "content-encoding": "gzip" }), null);
  assert.equal(usageParserFor({ "content-type": "text/plain" }), null);
  assert.equal(usageParserFor({}), null);
});

test("usageTap passes the stream through unchanged", async () => {
  const parser = new SseUsageParser();
  const chunks = [SSE.subarray(0, 50), SSE.subarray(50, 51), SSE.subarray(51)];
  const output = await text(Readable.from(chunks).pipe(usageTap(parser)));
  assert.equal(output, SSE.toString("utf8"));
  assert.deepEqual(parser.usage, { promptTokens: 12, completionTokens: 34 });
});

test("usageDay is the local calendar day", () => {
  assert.equal(usageDay(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(usageDay(new Date(2026, 10, 18, 0, 1)), "2026-11-18");
});

test("recordUsage upserts one row per user and day", () => {
  const db = openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-usage-")), "db.sqlite"));
  const now = Date.now();
  const user = db
    .insert(users)
    .values({ username: "alice", firstName: "A", lastName: "L", passwordHash: "x", createdAt: now, updatedAt: now })
    .returning()
    .get();
  const day = new Date(2026, 10, 8, 10);
  recordUsage(db, user.id, { promptTokens: 10, completionTokens: 5 }, day);
  recordUsage(db, user.id, { promptTokens: 1, completionTokens: 2 }, day);
  recordUsage(db, user.id, null, day);
  recordUsage(db, user.id, { promptTokens: 7, completionTokens: 7 }, new Date(2026, 10, 9, 10));
  const rows = db.select().from(llmUsage).all().sort((a, b) => a.day.localeCompare(b.day));
  assert.deepEqual(rows, [
    { userId: user.id, day: "2026-11-08", requests: 3, promptTokens: 11, completionTokens: 7 },
    { userId: user.id, day: "2026-11-09", requests: 1, promptTokens: 7, completionTokens: 7 },
  ]);
});
