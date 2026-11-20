import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_KINDS } from "@portal/core";
import { driverFor } from "./agents/index.ts";
import { ConfigError, DEFAULT_TRUSTED_HOSTS, isPublicIpv4, loadConfig, MIB, NOT_PUBLIC, parseByteSize, PREVIEW_PORT_OFFSET } from "./config.ts";

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

test("the defaults are .env.example's", () => {
  const example = fs.readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const settings = Object.fromEntries(Array.from(example.matchAll(/^([A-Z0-9_]+)=(.*)$/gm), ([, key, value]) => [key, value]));
  const config = loadConfig(secrets);
  assert.deepEqual(config, loadConfig({ ...settings, ...secrets }));
  assert.equal(config.dbFile, "/srv/workspace-portal/db/portal.sqlite");
  assert.equal(config.qwenConfigDir, "/srv/workspace-portal/config/qwen");
  assert.equal(config.agentVersionsFile, "/srv/workspace-portal/config/agent-versions.env");
  assert.equal(config.imageContextDir, fileURLToPath(new URL("../../workspace-image", import.meta.url)), "/app/workspace-image in the container");
  // What both sides of the comparison above derive alike: a unit, or a default that .env.example leaves unset.
  assert.deepEqual(
    {
      controlSecret: config.controlSecret,
      agentBind: config.agentBind,
      llm: [config.llm.maxConcurrency, config.llm.maxConcurrencyPerUser],
      urls: { search: config.search.url, reader: config.reader.url },
      trustsGithub: config.reader.trustedHosts.includes("github.com"),
      workspace: [config.workspace.memoryBytes, config.workspace.shmBytes, config.workspace.pidsLimit],
      limits: [config.maxRunning, config.maxBusyMs, config.uploadLimitBytes],
    },
    {
      controlSecret: secrets.GATEWAY_CONTROL_SECRET,
      agentBind: "0.0.0.0",
      llm: [3, 2],
      urls: { search: "http://127.0.0.1:8888", reader: "" },
      trustsGithub: true,
      workspace: [3072 * MIB, 1024 * MIB, 1024],
      limits: [4, 24 * 3_600_000, 10240 * MIB],
    },
  );
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
    ONLINE_UID_BASE: "400000",
    WORKSPACE_TMP: "256m",
    WORKSPACE_BROWSER: "off",
    IDLE_TIMEOUT_MINUTES: "5",
    MAX_BUSY_HOURS: "0",
  });
  assert.equal(config.dataDir, "/data/portal");
  assert.equal(config.qwenConfigDir, "/data/portal/config/qwen");
  assert.deepEqual([config.workspace.kinds.private.agentPortBase, config.agentPortCount], [5000, 10]);
  assert.equal(config.workspace.kinds.online.agentPortBase, 5010, "Online's ports follow Private's by default");
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
  assert.equal(loadConfig({ ...secrets, READER_TRUSTED_HOSTS: "" }).reader.trustedHosts.length, DEFAULT_TRUSTED_HOSTS.split(",").length, "empty: the built-in list");
  assert.equal(loadConfig({ ...secrets, READER_URL: "off" }).reader.url, "", "off: no page reader");
  assert.deepEqual(loadConfig({ ...secrets, SEARCH_FALLBACK_ENGINES: "none" }).search.fallbackEngines, [], "none: no second try");
  assert.equal(loadConfig({ ...secrets, SEARCH_FALLBACK_ENGINES: "" }).search.fallbackEngines.length, 4, "empty: the four spare engines of searxng/settings.yml");
  assert.equal(config.workspace.nanoCpus, 1.5e9);
  assert.equal(config.workspace.kinds.private.uidBase, 300_000);
  assert.equal(config.workspace.kinds.online.uidBase, 400_000);
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

test("SEARXNG_AUTHORIZATION must be one header value", () => {
  assert.deepEqual(problems({ ...secrets, SEARXNG_AUTHORIZATION: "Basic abc\r\nX-Injected: 1" }), [
    "SEARXNG_AUTHORIZATION must be a single header value",
  ]);
});

test("the workspace port ranges must fit and must not overlap each other or the gateway's other ports", () => {
  assert.deepEqual(problems({ ...secrets, AGENT_PORT_BASE: "65400", AGENT_PORT_COUNT: "200", ONLINE_AGENT_PORT_BASE: "5000" }), [
    "AGENT_PORT_BASE + AGENT_PORT_COUNT must stay below 65536 (got 65400 + 200)",
  ]);
  assert.deepEqual(problems({ ...secrets, ONLINE_AGENT_PORT_BASE: "65400" }), ["ONLINE_AGENT_PORT_BASE + AGENT_PORT_COUNT must stay below 65536 (got 65400 + 200)"]);
  // The preview ports are the workspace ports + PREVIEW_PORT_OFFSET: they must fit too.
  assert.deepEqual(problems({ ...secrets, AGENT_PORT_BASE: "64400", AGENT_PORT_COUNT: "200", ONLINE_AGENT_PORT_BASE: "5000" }), [
    "AGENT_PORT_BASE + 1000 + AGENT_PORT_COUNT must stay below 65536: the preview ports are the workspace ports + 1000 (got 64400 + 200)",
  ]);
  const edge = loadConfig({ ...secrets, AGENT_PORT_BASE: "64336", AGENT_PORT_COUNT: "200", ONLINE_AGENT_PORT_BASE: "5000" });
  assert.equal(edge.workspace.kinds.private.agentPortBase, 64336, "the last preview port is 65535");

  const overlap = (key: string, first: number, last: number): string =>
    `WEB_PORT, CONTROL_PORT and SERVICE_PORT must lie outside the workspace port range (${key} + 1 … ${key} + AGENT_PORT_COUNT - 1: ${first}-${last})`;
  for (const [name, port] of [["WEB_PORT", "3101"], ["CONTROL_PORT", "3299"], ["SERVICE_PORT", "3150"]] as const) {
    assert.deepEqual(problems({ ...secrets, [name]: port }), [overlap("AGENT_PORT_BASE", 3101, 3299)], `${name}=${port}`);
  }
  for (const [name, port] of [["WEB_PORT", "3301"], ["SERVICE_PORT", "3499"]] as const) {
    assert.deepEqual(problems({ ...secrets, [name]: port }), [overlap("ONLINE_AGENT_PORT_BASE", 3301, 3499)], `${name}=${port}`);
  }
  for (const [name, port] of [["WEB_PORT", "4101"], ["CONTROL_PORT", "4499"]] as const) {
    assert.equal(problems({ ...secrets, [name]: port }).length, 1, `${name}=${port}: a preview port`);
    assert.match(problems({ ...secrets, [name]: port })[0]!, /must lie outside the preview port range/);
  }
  // A preview range must not meet a workspace range either: Online's workspace ports where Private's previews are.
  assert.deepEqual(problems({ ...secrets, ONLINE_AGENT_PORT_BASE: "4150" }), [
    "the Online workspace ports (4151-4349) and the Private preview ports (4101-4299) overlap: each needs ports of its own (the preview ports are the workspace ports + 1000; set AGENT_PORT_BASE, ONLINE_AGENT_PORT_BASE or AGENT_PORT_COUNT so they don't meet)",
  ]);
  // The base itself and base + count are not workspace ports.
  const edges = loadConfig({ ...secrets, WEB_PORT: "3100", CONTROL_PORT: "3300" });
  assert.deepEqual([edges.webPort, edges.controlPort], [3100, 3300]);

  // A port says the user and the kind: the two ranges must not share one.
  const sharing =
    "the Private and Online workspace port ranges overlap (AGENT_PORT_BASE 3100, ONLINE_AGENT_PORT_BASE 3250, AGENT_PORT_COUNT 200): each kind needs ports of its own";
  assert.deepEqual(problems({ ...secrets, ONLINE_AGENT_PORT_BASE: "3250" }), [sharing]);
  assert.deepEqual(problems({ ...secrets, ONLINE_AGENT_PORT_BASE: "3298" }).length, 1, "one shared port is one too many");
  assert.equal(loadConfig({ ...secrets, ONLINE_AGENT_PORT_BASE: "3299" }).workspace.kinds.online.agentPortBase, 3299, "the ranges may touch");
  assert.equal(loadConfig({ ...secrets, ONLINE_AGENT_PORT_BASE: "2700" }).workspace.kinds.online.agentPortBase, 2700, "Online's may lie below Private's");
  assert.equal(loadConfig({ ...secrets, AGENT_PORT_COUNT: "50" }).workspace.kinds.online.agentPortBase, 3150, "by default right after Private's");
  assert.equal(problems({ ...secrets, AGENT_PORT_COUNT: "9007199254740991" })[1], "ONLINE_AGENT_PORT_BASE must be a TCP port (got 9007199254744092)", "a default it refuses is named too");
});

test("the gateway, the Web Shell's Web preview and the deploy scripts agree on where the preview ports are", () => {
  const source = (file: string): string => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  assert.match(source("workspace-image/qwen/trim-web-shell.mjs"), new RegExp(`^const PREVIEW_PORT_OFFSET = ${PREVIEW_PORT_OFFSET};$`, "m"));
  assert.match(source("deploy/lib.sh"), new RegExp(`^PREVIEW_PORT_OFFSET=${PREVIEW_PORT_OFFSET}$`, "m"));
});

test("each kind has a network, bridge, subnet and UID range of its own", () => {
  assert.deepEqual(problems({ ...secrets, ONLINE_UID_BASE: "200150" }), [
    "the Private and Online workspace UID ranges overlap (WORKSPACE_UID_BASE 200000, ONLINE_UID_BASE 200150, AGENT_PORT_COUNT 200): the bases must be at least AGENT_PORT_COUNT apart",
  ]);
  assert.equal(loadConfig({ ...secrets, ONLINE_UID_BASE: "200199" }).workspace.kinds.online.uidBase, 200_199, "no UID in common");
  assert.deepEqual(problems({ ...secrets, ONLINE_NETWORK: "workspace-portal-ws" }), ['WORKSPACE_NETWORK and ONLINE_NETWORK must differ (both "workspace-portal-ws")']);
  assert.deepEqual(problems({ ...secrets, ONLINE_BRIDGE: "br-wportal" }), ['WORKSPACE_BRIDGE and ONLINE_BRIDGE must differ (both "br-wportal")']);
  assert.deepEqual(problems({ ...secrets, ONLINE_SUBNET: "172.29.128.0/24", ONLINE_GATEWAY_IP: "172.29.128.1", ONLINE_IP_RANGE: "172.29.128.128/25" }), [
    "WORKSPACE_SUBNET (172.29.0.0/16) and ONLINE_SUBNET (172.29.128.0/24) must not overlap",
  ]);
  assert.deepEqual(problems({ ...secrets, ONLINE_SUBNET: "172.16.0.0/12", ONLINE_GATEWAY_IP: "172.16.0.1", ONLINE_IP_RANGE: "172.16.128.0/17" }), [
    "WORKSPACE_SUBNET (172.29.0.0/16) and ONLINE_SUBNET (172.16.0.0/12) must not overlap",
  ]);
  assert.deepEqual(problems({ ...secrets, ONLINE_GATEWAY_IP: "172.29.0.1" }), ["ONLINE_GATEWAY_IP (172.29.0.1) must lie inside ONLINE_SUBNET (172.28.0.0/16)"]);
  assert.deepEqual(problems({ ...secrets, WORKSPACE_IP_RANGE: "172.28.128.0/17" }), ["WORKSPACE_IP_RANGE (172.28.128.0/17) must lie inside WORKSPACE_SUBNET (172.29.0.0/16)"]);
  assert.deepEqual(problems({ ...secrets, ONLINE_IP_RANGE: "172.28.0.0/15" }), ["ONLINE_IP_RANGE (172.28.0.0/15) must lie inside ONLINE_SUBNET (172.28.0.0/16)"]);
  assert.deepEqual(problems({ ...secrets, ONLINE_DNS_1: "one.one.one.one" }), ['ONLINE_DNS_1 must be an IPv4 address (got "one.one.one.one")']);
});

test("the Online workspaces' resolvers must be public; the UIDs stay below systemd's foreign range", () => {
  for (const address of ["192.168.1.1", "10.0.0.53", "100.100.100.100", "127.0.0.53", "172.29.0.1", "169.254.169.253", "0.0.0.0"]) {
    assert.deepEqual(
      problems({ ...secrets, ONLINE_DNS_2: address }),
      [`ONLINE_DNS_2 (${address}) must be a public resolver, such as 1.1.1.1 or 9.9.9.9: the Online workspaces may reach no private address`],
      address,
    );
  }
  assert.deepEqual(loadConfig({ ...secrets, ONLINE_DNS_1: "8.8.8.8", ONLINE_DNS_2: "208.67.222.222" }).workspace.kinds.online.dns, ["8.8.8.8", "208.67.222.222"]);
  // 2147352576 = 0x7FFE0000, where systemd's foreign UID range begins.
  assert.deepEqual(problems({ ...secrets, ONLINE_UID_BASE: "2147352377" }), ["ONLINE_UID_BASE + AGENT_PORT_COUNT must stay below 2147352576 (got 2147352377 + 200)"]);
  assert.equal(loadConfig({ ...secrets, ONLINE_UID_BASE: "2147352376" }).workspace.kinds.online.uidBase, 2_147_352_376, "the last UID is 2147352575");
  assert.deepEqual(problems({ ...secrets, WORKSPACE_UID_BASE: "4294967000" }), ["WORKSPACE_UID_BASE + AGENT_PORT_COUNT must stay below 2147352576 (got 4294967000 + 200)"]);
});

test("NOT_PUBLIC is the firewall's not_public set; isPublicIpv4 is its complement", () => {
  const firewall = fileURLToPath(new URL("../../deploy/firewall.sh", import.meta.url));
  assert.deepEqual(execFileSync("bash", [firewall, "not-public"], { encoding: "utf8" }).trim().split("\n"), [...NOT_PUBLIC]);
  for (const address of ["1.1.1.1", "9.9.9.9", "8.8.8.8", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "223.255.255.255"]) assert.equal(isPublicIpv4(address), true, address);
  for (const address of ["10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.10.11", "198.18.0.1", "224.0.0.1", "255.255.255.255", "example.com", "::1"]) {
    assert.equal(isPublicIpv4(address), false, address);
  }
});

test("ONLINE_WORKSPACES switches Online workspaces off for the whole portal; its settings are checked all the same", () => {
  assert.equal(loadConfig({ ...secrets, ONLINE_WORKSPACES: "off" }).workspace.onlineEnabled, false);
  assert.equal(loadConfig({ ...secrets, ONLINE_WORKSPACES: "on" }).workspace.onlineEnabled, true);
  assert.equal(loadConfig({ ...secrets, ONLINE_WORKSPACES: "" }).workspace.onlineEnabled, true, "empty: on");
  assert.deepEqual(problems({ ...secrets, ONLINE_WORKSPACES: "maybe" }), ['ONLINE_WORKSPACES must be true or false (got "maybe")']);
  assert.deepEqual(problems({ ...secrets, ONLINE_WORKSPACES: "off", ONLINE_AGENT_PORT_BASE: "3200" }).length, 1, "so turning it on later can't break isolation");
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
