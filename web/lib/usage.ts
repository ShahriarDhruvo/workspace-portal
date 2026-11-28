import "server-only";
import { and, eq } from "drizzle-orm";
import { llmUsage, usageDay } from "@portal/core";
import { getDb } from "./db";

export interface UsageToday {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * The user's requests to the AI server and their tokens so far today, from the gateway's llm_usage rows (zeros before
 * the first). The gateway counts every finished generation there: text, images and media.
 */
export function loadUsageToday(userId: number): UsageToday {
  const row = getDb()
    .select({ requests: llmUsage.requests, promptTokens: llmUsage.promptTokens, completionTokens: llmUsage.completionTokens })
    .from(llmUsage)
    .where(and(eq(llmUsage.userId, userId), eq(llmUsage.day, usageDay(new Date()))))
    .get();
  return row ?? { requests: 0, promptTokens: 0, completionTokens: 0 };
}
