// One request to the LLM server and its answer back, for the workspaces (service-api.ts) and for API keys
// (llm-api.ts). A generation waits for its turn (llm-queue.ts), is followed while it runs (llm-requests.ts) and is
// counted for its user (llm_usage); any other request is passed straight on.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PortalDb } from "@portal/core";
import type { Config } from "../config.ts";
import { forward, type ForwardResult } from "../lib/forward.ts";
import { sendJson } from "../lib/http-util.ts";
import type { Logger } from "../lib/log.ts";
import type { LlmRequests } from "../monitor/llm-requests.ts";
import { recordUsage, usageParserFor, usageTap, type UsageParser } from "../monitor/usage.ts";
import { endToEndHeaders, llmRequestHeaders } from "../proxy/headers.ts";
import type { LlmQueue, ReleaseSlot } from "./llm-queue.ts";

export interface LlmProxyDeps {
  config: Config;
  db: PortalDb;
  llm: LlmQueue;
  requests: LlmRequests;
  log: Logger;
}

interface LlmCall {
  /** Whose request it is, and the API key it came with (null from a workspace). null: no one's, a browser's preflight. */
  caller: { userId: number; keyId: number | null } | null;
  /** On the LLM server: "/v1/chat/completions". */
  pathname: string;
  /** "?…", or "". */
  search: string;
  /** Sees every chunk of the request body on its way. It must not throw. */
  observeBody?: (chunk: Buffer) => void;
}

/** POST routes that count or format a prompt: they take none of the engine's sessions, so they are no generations. */
const NOT_A_GENERATION = /\/(?:input_tokens|count_tokens|tokenize|apply-template)$/;

/** The error shape OpenAI clients understand (the LLM server's own errors pass through as they are). */
export function sendLlmError(res: ServerResponse, status: number, type: string, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { error: { message, type } }, headers);
}

/** No dot segments or encoded separators, so the LLM server only ever sees the path that was checked. */
export function isPlainPath(pathname: string): boolean {
  return !/%2e|%2f|%5c|\\/i.test(pathname) && new URL(pathname, "http://localhost").pathname === pathname;
}

export async function proxyLlm(deps: LlmProxyDeps, req: IncomingMessage, res: ServerResponse, { caller, pathname, search, observeBody }: LlmCall): Promise<void> {
  const method = req.method ?? "GET";
  // Only a generation waits for a slot: listing the models or counting a prompt's tokens never queues behind one.
  const generating = method === "POST" && !NOT_A_GENERATION.test(pathname) ? caller : null;
  const progress = generating ? deps.requests.begin(generating.userId, generating.keyId) : null;

  let release: ReleaseSlot = () => undefined;
  if (generating) {
    const hangUp = new AbortController();
    const onClose = (): void => hangUp.abort();
    res.once("close", onClose);
    try {
      release = await deps.llm.acquire(generating.userId, hangUp.signal);
    } catch {
      progress?.finish(false);
      return; // the client hung up while queued
    } finally {
      res.off("close", onClose);
    }
    if (req.socket.destroyed) {
      release();
      progress?.finish(false);
      return;
    }
    progress?.forwarded();
  }

  const started = Date.now();
  const tapped: { parser: UsageParser | null } = { parser: null };
  let result: ForwardResult | null = null;
  try {
    result = await forward(req, res, {
      url: new URL(`${deps.config.llm.upstreamUrl}${pathname}${search}`),
      method,
      headers: llmRequestHeaders(req.headers, deps.config.llm.apiKey),
      observeBody,
      responseHeaders: (incoming) => endToEndHeaders(incoming.headers),
      tap: (incoming) => {
        tapped.parser = generating ? usageParserFor(incoming.headers, progress) : null;
        return tapped.parser ? usageTap(tapped.parser) : null;
      },
      onError: (error, response) => {
        deps.log.warn("LLM server did not answer", { ...caller, error });
        sendLlmError(response, 502, "llm_unreachable", "The LLM server is not reachable.");
      },
    });
  } finally {
    release();
    // A client that hangs up (a cancelled turn, a helper request it dropped, a workspace's stop) is not the LLM server failing.
    const ok = result !== null && result.outcome !== "failed" && (result.status === null || (result.status >= 200 && result.status < 300));
    progress?.finish(ok, tapped.parser?.usage ?? null);
  }

  const usage = tapped.parser?.usage ?? null;
  if (generating && result.status !== null && result.status >= 200 && result.status < 300) {
    try {
      recordUsage(deps.db, generating.userId, usage);
    } catch (error) {
      deps.log.error("could not record LLM usage", { ...caller, error });
    }
  }
  deps.log.info("llm request", {
    ...caller,
    method,
    path: pathname,
    status: result.status,
    outcome: result.outcome,
    ms: Date.now() - started,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
  });
}
