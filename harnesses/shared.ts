// What the drivers have in common: the names and limits every harness's settings use, a start's credential, and how
// the gateway asks a running agent about itself.
import crypto from "node:crypto";
import http from "node:http";
import { parseJson, readBounded, type WorkspaceKind } from "@portal/core";
import type { HarnessConfig } from "./harness.ts";

/** The env var holding the placeholder LLM key in every workspace. The gateway's LLM proxy replaces it with the real key, which never enters a workspace. */
export const LLM_KEY_ENV = "PORTAL_LLM_KEY";

/** The admin's settings for an agent are unusable; the start fails with this message. */
export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

/**
 * The gateway's service API (model + search) as a workspace of `kind` reaches it: the host's address on that kind's
 * network, where the gateway answers only that kind's containers. A Private workspace can reach nothing else.
 */
export function serviceBaseUrl(config: HarnessConfig, kind: WorkspaceKind): string {
  return `http://${config.workspace.kinds[kind].gatewayIp}:${config.servicePort}`;
}

/** The headless browser as an MCP server. dsh gives MCP children a scrubbed environment, so the browser's path goes on the command line. */
export const BROWSER_MCP = {
  command: "/usr/local/bin/playwright-mcp",
  args: ["--headless", "--isolated", "--no-sandbox", "--executable-path=/usr/bin/chromium", "--output-dir=/workspace/.browser"],
} as const;
/** How long one call of a browser or search tool may take. */
export const BROWSER_TIMEOUT_MS = 120_000;
export const SEARCH_TIMEOUT_MS = 60_000;
/**
 * How long an agent waits for a model's answer to start, where its settings take it: as long as Qwen Code's
 * (generationConfig.timeout in models/system-defaults.json). A request waits in the gateway's queue, in the order it
 * came, for as long as it takes: while a video is made nothing else runs, for up to 12 hours (VideoJobs' maxRunMs),
 * and other requests or videos may be ahead of it. An agent that gave up would ask again at the back of the queue.
 */
export const LLM_WAIT_MS = 86_400_000;
/**
 * How long an answer under way may go without a word, where an agent's settings take it apart from the wait: as long
 * as Qwen Code's (generationConfig.streamIdleTimeoutMs).
 */
export const LLM_TIMEOUT_MS = 3_600_000;

/** 32 random bytes: also the form of dsh's own browser-session secrets (its start.sh checks it). */
export const generateCredential = (): string => crypto.randomBytes(32).toString("base64url");

/** How long the gateway waits for an agent's answer about itself. */
export const AGENT_TIMEOUT_MS = 3_000;

/**
 * JSON from a workspace's agent over HTTP: the body of a 200, or null on any failure (refused, not JSON, longer than
 * `maxBytes`, not all there within AGENT_TIMEOUT_MS). `body` is what a POST sends.
 */
export function agentJson(options: http.RequestOptions, maxBytes: number, body?: string): Promise<unknown> {
  return new Promise((resolve) => {
    // One deadline for the whole answer: a socket timeout starts again with every byte an agent drips.
    const request = http.request({ ...options, agent: false, signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) }, (response) => {
      readBounded(response, maxBytes).then(
        (bytes) => resolve(response.statusCode === 200 && bytes !== null ? parseJson(bytes.toString("utf8")) : null),
        () => resolve(null),
      );
    });
    request.on("error", () => resolve(null));
    request.end(body);
  });
}
