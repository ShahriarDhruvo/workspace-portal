// The harnesses a workspace can run, by kind, and what the gateway uses of them.
import { AGENT_KINDS, type AgentKind } from "@portal/core";
import { dshDriver } from "./dsh/driver.ts";
import type { AgentDriver } from "./harness.ts";
import { opencodeDriver } from "./opencode/driver.ts";
import { qwenDriver } from "./qwen/driver.ts";

const DRIVERS: Readonly<Record<AgentKind, AgentDriver>> = { qwen: qwenDriver, dsh: dshDriver, opencode: opencodeDriver };

export function driverFor(kind: AgentKind): AgentDriver {
  return DRIVERS[kind];
}

/** Every token harness's bearerSubprotocolPrefix: a token offered on any workspace's socket is checked, whichever harness it was meant for. */
export const BEARER_SUBPROTOCOL_PREFIXES: readonly string[] = AGENT_KINDS.flatMap((kind) => DRIVERS[kind].bearerSubprotocolPrefix ?? []);

export type { AgentDriver, AgentEndpoint, HarnessConfig, HeaderMap, WorkspaceFacts } from "./harness.ts";
export { modelCatalog, type ModelCatalog, type PortalModel, type SettingsObject } from "./models.ts";
export { AgentConfigError, LLM_KEY_ENV } from "./shared.ts";
