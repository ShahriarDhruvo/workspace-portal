// Everything specific to Qwen Code's `qwen serve` (the Web Shell) inside a workspace container:
// its port, the health endpoint the gateway uses for readiness and for "is the agent working?",
// and the per-user settings files the gateway renders before every start.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/** Where `qwen serve` listens on the container's own address (see workspace-image/start-workspace.sh). */
export const QWEN_PORT = 4170;
/** Name of the env var holding the placeholder LLM key; the gateway swaps in the real key. */
export const LLM_KEY_ENV = "PORTAL_LLM_KEY";
/** Mount point of the per-user settings directory (QWEN_CODE_SYSTEM_*_PATH in the image point here). */
export const QWEN_SETTINGS_MOUNT = "/etc/workspace-portal/qwen";

const HEALTH_TIMEOUT_MS = 3_000;

/** A fresh random bearer token for one container start. */
export function generateServerToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// ------------------------------------------------------------------ health

/** The parts of `GET /health?deep=1` the gateway uses. All figures cover every session of the daemon. */
export interface QwenHealth {
  activePrompts: number;
  pendingPermissions: number;
  /** Agent, subagent, shell, background task or tool work the agent process reports as running. */
  activeWork: boolean;
  /** The agent process is up and can take prompts. */
  channelAlive: boolean;
  /** Time since the agent last started or finished something; null before the first session. */
  idleSinceMs: number | null;
}

export function parseQwenHealth(body: unknown): QwenHealth | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.status !== "ok") return null;
  const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const idle = record.idleSinceMs;
  return {
    activePrompts: count(record.activePrompts),
    pendingPermissions: count(record.pendingPermissions),
    activeWork: record.activeWork === true,
    channelAlive: record.channelAlive === true,
    idleSinceMs: typeof idle === "number" && Number.isFinite(idle) && idle >= 0 ? idle : null,
  };
}

/** Reads `/health?deep=1` from a workspace; null when it does not answer or answers oddly. */
export function fetchQwenHealth(host: string, port: number, token: string): Promise<QwenHealth | null> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host,
        port,
        path: "/health?deep=1",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        agent: false,
        timeout: HEALTH_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) request.destroy();
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return resolve(null);
          try {
            resolve(parseQwenHealth(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          } catch {
            resolve(null);
          }
        });
        response.on("error", () => resolve(null));
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

/**
 * The agent is doing something: a prompt, a tool, a subagent, a background task, or an approval it
 * waits for. An approval nobody answers needs no special case: `qwen serve` declines it after
 * --permission-response-timeout-ms, which the gateway sets to the idle timeout.
 */
export function agentWorking(health: QwenHealth): boolean {
  return health.activePrompts > 0 || health.pendingPermissions > 0 || health.activeWork;
}

// ------------------------------------------------------------------ settings

export type SettingsObject = Record<string, unknown>;

export class QwenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QwenConfigError";
  }
}

/** The admin's settings, from PORTAL_DATA_DIR/config/qwen. Missing files are empty objects. */
export interface AdminQwenConfig {
  settings: SettingsObject;
  systemDefaults: SettingsObject;
  /** Where systemDefaults came from, for error messages. */
  systemDefaultsFile: string;
}

const ADMIN_SETTINGS_FILE = "settings.json";
const ADMIN_DEFAULTS_FILE = "system-defaults.json";

export function loadAdminQwenConfig(dir: string): AdminQwenConfig {
  const systemDefaultsFile = path.join(dir, ADMIN_DEFAULTS_FILE);
  return {
    settings: readSettingsFile(path.join(dir, ADMIN_SETTINGS_FILE)),
    systemDefaults: readSettingsFile(systemDefaultsFile),
    systemDefaultsFile,
  };
}

/** Reads a settings file: JSON, optionally with // and /* comments as Qwen Code allows. */
export function readSettingsFile(file: string): SettingsObject {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new QwenConfigError(`cannot read the Qwen Code settings file ${file}: ${(error as Error).message}`);
  }
  return parseSettingsText(text, file);
}

export function parseSettingsText(text: string, label: string): SettingsObject {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new QwenConfigError(`the Qwen Code settings file ${label} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isPlainObject(value)) throw new QwenConfigError(`the Qwen Code settings file ${label} must contain a JSON object`);
  return value;
}

/** Removes // line and /* block comments outside strings. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      out += " "; // like Qwen Code's own parser: a comment separates tokens, it doesn't join them
    } else {
      out += char;
    }
  }
  return out;
}

export interface RenderOptions {
  admin: AdminQwenConfig;
  /** http://<gateway bridge IP>:<service port>, the only address a workspace can reach. */
  serviceBaseUrl: string;
  /** Offer the Playwright MCP browser. */
  browser: boolean;
}

export interface RenderedSettings {
  /** System scope: overrides user and project settings. */
  settings: SettingsObject;
  /** Lowest precedence: users may change these in their own settings. */
  systemDefaults: SettingsObject;
}

/**
 * The two system settings files of a workspace: the admin's files, with the keys the portal
 * depends on (model endpoint, search, no internet features, no telemetry) forced on top. The models
 * come only from the admin's system-defaults.json; without one there is nothing to offer, so that is
 * a QwenConfigError.
 */
export function renderQwenSettings(options: RenderOptions): RenderedSettings {
  const { admin, serviceBaseUrl, browser } = options;

  const defaults = mergeSettings({}, admin.systemDefaults);
  const openai = gatewayProviders(defaults.modelProviders, serviceBaseUrl);
  const firstId = openai.map((provider) => provider.id).find((id): id is string => typeof id === "string" && id.trim() !== "");
  if (firstId === undefined) {
    throw new QwenConfigError(
      `the Qwen Code settings file ${admin.systemDefaultsFile} defines no model: add at least one entry with an "id" under modelProviders.openai`,
    );
  }
  defaults.modelProviders = { openai };
  const model = asObject(defaults.model);
  if (typeof model.name !== "string" || model.name.trim() === "") defaults.model = { ...model, name: firstId };
  defaults.security = mergeSettings(asObject(defaults.security), { auth: { selectedType: "openai" } });
  defaults.$version ??= 4;

  const settings = mergeSettings(admin.settings, {
    general: { enableAutoUpdate: false, preventSystemSleep: false },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false, logPrompts: false },
    model: { catalogRefresh: false },
    security: { auth: { enforcedType: "openai", selectedType: "openai" } },
  });
  settings.$version ??= 4;
  // The admin may list models here too (system scope); they get the same treatment. Without any
  // left the key goes, so an empty list can't hide the models of system-defaults.json.
  if (settings.modelProviders !== undefined) {
    const providers = gatewayProviders(settings.modelProviders, serviceBaseUrl);
    if (providers.length > 0) settings.modelProviders = { openai: providers };
    else delete settings.modelProviders;
  }
  const permissions = asObject(settings.permissions);
  const deny = Array.isArray(permissions.deny) ? permissions.deny.filter((rule): rule is string => typeof rule === "string") : [];
  settings.permissions = { ...permissions, deny: [...new Set([...deny, "web_fetch"])] };
  const tools = asObject(settings.tools);
  delete tools.webSearch; // built-in web search providers need the internet; search goes through the portal
  settings.tools = tools;

  const servers: SettingsObject = { ...asObject(settings.mcpServers) };
  servers.search = {
    httpUrl: `${serviceBaseUrl}/mcp/search`,
    timeout: 60_000,
    trust: true,
    includeTools: ["web_search"],
    alwaysLoadTools: true,
    description: "Private web search. The workspace has no direct internet access, so use this for anything on the web.",
  };
  if (browser) {
    servers.browser = {
      command: "/usr/local/bin/playwright-mcp",
      args: ["--headless", "--isolated", "--no-sandbox", "--executable-path=/usr/bin/chromium", "--output-dir=/workspace/.browser"],
      timeout: 120_000,
      trust: true,
      description: "Headless Chromium for pages served inside this workspace (for example a dev server). It has no internet access.",
    };
  } else {
    delete servers.browser;
  }
  settings.mcpServers = servers;

  return { settings, systemDefaults: defaults };
}

/**
 * Only OpenAI-compatible providers, and only through the gateway (the workspace has no other route):
 * every entry gets the gateway's URL and the placeholder key variable, and no API key at any depth.
 */
function gatewayProviders(modelProviders: unknown, serviceBaseUrl: string): SettingsObject[] {
  const { openai } = asObject(modelProviders);
  const entries = Array.isArray(openai) ? openai.filter(isPlainObject) : [];
  return entries.map((provider) => ({ ...(withoutApiKeys(provider) as SettingsObject), baseUrl: `${serviceBaseUrl}/llm/v1`, envKey: LLM_KEY_ENV }));
}

function withoutApiKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutApiKeys);
  if (!isPlainObject(value)) return value;
  const out: SettingsObject = {};
  for (const [key, item] of Object.entries(value)) if (key !== "apiKey") out[key] = withoutApiKeys(item);
  return out;
}

/** Deep merge for settings: objects merge key by key, anything else (arrays included) is replaced. */
export function mergeSettings(base: SettingsObject, override: SettingsObject): SettingsObject {
  const out: SettingsObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeSettings(current, value) : clone(value);
  }
  return out;
}

function clone(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

function asObject(value: unknown): SettingsObject {
  return isPlainObject(value) ? { ...value } : {};
}

function isPlainObject(value: unknown): value is SettingsObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
