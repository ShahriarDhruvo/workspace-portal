// The agents a workspace can run, by kind.
import type { AgentKind } from "@portal/db";
import type { AgentDriver } from "./driver.ts";
import { dshDriver } from "./dsh.ts";
import { qwenDriver } from "./qwen.ts";

const DRIVERS: Readonly<Record<AgentKind, AgentDriver>> = { qwen: qwenDriver, dsh: dshDriver };

export function driverFor(kind: AgentKind): AgentDriver {
  return DRIVERS[kind];
}

export { AgentConfigError, LLM_KEY_ENV, serviceBaseUrl, type AgentDriver, type AgentEndpoint, type AgentStatus, type BrowserAuth } from "./driver.ts";
