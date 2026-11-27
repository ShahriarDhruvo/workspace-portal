// What each API key's requests added up to on each local day (api_key_usage), for the web app's API page. A request
// that reached the AI server is counted when it ends; its share of the AI server's measured energy is added as it
// is measured (llm-energy.ts).
import { sql } from "drizzle-orm";
import { apiKeyUsage, usageDay, type PortalDb } from "@portal/core";
import type { Logger } from "../lib/log.ts";
import type { FinishedLlmRequest } from "./llm-requests.ts";

export class KeyUsage {
  readonly #db: PortalDb;
  readonly #log: Logger;
  readonly #now: () => number;

  constructor(options: { db: PortalDb; log: Logger; now?: () => number }) {
    this.#db = options.db;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
  }

  /** A request that came with `keyId` and reached the AI server ended. */
  finished(keyId: number, { ok, usage }: FinishedLlmRequest): void {
    this.#add(keyId, { requests: 1, failed: ok ? 0 : 1, promptTokens: usage?.promptTokens ?? 0, outputTokens: usage?.completionTokens ?? 0, energyJ: 0 });
  }

  /** The keys' shares of the AI server's measured energy. */
  addEnergy(shares: ReadonlyArray<{ keyId: number; joules: number }>): void {
    for (const share of shares) this.#add(share.keyId, { requests: 0, failed: 0, promptTokens: 0, outputTokens: 0, energyJ: share.joules });
  }

  #add(keyId: number, add: { requests: number; failed: number; promptTokens: number; outputTokens: number; energyJ: number }): void {
    const u = apiKeyUsage;
    try {
      this.#db
        .insert(u)
        .values({ keyId, day: usageDay(new Date(this.#now())), ...add })
        .onConflictDoUpdate({
          target: [u.keyId, u.day],
          set: {
            requests: sql`${u.requests} + ${add.requests}`,
            failed: sql`${u.failed} + ${add.failed}`,
            promptTokens: sql`${u.promptTokens} + ${add.promptTokens}`,
            outputTokens: sql`${u.outputTokens} + ${add.outputTokens}`,
            energyJ: sql`${u.energyJ} + ${add.energyJ}`,
          },
        })
        .run();
    } catch (error) {
      this.#log.error("could not count an API key's usage", { keyId, error });
    }
  }
}
