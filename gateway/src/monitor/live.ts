// The admin's live view (GET /control/live, server-sent events, for Admin > Usage): `init` once (the frames' interval
// and the last minute of history for the charts), then a `frame` every FRAME_MS with both servers' hardware readings
// and today's energy and traffic, and the LLM server's sessions with their Read and Write speeds. The workspace
// sessions (session-log.ts) are not in it: the page reads them from the database when the frame's `sessionsVersion`
// changes. Everything behind it (hostd streams, /slots polling) runs only while someone watches; today's totals come
// from the energy meter's memory, which runs all the time.
import type { ServerResponse } from "node:http";
import { inArray } from "drizzle-orm";
import { displayName, users, type HostLive, type HostRole, type LiveFrame, type LiveInit, type LlmTotalsPoint, type PortalDb } from "@portal/core";
import type { EnergyMeter } from "./energy-meter.ts";
import type { HostMonitor } from "./host-monitor.ts";
import type { LlmMonitor } from "./llm-monitor.ts";
import { HttpError } from "../lib/http-util.ts";
import type { Logger } from "../lib/log.ts";
import type { SessionLog } from "./session-log.ts";

const FRAME_MS = 500;
/** LLM totals kept for a new viewer's chart. */
const LLM_HISTORY_FRAMES = 120;
/** Viewers beyond this are refused (each is an admin with Admin > Usage open). */
const MAX_VIEWERS = 8;

export interface LiveDeps {
  llm: LlmMonitor;
  hosts: Record<HostRole, HostMonitor>;
  energy: Pick<EnergyMeter, "today">;
  sessions: Pick<SessionLog, "version">;
  log: Logger;
  now?: () => number;
}

type Send = (event: "init" | "frame", data: unknown) => void;

export class LiveHub {
  readonly #deps: LiveDeps;
  readonly #now: () => number;
  readonly #viewers = new Set<Send>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #unwatch: Array<() => void> = [];
  #llmHistory: LlmTotalsPoint[] = [];

  constructor(deps: LiveDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  get viewers(): number {
    return this.#viewers.size;
  }

  /** Streams the live view to `res` until the client goes away. */
  serve(res: ServerResponse): void {
    if (this.#viewers.size >= MAX_VIEWERS) throw new HttpError(429, "too_many_viewers", `At most ${MAX_VIEWERS} live views can be open at once.`);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    const send: Send = (event, data) => {
      // A viewer that can't keep up skips frames rather than buffering them.
      if (res.writableNeedDrain) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.on("close", this.subscribe(send));
  }

  /** Adds a viewer: it gets `init` and the current frame at once, then a frame every FRAME_MS. */
  subscribe(send: Send): () => void {
    if (this.#viewers.size === 0) this.#start();
    this.#viewers.add(send);
    const { hosts } = this.#deps;
    const init: LiveInit = { frameMs: FRAME_MS, history: { portal: hosts.portal.history(), llm: hosts.llm.history() }, llmHistory: [...this.#llmHistory] };
    send("init", init);
    send("frame", this.frame());
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#viewers.delete(send);
      if (this.#viewers.size === 0) this.#stop();
    };
  }

  /** The current state (also each viewer's first frame). */
  frame(): LiveFrame {
    const { llm, hosts, energy, sessions } = this.#deps;
    const host = (role: HostRole): HostLive => ({ ...hosts[role].live(), today: energy.today(role) });
    return { t: this.#now(), hosts: { portal: host("portal"), llm: host("llm") }, llm: llm.snapshot(), sessionsVersion: sessions.version };
  }

  /** Stops everything (gateway shutdown); open streams end with their sockets. */
  close(): void {
    this.#viewers.clear();
    this.#stop();
  }

  #start(): void {
    const { llm, hosts } = this.#deps;
    llm.start();
    this.#unwatch = [hosts.portal.watch(), hosts.llm.watch()];
    this.#timer = setInterval(() => this.#tick(), FRAME_MS);
  }

  #stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    for (const unwatch of this.#unwatch) unwatch();
    this.#unwatch = [];
    this.#deps.llm.stop();
    this.#llmHistory = [];
  }

  #tick(): void {
    let frame: LiveFrame;
    try {
      frame = this.frame();
    } catch (error) {
      this.#deps.log.error("live view: frame failed", { error });
      return;
    }
    this.#llmHistory.push({ t: frame.t, readTps: frame.llm.totals.readTps, writeTps: frame.llm.totals.writeTps });
    if (this.#llmHistory.length > LLM_HISTORY_FRAMES) this.#llmHistory.shift();
    for (const send of this.#viewers) send("frame", frame);
  }
}

/** Display names of the given users (unknown ids are left out). */
export function userNames(db: PortalDb, ids: readonly number[]): Map<number, string> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({ id: users.id, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]))
    .all();
  return new Map(rows.map((row) => [row.id, displayName(row)]));
}
