import "server-only";
import { and, eq } from "drizzle-orm";
import { llmUsage, usageDay } from "@portal/core";
import { getDb } from "./db";

export interface UsageToday {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

/** The user's LLM requests and tokens so far today, from the gateway's llm_usage rows (zeros before the first). */
export function loadUsageToday(userId: number, now = new Date()): UsageToday {
  const row = getDb()
    .select({ requests: llmUsage.requests, promptTokens: llmUsage.promptTokens, completionTokens: llmUsage.completionTokens })
    .from(llmUsage)
    .where(and(eq(llmUsage.userId, userId), eq(llmUsage.day, usageDay(now))))
    .get();
  return row ?? { requests: 0, promptTokens: 0, completionTokens: 0 };
}
