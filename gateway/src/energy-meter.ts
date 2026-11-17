// The energy meter: each server's energy use and network traffic per local day (host_daily, priced on
// Admin > Energy), from its portal-hostd's running totals (GET /v1/meter). Unlike the live view it runs all
// the time: every POLL_MS it reads each set-up hostd, takes the increase since the reading before (kept in
// host_meter, so a gateway restart counts only what is new) and adds it to the local day it happened on.
import { sql } from "drizzle-orm";
import { HOST_ROLES, hostDaily, hostMeter, usageDay, type HostRole, type PortalDb } from "@portal/db";
import { HostdError, type MeterReading } from "./hostd.ts";
import type { Logger } from "./log.ts";

const POLL_MS = 30_000;

/** A server's totals for the current local day, as host_daily has them (each live frame's `hosts[role].today`). */
export interface HostToday {
  /** YYYY-MM-DD, local (usageDay). */
  day: string;
  /** null while the server's power has never been measurable. */
  energyWh: number | null;
  rxBytes: number;
  txBytes: number;
}

/** What the meter needs of a portal-hostd (a HostdClient). */
export interface MeterSource {
  readonly url: string;
  get<T>(path: string): Promise<T>;
}

/** host_meter's row: the last reading booked, `at` on the gateway's clock. */
interface Booked {
  instance: string;
  at: number;
  energyJ: number | null;
  rxBytes: number | null;
  txBytes: number | null;
}

type SourceState = "ok" | "no_meter" | "unavailable";

export interface EnergyMeterOptions {
  db: PortalDb;
  /** The set-up portal-hostds (config.hostd.<role> with a token). */
  sources: Partial<Record<HostRole, MeterSource>>;
  log: Logger;
  now?: () => number;
  pollMs?: number;
}

export class EnergyMeter {
  readonly #db: PortalDb;
  readonly #sources: Array<[HostRole, MeterSource]>;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #booked = new Map<HostRole, Booked>();
  /** The in-memory copy of each role's newest host_daily row, so frames never read the database. */
  readonly #today = new Map<HostRole, HostToday>();
  readonly #state = new Map<HostRole, SourceState>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #polling: Promise<void> | null = null;
  #stopped = false;

  constructor(options: EnergyMeterOptions) {
    this.#db = options.db;
    this.#sources = HOST_ROLES.flatMap((role) => (options.sources[role] ? [[role, options.sources[role]] as [HostRole, MeterSource]] : []));
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? POLL_MS;
    // Where the last run left off: a reading taken before a restart is the base of the next increase.
    const roles = new Set(this.#sources.map(([role]) => role));
    const day = usageDay(new Date(this.#now()));
    for (const row of this.#db.select().from(hostMeter).all()) if (roles.has(row.role)) this.#booked.set(row.role, row);
    for (const row of this.#db.select().from(hostDaily).where(sql`${hostDaily.day} = ${day}`).all()) {
      if (roles.has(row.role)) this.#today.set(row.role, { day: row.day, energyWh: row.energyWh, rxBytes: row.rxBytes, txBytes: row.txBytes });
    }
  }

  /** Polls now and then every POLL_MS until stop(). */
  start(): void {
    if (this.#timer !== null || this.#stopped || this.#sources.length === 0) return;
    void this.poll();
    this.#timer = setInterval(() => void this.poll(), this.#pollMs);
  }

  /** Stops polling; a round under way saves nothing (the database may be closing). */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Today's totals so far; null until this server has been read today (or when it isn't set up). */
  today(role: HostRole): HostToday | null {
    const row = this.#today.get(role);
    return row !== undefined && row.day === usageDay(new Date(this.#now())) ? { ...row } : null;
  }

  /** One round: reads every hostd at once, then books what is new in one transaction. Rounds never overlap. */
  poll(): Promise<void> {
    this.#polling ??= this.#round().finally(() => {
      this.#polling = null;
    });
    return this.#polling;
  }

  async #round(): Promise<void> {
    const readings = await Promise.all(this.#sources.map(async ([role, source]) => [role, await this.#read(role, source)] as const));
    if (this.#stopped) return;
    const now = this.#now();
    const booked: Array<[HostRole, Booked, HostToday]> = [];
    try {
      this.#db.transaction((tx) => {
        for (const [role, reading] of readings) {
          if (reading !== null) booked.push([role, ...this.#book(tx, role, reading, now)]);
        }
      });
    } catch (error) {
      this.#log.error("energy meter: could not save the readings", { error });
      return;
    }
    for (const [role, last, today] of booked) {
      this.#booked.set(role, last);
      this.#today.set(role, today);
    }
  }

  async #read(role: HostRole, source: MeterSource): Promise<MeterReading | null> {
    try {
      const reading = await source.get<unknown>("/v1/meter");
      if (!isReading(reading)) throw new HostdError(200, "bad_answer", `${source.url} sent a meter reading of another shape`);
      this.#setState(role, source, "ok");
      return reading;
    } catch (error) {
      // 404: a portal-hostd from before the meter (API version 1); it only needs updating.
      const missing = error instanceof HostdError && error.status === 404;
      this.#setState(role, source, missing ? "no_meter" : "unavailable", error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /** Logs each change of a source's state once (a hostd that stays down isn't logged every 30 s). */
  #setState(role: HostRole, source: MeterSource, state: SourceState, error?: string): void {
    const before = this.#state.get(role);
    if (before === state) return;
    this.#state.set(role, state);
    if (state === "ok") {
      if (before !== undefined) this.#log.info("energy meter: reading again", { role, url: source.url });
    } else if (state === "no_meter") {
      this.#log.warn("energy meter: this portal-hostd has no meter yet; update it (hostd/install.sh)", { role, url: source.url });
    } else {
      this.#log.warn("energy meter: portal-hostd unavailable", { role, url: source.url, error });
    }
  }

  /** Adds the increase since the last booked reading to host_daily and stores the reading. */
  #book(tx: Pick<PortalDb, "insert">, role: HostRole, reading: MeterReading, now: number): [Booked, HostToday] {
    const last = this.#booked.get(role) ?? null;
    const same = last !== null && last.instance === reading.instance;
    // A new instance is a restarted hostd, whose totals began again at zero; a total that went back is a reset.
    const increase = (current: number | null, before: number | null | undefined): number | null =>
      current === null ? null : same && before != null && current >= before ? current - before : current;
    const energyJ = increase(reading.energyJ, last?.energyJ);
    const rxBytes = increase(reading.rxBytes, last?.rxBytes) ?? 0;
    const txBytes = increase(reading.txBytes, last?.txBytes) ?? 0;
    // When it happened: since the last reading, or since hostd started if that is later (or first).
    const from = same ? last.at : Math.max(last?.at ?? -Infinity, Math.min(reading.startedAt, now));

    const parts = splitByDay(from, now);
    const rxParts = shareOut(rxBytes, parts);
    const txParts = shareOut(txBytes, parts);
    let today: HostToday | undefined;
    for (const [i, part] of parts.entries()) {
      const energyWh = energyJ === null ? null : (energyJ / 3600) * part.share;
      const row = tx
        .insert(hostDaily)
        .values({ day: part.day, role, energyWh, rxBytes: rxParts[i]!, txBytes: txParts[i]!, updatedAt: now })
        .onConflictDoUpdate({
          target: [hostDaily.day, hostDaily.role],
          set: {
            energyWh: sql`CASE WHEN excluded.energy_wh IS NULL THEN ${hostDaily.energyWh} ELSE coalesce(${hostDaily.energyWh}, 0) + excluded.energy_wh END`,
            rxBytes: sql`${hostDaily.rxBytes} + excluded.rx_bytes`,
            txBytes: sql`${hostDaily.txBytes} + excluded.tx_bytes`,
            updatedAt: now,
          },
        })
        .returning()
        .get();
      today = { day: row.day, energyWh: row.energyWh, rxBytes: row.rxBytes, txBytes: row.txBytes };
    }
    const booked: Booked = { instance: reading.instance, at: now, energyJ: reading.energyJ, rxBytes: reading.rxBytes, txBytes: reading.txBytes };
    tx.insert(hostMeter)
      .values({ role, ...booked })
      .onConflictDoUpdate({ target: hostMeter.role, set: booked })
      .run();
    // The last part is always the day of `now`.
    return [booked, today!];
  }
}

/**
 * Splits the span [from, to] (epoch ms) into the local days it touches, each with its share of the span's
 * length (the shares add up to 1). An empty or backward span belongs wholly to the day of `to`.
 */
export function splitByDay(from: number, to: number): Array<{ day: string; share: number }> {
  if (!(to > from)) return [{ day: usageDay(new Date(to)), share: 1 }];
  const parts: Array<{ day: string; share: number }> = [];
  for (let start = from; start < to; ) {
    const midnight = new Date(start);
    midnight.setHours(24, 0, 0, 0); // the next local midnight, daylight saving time included
    const end = Math.min(midnight.getTime(), to);
    parts.push({ day: usageDay(new Date(start)), share: (end - start) / (to - from) });
    start = end;
  }
  return parts;
}

/** Whole numbers in proportion to the parts' shares that add up to exactly `total`. */
function shareOut(total: number, parts: ReadonlyArray<{ share: number }>): number[] {
  let given = 0;
  let cumulative = 0;
  return parts.map((part, i) => {
    cumulative += part.share;
    const upTo = i === parts.length - 1 ? total : Math.round(total * cumulative);
    const amount = upTo - given;
    given = upTo;
    return amount;
  });
}

function isReading(value: unknown): value is MeterReading {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const total = (v: unknown, integer: boolean): boolean =>
    v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && (!integer || Number.isSafeInteger(v)));
  return (
    typeof r.instance === "string" &&
    r.instance !== "" &&
    typeof r.startedAt === "number" &&
    Number.isFinite(r.startedAt) &&
    total(r.energyJ, false) &&
    total(r.rxBytes, true) &&
    total(r.txBytes, true)
  );
}
