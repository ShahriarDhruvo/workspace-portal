import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_KINDS } from "@portal/db";
import { driverFor } from "./agents/index.ts";
import { ConfigError, DEFAULT_TRUSTED_HOSTS, loadConfig, MIB, parseByteSize } from "./config.ts";

const HOUR = 3_600_000;
const secrets = { GATEWAY_CONTROL_SECRET: "c".repeat(64) };

function problems(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail("expected a ConfigError");
}

test("parseByteSize accepts plain bytes and k/m/g", () => {
  assert.equal(parseByteSize("1536m"), 1536 * MIB);
  assert.equal(parseByteSize("768M"), 768 * MIB);
  assert.equal(parseByteSize("2g"), 2048 * MIB);
  assert.equal(parseByteSize("1.5g"), 1536 * MIB);
  assert.equal(parseByteSize("512k"), 512 * 1024);
  assert.equal(parseByteSize("100mb"), 100 * MIB);
  assert.equal(parseByteSize("1048576"), MIB);
  assert.equal(parseByteSize(" 64m "), 64 * MIB);
  for (const bad of ["", "m", "abc", "-1m", "0", "0m", "1t", "1 gb extra", "1e3"]) {
    assert.equal(parseByteSize(bad), null, bad);
  }
});

test("defaults match .env.example", () => {
  const config = loadConfig(secrets);
  assert.equal(config.dataDir, "/srv/workspace-portal");
  assert.equal(config.dbFile, "/srv/workspace-portal/db/portal.sqlite");
  assert.equal(config.qwenConfigDir, "/srv/workspace-portal/config/qwen");
  assert.equal(config.agentVersionsFile, "/srv/workspace-portal/config/agent-versions.env");
  assert.equal(
    config.imageContextDir,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../workspace-image"),
    "workspace-image/ next to the gateway's code (/app/workspace-image in the container)",
  );
  assert.deepEqual(
    [config.webPort, config.agentBind, config.agentPortBase, config.agentPortCount, config.controlPort, config.servicePort],
    [3000, "0.0.0.0", 3100, 200, 4002, 4001],
  );
  assert.equal(config.controlSecret, "c".repeat(64));
  assert.equal(config.llm.upstreamUrl, "http://127.0.0.1:8080");
  assert.equal(config.llm.apiKey, "");
  assert.deepEqual(config.llm, { upstreamUrl: "http://127.0.0.1:8080", apiKey: "", maxConcurrency: 3, maxConcurrencyPerUser: 2 });
  assert.deepEqual(config.search, {
    url: "http://127.0.0.1:8888",
    authorization: "",
    timeoutMs: 20_000,
    maxConcurrentPerUser: 2,
    fallbackEngines: ["duckduckgo", "swisscows", "privacywall", "mojeek"],
    fallbackBelow: 3,
    cacheMs: 15 * 60_000,
  });
  // Without READER_URL there is no page reader (.env.example sets it for the reader container).
  assert.deepEqual(config.reader, {
    url: "",
    timeoutMs: 60_000,
    policy: "shown",
    trustedHosts: DEFAULT_TRUSTED_HOSTS.split(","),
    pageChars: 20_000,
    cacheMs: 15 * 60_000,
    maxConcurrentPerUser: 2,
  });
  assert.ok(config.reader.trustedHosts.includes("github.com") && config.reader.trustedHosts.includes("docs.rs"));
  assert.deepEqual(config.hostd, { portal: { url: "", token: "" }, llm: { url: "", token: "" } }, "not set up without tokens");
  assert.deepEqual(config.engine, { releaseNotesRepo: "gufo-org/gufo", drainMs: 15 * 60_000 });
  assert.deepEqual(config.workspace, {
    defaultEffort: "low",
    agents: ["qwen", "dsh"],
    defaultVersions: { qwen: "0.27.0", dsh: "0.2.2-rc.1" },
    network: "workspace-portal-ws",
    subnet: "172.29.0.0/16",
    gatewayIp: "172.29.0.1",
    ipRange: "172.29.128.0/17",
    bridge: "br-wportal",
    uidBase: 200_000,
    memoryBytes: 3 * 1024 * MIB,
    nanoCpus: 4e9,
    pidsLimit: 1024,
    shmBytes: 1024 * MIB,
    tmpBytes: 1024 * MIB,
    browser: true,
  });
  assert.equal(config.maxRunning, 4);
  assert.equal(config.idleTimeoutMs, 30 * 60_000);
  assert.equal(config.maxBusyMs, 24 * HOUR);
  assert.equal(config.uploadLimitBytes, 100 * MIB);
});

test("values are parsed and normalised", () => {
  const config = loadConfig({
    ...secrets,
    PORTAL_DATA_DIR: "/data/portal/",
    AGENT_PORT_BASE: "5000",
    AGENT_PORT_COUNT: "10",
    LLM_UPSTREAM_URL: "http://llm.internal:8000/",
    SEARXNG_URL: "https://search.internal/searx/",
    SEARXNG_AUTHORIZATION: " Basic dXNlcjpwYXNz ",
    SEARXNG_TIMEOUT_SECONDS: "5",
    SEARCH_MAX_CONCURRENT_PER_USER: "4",
    SEARCH_FALLBACK_ENGINES: " duckduckgo, swisscows ,duckduckgo",
    SEARCH_FALLBACK_BELOW: "5",
    SEARCH_CACHE_MINUTES: "0",
    READER_URL: "http://127.0.0.1:4003/",
    READER_TIMEOUT_SECONDS: "30",
    READER_URL_POLICY: "ANY",
    READER_TRUSTED_HOSTS: "Docs.Example.com, example.org",
    READER_PAGE_CHARS: "8000",
    READER_CACHE_MINUTES: "5",
    READER_MAX_CONCURRENT_PER_USER: "1",
    WORKSPACE_CPUS: "1.5",
    WORKSPACE_UID_BASE: "300000",
    WORKSPACE_TMP: "256m",
    WORKSPACE_BROWSER: "off",
    IDLE_TIMEOUT_MINUTES: "5",
    MAX_BUSY_HOURS: "0",
  });
  assert.equal(config.dataDir, "/data/portal");
  assert.equal(config.qwenConfigDir, "/data/portal/config/qwen");
  assert.deepEqual([config.agentPortBase, config.agentPortCount], [5000, 10]);
  assert.equal(config.llm.upstreamUrl, "http://llm.internal:8000");
  assert.deepEqual(config.search, {
    url: "https://search.internal/searx",
    authorization: "Basic dXNlcjpwYXNz",
    timeoutMs: 5_000,
    maxConcurrentPerUser: 4,
    fallbackEngines: ["duckduckgo", "swisscows"],
    fallbackBelow: 5,
    cacheMs: 0,
  });
  assert.deepEqual(config.reader, {
    url: "http://127.0.0.1:4003",
    timeoutMs: 30_000,
    policy: "any",
    trustedHosts: ["docs.example.com", "example.org"],
    pageChars: 8000,
    cacheMs: 5 * 60_000,
    maxConcurrentPerUser: 1,
  });
  assert.deepEqual(loadConfig({ ...secrets, READER_TRUSTED_HOSTS: "none" }).reader.trustedHosts, [], "none: no site is open as a whole");
  assert.equal(loadConfig({ ...secrets, READER_TRUSTED_HOSTS: "" }).reader.trustedHosts.length, DEFAULT_TRUSTED_HOSTS.split(",").length, "empty (as docker compose passes an unset value): the built-in list");
  assert.equal(loadConfig({ ...secrets, READER_URL: "off" }).reader.url, "", "off: no page reader");
  assert.deepEqual(loadConfig({ ...secrets, SEARCH_FALLBACK_ENGINES: "none" }).search.fallbackEngines, [], "none: no second try");
  assert.equal(loadConfig({ ...secrets, SEARCH_FALLBACK_ENGINES: "" }).search.fallbackEngines.length, 4, "empty (as docker compose passes an unset value): the four spare engines of searxng/settings.yml");
  assert.equal(config.workspace.nanoCpus, 1.5e9);
  assert.equal(config.workspace.uidBase, 300_000);
  assert.equal(config.workspace.tmpBytes, 256 * MIB);
  assert.equal(config.workspace.browser, false);
  assert.equal(config.idleTimeoutMs, 5 * 60_000);
  assert.equal(config.maxBusyMs, 0, "0 turns the limit off");
});

test("every problem is reported at once", () => {
  assert.deepEqual(
    problems({
      GATEWAY_CONTROL_SECRET: "short",
      AGENT_PORT_BASE: "70000",
      AGENT_PORT_COUNT: "1",
      LLM_MAX_CONCURRENCY: "0",
      PORTAL_DATA_DIR: "data",
      SEARXNG_URL: "ftp://search",
      SEARCH_FALLBACK_ENGINES: "duckduckgo,bad&engine",
      READER_URL: "reader:4003",
      READER_URL_POLICY: "sometimes",
      READER_TRUSTED_HOSTS: "github.com,https://docs.python.org/",
      WORKSPACE_UID_BASE: "1000",
      MAX_BUSY_HOURS: "-1",
    }),
    [
      'PORTAL_DATA_DIR must be an absolute path (got "data")',
      "AGENT_PORT_BASE must be a TCP port (got 70000)",
      'AGENT_PORT_COUNT must be an integer >= 2 (got "1")',
      "GATEWAY_CONTROL_SECRET must be at least 16 characters",
      'LLM_MAX_CONCURRENCY must be an integer >= 1 (got "0")',
      'SEARXNG_URL must be an http(s) URL (got "ftp://search")',
      'SEARCH_FALLBACK_ENGINES must be a comma-separated list of SearXNG engine names (got "bad&engine")',
      'READER_URL must be an http(s) URL (got "reader:4003")',
      'READER_URL_POLICY must be one of shown, any (got "sometimes")',
      'READER_TRUSTED_HOSTS must be a comma-separated list of host names such as docs.python.org (got "https://docs.python.org/")',
      'WORKSPACE_UID_BASE must be an integer >= 100000 (got "1000")',
      'MAX_BUSY_HOURS must be an integer >= 0 (got "-1")',
    ],
  );
  assert.deepEqual(problems({}), ["GATEWAY_CONTROL_SECRET is required (deploy/install.sh generates it in .env)"]);
});

test("models are not configured through the environment any more", () => {
  const config = loadConfig({ ...secrets, LLM_MODEL_ID: "other", LLM_REASONING: "maybe", LLM_INPUT: "audio" });
  assert.equal("model" in config.llm, false, "system-defaults.json is the only source of models");
});

test("WORKSPACE_AGENTS selects the agents; the version variables set their default versions", () => {
  const config = loadConfig({ ...secrets, WORKSPACE_AGENTS: " DSH , qwen,dsh ", DSH_VERSION: "0.3.0", QWEN_CODE_VERSION: "0.28.1-beta.2" });
  assert.deepEqual(config.workspace.agents, ["dsh", "qwen"], "in the admin's order, without repeats");
  assert.deepEqual(config.workspace.defaultVersions, { dsh: "0.3.0", qwen: "0.28.1-beta.2" });
  for (const kind of AGENT_KINDS) {
    const { versionKey } = driverFor(kind).release;
    assert.equal(loadConfig({ ...secrets, [versionKey]: "9.8.7" }).workspace.defaultVersions[kind], "9.8.7", `${kind}: the driver's versionKey is the env variable`);
  }
  assert.deepEqual(loadConfig({ ...secrets, WORKSPACE_AGENTS: "qwen" }).workspace.agents, ["qwen"]);

  assert.deepEqual(problems({ ...secrets, WORKSPACE_AGENTS: "qwen,claude" }), [
    'WORKSPACE_AGENTS must list one or more of qwen, dsh, comma-separated (got "qwen,claude")',
  ]);
  assert.deepEqual(problems({ ...secrets, WORKSPACE_AGENTS: " , " }), ['WORKSPACE_AGENTS must list one or more of qwen, dsh, comma-separated (got ",")']);
  // An image tag is built from it: nothing but a version.
  assert.deepEqual(problems({ ...secrets, DSH_VERSION: "latest; rm -rf" }), ['DSH_VERSION must be a version such as 0.27.0 (got "latest; rm -rf")']);
});

test("WORKSPACE_IMAGE_CONTEXT moves the build context; it must be absolute", () => {
  assert.equal(loadConfig({ ...secrets, WORKSPACE_IMAGE_CONTEXT: "/opt/portal/workspace-image/" }).imageContextDir, "/opt/portal/workspace-image");
  assert.deepEqual(problems({ ...secrets, WORKSPACE_IMAGE_CONTEXT: "workspace-image" }), ['WORKSPACE_IMAGE_CONTEXT must be an absolute path (got "workspace-image")']);
});

test("SEARXNG_AUTHORIZATION must be one header value", () => {
  assert.deepEqual(problems({ ...secrets, SEARXNG_AUTHORIZATION: "Basic abc\r\nX-Injected: 1" }), [
    "SEARXNG_AUTHORIZATION must be a single header value",
  ]);
});

test("the workspace port range must fit and must not overlap the gateway's other ports", () => {
  assert.deepEqual(problems({ ...secrets, AGENT_PORT_BASE: "65400", AGENT_PORT_COUNT: "200" }), [
    "AGENT_PORT_BASE + AGENT_PORT_COUNT must stay below 65536 (got 65400 + 200)",
  ]);
  assert.equal(loadConfig({ ...secrets, AGENT_PORT_BASE: "65336", AGENT_PORT_COUNT: "200" }).agentPortBase, 65336, "the last port is 65535");

  const overlap = "WEB_PORT, CONTROL_PORT and SERVICE_PORT must lie outside the workspace port range (AGENT_PORT_BASE + 1 … AGENT_PORT_BASE + AGENT_PORT_COUNT - 1)";
  for (const [name, port] of [["WEB_PORT", "3101"], ["CONTROL_PORT", "3299"], ["SERVICE_PORT", "3150"]] as const) {
    assert.deepEqual(problems({ ...secrets, [name]: port }), [overlap], `${name}=${port}`);
  }
  // The base itself and base + count are not workspace ports.
  const edges = loadConfig({ ...secrets, WEB_PORT: "3100", CONTROL_PORT: "3300" });
  assert.deepEqual([edges.webPort, edges.controlPort], [3100, 3300]);
});

test("portal-hostd: a token sets a host up; the portal's address defaults to this machine, the LLM server's is required", () => {
  const token = "t".repeat(64);
  assert.deepEqual(loadConfig({ ...secrets, HOSTD_PORTAL_TOKEN: token }).hostd.portal, { url: "http://127.0.0.1:9180", token });
  assert.deepEqual(loadConfig({ ...secrets, HOSTD_LLM_URL: "http://192.168.10.14:9180/", HOSTD_LLM_TOKEN: token }).hostd.llm, {
    url: "http://192.168.10.14:9180",
    token,
  });
  assert.deepEqual(loadConfig({ ...secrets, HOSTD_LLM_URL: "http://192.168.10.14:9180" }).hostd.llm, { url: "", token: "" }, "no token: not set up");
  assert.deepEqual(loadConfig({ ...secrets, HOSTD_PORTAL_URL: "off", HOSTD_PORTAL_TOKEN: token }).hostd.portal, { url: "", token: "" });
  assert.deepEqual(problems({ ...secrets, HOSTD_LLM_TOKEN: token }), ["HOSTD_LLM_TOKEN is set, so HOSTD_LLM_URL must be the http:// address of that portal-hostd"]);
  assert.deepEqual(problems({ ...secrets, HOSTD_PORTAL_TOKEN: "short" }), ["HOSTD_PORTAL_TOKEN must be the portal-hostd token: at least 32 characters, no spaces"]);
  assert.deepEqual(problems({ ...secrets, HOSTD_LLM_URL: "ftp://x", HOSTD_LLM_TOKEN: token }), [
    'HOSTD_LLM_URL must be an http(s) URL (got "ftp://x")',
    "HOSTD_LLM_TOKEN is set, so HOSTD_LLM_URL must be the http:// address of that portal-hostd",
  ]);
});

test("ENGINE_RELEASE_NOTES_REPO names a GitHub repository or none; ENGINE_DRAIN_MINUTES is at least one", () => {
  assert.equal(loadConfig({ ...secrets, ENGINE_RELEASE_NOTES_REPO: "none" }).engine.releaseNotesRepo, "");
  assert.equal(loadConfig({ ...secrets, ENGINE_RELEASE_NOTES_REPO: "ggml-org/llama.cpp" }).engine.releaseNotesRepo, "ggml-org/llama.cpp");
  assert.deepEqual(problems({ ...secrets, ENGINE_RELEASE_NOTES_REPO: "https://github.com/x/y" }), [
    'ENGINE_RELEASE_NOTES_REPO must be a GitHub repository such as gufo-org/gufo, or none (got "https://github.com/x/y")',
  ]);
  assert.equal(loadConfig({ ...secrets, ENGINE_DRAIN_MINUTES: "2" }).engine.drainMs, 120_000);
  assert.deepEqual(problems({ ...secrets, ENGINE_DRAIN_MINUTES: "0" }), ['ENGINE_DRAIN_MINUTES must be an integer >= 1 (got "0")']);
});
