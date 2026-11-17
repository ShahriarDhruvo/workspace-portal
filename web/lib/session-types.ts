// The workspace sessions as Admin > Usage's sessions table gets them (lib/workspace-sessions.ts loads them, the
// API route sends them). Types and constants only, so client components can import it.
import type { EnergyCurrency } from "@portal/db/energy-locations";
import type { WorkspaceKind } from "@portal/db";

/** Rows per page of the sessions table. */
export const SESSION_PAGE_SIZE = 6;

/** One run of a user's workspace, from Start to its stop, and what its LLM requests added up to. */
export interface SessionRow {
  id: number;
  userId: number;
  userName: string;
  kind: WorkspaceKind;
  startedAt: number;
  /** null while it runs. */
  endedAt: number | null;
  requests: number;
  failed: number;
  /** Tokens in (cached ones included) and out. */
  tokensIn: number;
  cachedTokens: number;
  tokensOut: number;
  /** Prompt tokens read and answer tokens written per second of the engine's own time; null without any. */
  readTps: number | null;
  writeTps: number | null;
  /** Its requests' time on the LLM server, added up. */
  llmMs: number;
  /** Its share of the LLM server's measured energy; null while none was measured. */
  energyWh: number | null;
  /** That share's average draw while its requests ran. */
  watts: number | null;
  /** The energy at the price of the day it started; null without a place or a price. */
  cost: number | null;
  /** The price stands in for a month not yet published. */
  costEstimate: boolean;
}

export interface SessionPage {
  /** 1-based, within range. */
  page: number;
  total: number;
  rows: SessionRow[];
  /** The currency of the chosen place's prices; null until a place is picked. */
  currency: EnergyCurrency | null;
}
