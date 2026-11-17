// The admin's live view (GET /control/live, server-sent events, for Admin > Usage): both servers' hardware
// readings and today's energy and traffic, and the LLM server's sessions with their Read and Write speeds, in one
// frame every FRAME_MS. The running workspaces are not in it: Admin > Users polls the workspace list. Nor are the
// workspace sessions (session-log.ts): the page reads them from the database when the frame's `sessionsVersion`
// changes. Everything behind it (hostd streams, /slots polling) runs only while someone watches; today's totals
// come from the energy meter's memory, which runs all the time.
//
// Events: `init` once (the frames' interval and the last minute of history for the charts), then
// `frame` every FRAME_MS (LiveFrame).
import type { ServerResponse } from "node:http";
import { inArray } from "drizzle-orm";
import { displayName, users, type PortalDb } from "@portal/db";
import type { EnergyMeter, HostToday } from "./energy-meter.ts";
import type { HostLive, HostMonitor, HostRole } from "./host-monitor.ts";
import type { HostSample } from "./hostd.ts";
import type { LlmLive, LlmMonitor } from "./llm-monitor.ts";
import type { Logger } from "./log.ts";
import type { SessionLog } from "./session-log.ts";

const FRAME_MS = 500;
/** LLM totals kept for a new viewer's chart. */
const LLM_HISTORY_FRAMES = 120;
/** Viewers beyond this are refused (each is an admin with Admin > Usage open). */
const MAX_VIEWERS = 8;

/** A server in a frame: its readings, and its totals for today (null until the energy meter has read it today). */
export type LiveHost = HostLive & { today: HostToday | null };

export interface LiveFrame {
  /** Gateway time (epoch ms), for "since" values. */
  t: number;
  hosts: Record<HostRole, LiveHost>;
  llm: LlmLive;
  /** Changes whenever the workspace sessions do (0 without them). */
  sessionsVersion: number;
}

export interface LiveInit {
  frameMs: number;
  /** The last minute of readings per server, oldest first. */
  history: Record<HostRole, HostSample[]>;
  /** The LLM totals of the recent frames, oldest first. */
  llmHistory: Array<{ t: number; readTps: number; writeTps: number }>;
}

export interface LiveDeps {
  llm: LlmMonitor;
  hosts: Record<HostRole, HostMonitor>;
  /** Today's totals per server; without it (tests that don't need them) every `today` is null. */
  energy?: Pick<EnergyMeter, "today">;
  /** The workspace sessions' version; without it (tests that don't need it) it stays 0. */
  sessions?: Pick<SessionLog, "version">;
  log: Logger;
  now?: () => number;
}

type Send = (event: "init" | "frame", data: unknown) => void;

export class TooManyViewersError extends Error {
  constructor() {
    super(`At most ${MAX_VIEWERS} live views can be open at once.`);
    this.name = "TooManyViewersError";
  }
}

export class LiveHub {
  readonly #deps: LiveDeps;
  readonly #now: () => number;
  readonly #viewers = new Set<Send>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #unwatch: Array<() => void> = [];
  #llmHistory: Array<{ t: number; readTps: number; writeTps: number }> = [];

  constructor(deps: LiveDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  get viewers(): number {
    return this.#viewers.size;
  }

  /** Streams the live view to `res` until the client goes away. */
  serve(res: ServerResponse): void {
    if (this.#viewers.size >= MAX_VIEWERS) throw new TooManyViewersError();
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
    const stop = this.subscribe(send);
    res.on("close", stop);
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
    const host = (role: HostRole): LiveHost => ({ ...hosts[role].live(), today: energy?.today(role) ?? null });
    return { t: this.#now(), hosts: { portal: host("portal"), llm: host("llm") }, llm: llm.snapshot(), sessionsVersion: sessions?.version ?? 0 };
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
