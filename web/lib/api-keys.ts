// A user's keys to the LLM API (/llm/api) and what each used, for the API page. The gateway checks the keys and
// counts their use (api_key_usage); costs use the chosen place's price on each day, as Admin > Energy does. It
// takes the database as an argument (no server-only imports).
import crypto from "node:crypto";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { apiKeys, apiKeyUsage, hashSessionToken, usageDay, writeAudit, type EnergyCurrency, type PortalDb } from "@portal/core";
import { JOULES_PER_WH, loadEnergyLocation, loadPricePeriods, priceOn } from "./energy.ts";
import { sumUse, type KeyUse } from "./key-use.ts";
import { MAX_API_KEYS } from "./limits.ts";

/** A working key. */
export interface ApiKeyRow extends KeyUse {
  id: number;
  name: string;
  /** The key's last four characters. */
  hint: string;
  createdAt: number;
  /** YYYY-MM-DD; null when it was never used. */
  lastUsed: string | null;
}

/** A key's use on one day. */
export interface KeyDay extends KeyUse {
  keyId: number;
  name: string;
  revoked: boolean;
  /** YYYY-MM-DD. */
  day: string;
}

export interface ApiKeysView {
  keys: ApiKeyRow[];
  /** Every day a key of the user's was used, revoked ones included, newest first. */
  days: KeyDay[];
  /** The currency of the chosen place's prices; null until the admin picks a place. */
  currency: EnergyCurrency | null;
  /** The day it is for the usage's days (YYYY-MM-DD). */
  today: string;
}

export function loadApiKeys(db: PortalDb, userId: number, now = Date.now()): ApiKeysView {
  const location = loadEnergyLocation(db);
  const periods = loadPricePeriods(db, location);
  const days: KeyDay[] = db
    .select({ key: apiKeys, use: apiKeyUsage })
    .from(apiKeyUsage)
    .innerJoin(apiKeys, eq(apiKeys.id, apiKeyUsage.keyId))
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeyUsage.day), apiKeys.id)
    .all()
    .map(({ key, use }) => {
      const energyWh = use.energyJ > 0 ? use.energyJ / JOULES_PER_WH : null;
      const price = priceOn(periods, use.day);
      return {
        keyId: key.id,
        name: key.name,
        revoked: key.revokedAt !== null,
        day: use.day,
        requests: use.requests,
        failed: use.failed,
        tokensIn: use.promptTokens,
        tokensOut: use.outputTokens,
        energyWh,
        cost: energyWh === null || price === null ? null : (energyWh / 1000) * price.price,
        costEstimate: energyWh !== null && price?.estimate === true,
      };
    });
  const working = db.select().from(apiKeys).where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt))).orderBy(apiKeys.id).all();
  return {
    currency: location?.currency ?? null,
    today: usageDay(new Date(now)),
    days,
    keys: working.map(({ id, name, hint, createdAt }) => {
      const own = days.filter((day) => day.keyId === id);
      return { id, name, hint, createdAt, lastUsed: own[0]?.day ?? null, ...sumUse(own) };
    }),
  };
}

/**
 * A new key for the user, audited as `api_key_created`: the key itself, which only its hash is stored of, or null
 * when the user already has MAX_API_KEYS working ones.
 */
export function createApiKey(db: PortalDb, userId: number, name: string, now = Date.now()): string | null {
  return db.transaction(() => {
    const working = db.select({ n: count() }).from(apiKeys).where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt))).get()?.n ?? 0;
    if (working >= MAX_API_KEYS) return null;
    // The shape of an OpenAI key ("sk-" and 48 characters), for software that checks it.
    const key = `sk-${crypto.randomBytes(24).toString("hex")}`;
    db.insert(apiKeys).values({ userId, name, tokenHash: hashSessionToken(key), hint: key.slice(-4), createdAt: now }).run();
    writeAudit(db, { action: "api_key_created", actorUserId: userId, details: { name } });
    return key;
  });
}

/** Revokes the user's own working key, audited as `api_key_revoked`: it stops working at once, its usage stays. False when there is none. */
export function revokeApiKey(db: PortalDb, userId: number, keyId: number, now = Date.now()): boolean {
  return db.transaction(() => {
    const key = db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .returning({ name: apiKeys.name })
      .get();
    if (!key) return false;
    writeAudit(db, { action: "api_key_revoked", actorUserId: userId, details: { name: key.name } });
    return true;
  });
}
