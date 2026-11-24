// The agents a workspace can run, by kind.
import type { AgentKind } from "@portal/core";
import type { AgentDriver } from "./driver.ts";
import { dshDriver } from "./dsh.ts";
import { opencodeDriver } from "./opencode.ts";
import { qwenDriver } from "./qwen.ts";

const DRIVERS: Readonly<Record<AgentKind, AgentDriver>> = { qwen: qwenDriver, dsh: dshDriver, opencode: opencodeDriver };

export function driverFor(kind: AgentKind): AgentDriver {
  return DRIVERS[kind];
}

export { AgentConfigError, LLM_KEY_ENV, type AgentDriver, type AgentEndpoint } from "./driver.ts";
