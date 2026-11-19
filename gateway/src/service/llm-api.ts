// The LLM server's own HTTP API for a user's software (an editor, a script), opened by the user's API keys (the web
// app's API page). The web app passes /llm/api/* on as it comes (web/app/llm/api), so this answers on the control
// API's port. Nothing of the LLM server is left out: any path and method goes there as it is, but for the key, and
// a generation waits its turn and is counted like a workspace's (llm-proxy.ts), for its key as well (key-usage.ts).
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, hashSessionToken, users, type PortalDb } from "@portal/core";
import { sendJson, splitTarget } from "../lib/http-util.ts";
import { isPlainPath, proxyLlm, sendLlmError, type LlmProxyDeps } from "./llm-proxy.ts";

const PREFIX = "/llm/api";

export function isLlmApi(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

export async function serveLlmApi(deps: LlmProxyDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // As on the LLM server itself, a page of any site may call: the key opens the API, never the portal's cookie.
  res.setHeader("access-control-allow-origin", "*");
  const { pathname, search } = splitTarget(req.url ?? "");
  if (!isPlainPath(pathname)) return sendLlmError(res, 400, "invalid_request_error", "Invalid path.");
  // A browser's preflight carries no key.
  const caller = req.method === "OPTIONS" ? null : keyCaller(deps.db, req.headers);
  if (caller === undefined) {
    const message = 'Incorrect API key. Create one on the portal\'s API page and send it as "Authorization: Bearer <key>".';
    return sendJson(res, 401, { error: { message, type: "invalid_request_error", code: "invalid_api_key" } }, { "www-authenticate": "Bearer" });
  }
  delete req.headers["x-api-key"];
  return proxyLlm(deps, req, res, { caller, pathname: pathname.slice(PREFIX.length) || "/", search });
}

/**
 * Whose key a request presents, as OpenAI's clients send it or as Anthropic's do: a key that was not revoked, of an
 * account that may use the portal (active, no temporary password). undefined without one.
 */
function keyCaller(db: PortalDb, headers: IncomingHttpHeaders): { userId: number; keyId: number } | undefined {
  const key = /^Bearer (.+)$/i.exec(headers.authorization ?? "")?.[1] ?? headers["x-api-key"];
  if (typeof key !== "string") return undefined;
  return db
    .select({ userId: apiKeys.userId, keyId: apiKeys.id })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(apiKeys.tokenHash, hashSessionToken(key)), isNull(apiKeys.revokedAt), eq(users.active, true), eq(users.mustChangePassword, false)))
    .get();
}
