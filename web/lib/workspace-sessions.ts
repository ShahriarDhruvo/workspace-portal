// Admin > Usage's sessions table, read from workspace_sessions (written by the gateway's session-log.ts): the
// running sessions first, newest first, then the ended ones by when they ended. Costs use the chosen place's price
// on the day each session started (prices are monthly or half-yearly, so a session past midnight costs the same).
import { count, eq, sql } from "drizzle-orm";
import { displayName, usageDay, users, workspaceSessions, type EnergyCurrency, type PortalDb, type WorkspaceKind, type WorkspaceSession } from "@portal/core";
import { loadEnergyLocation, loadPricePeriods, priceOn, type DayPrice } from "./energy.ts";
import { clampPage, SESSION_PAGE_SIZE } from "./pagination.ts";

const JOULES_PER_WH = 3600;

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

/** A stored session as the table shows it, with its cost at `price` (per kWh). Pure. */
export function sessionRow(row: WorkspaceSession, userName: string, price: DayPrice | null): SessionRow {
  const energyWh = row.energyJ === null ? null : row.energyJ / JOULES_PER_WH;
  return {
    id: row.id,
    userId: row.userId,
    userName,
    kind: row.kind,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    requests: row.requests,
    failed: row.failed,
    tokensIn: row.promptTokens,
    cachedTokens: row.cachedTokens,
    tokensOut: row.outputTokens,
    readTps: row.readMs > 0 ? (row.readTokens * 1000) / row.readMs : null,
    writeTps: row.writeMs > 0 ? (row.writeTokens * 1000) / row.writeMs : null,
    llmMs: row.llmMs,
    energyWh,
    watts: row.energyJ !== null && row.energyMs > 0 ? (row.energyJ * 1000) / row.energyMs : null,
    cost: energyWh === null || price === null ? null : (energyWh / 1000) * price.price,
    costEstimate: energyWh !== null && price?.estimate === true,
  };
}

/** One page of the sessions (out of range: the nearest one). */
export function loadSessionPage(db: PortalDb, page = 1): SessionPage {
  const total = db.select({ n: count() }).from(workspaceSessions).get()?.n ?? 0;
  const current = clampPage(page, total, SESSION_PAGE_SIZE);
  const s = workspaceSessions;
  const rows = db
    .select({ session: s, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
    .from(s)
    .innerJoin(users, eq(users.id, s.userId))
    .orderBy(sql`${s.endedAt} IS NULL DESC`, sql`coalesce(${s.endedAt}, ${s.startedAt}) DESC`, sql`${s.id} DESC`)
    .limit(SESSION_PAGE_SIZE)
    .offset((current - 1) * SESSION_PAGE_SIZE)
    .all();
  const location = loadEnergyLocation(db);
  const periods = loadPricePeriods(db, location);
  return {
    page: current,
    total,
    currency: location?.currency ?? null,
    rows: rows.map(({ session, ...name }) => sessionRow(session, displayName(name), priceOn(periods, usageDay(new Date(session.startedAt))))),
  };
}
