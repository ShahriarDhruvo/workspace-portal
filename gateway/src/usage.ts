// Token usage of LLM responses, read from a copy of the stream as it passes through: the `usage`
// object of a JSON body, or of the last SSE event that carries one. Recorded per user and day.
import type { IncomingHttpHeaders } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { Transform, type TransformCallback } from "node:stream";
import { sql } from "drizzle-orm";
import { llmUsage, type PortalDb } from "@portal/db";
import { MIB } from "./config.ts";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Larger JSON bodies are passed through without being parsed for usage. */
const MAX_JSON_BYTES = 8 * MIB;
/** SSE events larger than this are skipped (usage chunks are a few hundred bytes). */
const MAX_EVENT_CHARS = 1024 * 1024;

/** Reads `usage` from an OpenAI-style response object (chat/completions or responses naming). */
export function extractUsage(payload: unknown): TokenUsage | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) return null;
  const { usage } = payload;
  const prompt = tokenCount(usage.prompt_tokens ?? usage.input_tokens);
  const completion = tokenCount(usage.completion_tokens ?? usage.output_tokens);
  if (prompt === null && completion === null) return null;
  return { promptTokens: prompt ?? 0, completionTokens: completion ?? 0 };
}

export interface UsageParser {
  write(chunk: Buffer): void;
  end(): void;
  readonly usage: TokenUsage | null;
}

/** Server-sent events: tracks the usage of the last `data:` event that has one. */
export class SseUsageParser implements UsageParser {
  usage: TokenUsage | null = null;
  readonly #decoder = new StringDecoder("utf8");
  #line = "";
  #data: string[] = [];
  #dataChars = 0;
  #skipLine = false;

  write(chunk: Buffer): void {
    this.#feed(this.#decoder.write(chunk));
  }

  end(): void {
    this.#feed(this.#decoder.end());
    if (this.#line !== "" && !this.#skipLine) this.#processLine(this.#line);
    this.#line = "";
    this.#dispatch();
  }

  #feed(text: string): void {
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) {
        this.#append(text.slice(start));
        return;
      }
      this.#append(text.slice(start, newline));
      if (!this.#skipLine) this.#processLine(this.#line);
      this.#line = "";
      this.#skipLine = false;
      start = newline + 1;
    }
  }

  #append(text: string): void {
    if (this.#skipLine) return;
    if (this.#line.length + text.length > MAX_EVENT_CHARS) {
      this.#line = "";
      this.#skipLine = true;
      return;
    }
    this.#line += text;
  }

  #processLine(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      this.#dispatch();
      return;
    }
    if (!line.startsWith("data:")) return;
    const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
    this.#dataChars += value.length;
    if (this.#dataChars <= MAX_EVENT_CHARS) this.#data.push(value);
  }

  #dispatch(): void {
    const data = this.#dataChars <= MAX_EVENT_CHARS ? this.#data.join("\n") : "";
    this.#data = [];
    this.#dataChars = 0;
    if (!data.includes('"usage"')) return;
    const usage = extractUsage(parseJson(data));
    if (usage) this.usage = usage;
  }
}

/** A JSON body: keeps a copy (up to a cap) and parses it once the response ends. */
export class JsonUsageParser implements UsageParser {
  usage: TokenUsage | null = null;
  #chunks: Buffer[] = [];
  #bytes = 0;

  write(chunk: Buffer): void {
    this.#bytes += chunk.length;
    if (this.#bytes <= MAX_JSON_BYTES) this.#chunks.push(chunk);
    else this.#chunks = [];
  }

  end(): void {
    if (this.#bytes <= MAX_JSON_BYTES) this.usage = extractUsage(parseJson(Buffer.concat(this.#chunks).toString("utf8")));
    this.#chunks = [];
  }
}

/** Picks a parser from the response headers; null for bodies usage can't be read from. */
export function usageParserFor(headers: IncomingHttpHeaders): UsageParser | null {
  const encoding = headers["content-encoding"];
  if (encoding !== undefined && encoding.toLowerCase() !== "identity") return null;
  const type = (headers["content-type"] ?? "").toLowerCase();
  if (type.includes("text/event-stream")) return new SseUsageParser();
  if (type.includes("json")) return new JsonUsageParser();
  return null;
}

/** A pass-through stream that feeds a copy of every chunk to `parser`. */
export function usageTap(parser: UsageParser): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      parser.write(chunk);
      callback(null, chunk);
    },
    flush(callback: TransformCallback) {
      parser.end();
      callback();
    },
  });
}

/** YYYY-MM-DD in the gateway's local time zone. */
export function usageDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Adds one request (and its tokens, when known) to the user's row for the day. */
export function recordUsage(db: PortalDb, userId: number, usage: TokenUsage | null, at = new Date()): void {
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  db.insert(llmUsage)
    .values({ userId, day: usageDay(at), requests: 1, promptTokens, completionTokens })
    .onConflictDoUpdate({
      target: [llmUsage.userId, llmUsage.day],
      set: {
        requests: sql`${llmUsage.requests} + 1`,
        promptTokens: sql`${llmUsage.promptTokens} + ${promptTokens}`,
        completionTokens: sql`${llmUsage.completionTokens} + ${completionTokens}`,
      },
    })
    .run();
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
