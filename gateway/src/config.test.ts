import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_KINDS, agentPortFor, agentPortRange, WORKSPACE_BLOCK, WORKSPACE_KINDS, WORKSPACE_REFS, workspaceNumber } from "@portal/core";
import { driverFor } from "@portal/harnesses";
import { ConfigError, DEFAULT_TRUSTED_HOSTS, isPublicIpv4, loadConfig, MIB, NOT_PUBLIC, parseByteSize, PREVIEW_PORT_OFFSET, workspacePorts } from "./config.ts";

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
  assert.equal(config.modelsDir, "/srv/workspace-portal/config/models");
  assert.equal(config.agentVersionsFile, "/srv/workspace-portal/config/agent-versions.env");
  assert.equal(config.imageContextDir, fileURLToPath(new URL("../../", import.meta.url)), "/app in the container, where container/image and harnesses are mounted");
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
    AGENT_PORT_BASE: "7000",
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
  assert.equal(config.modelsDir, "/data/portal/config/models");
  assert.deepEqual([config.agentPortBase, config.agentPortCount], [7000, 10]);
  assert.equal(config.llm.upstreamUrl, "http://llm.internal:8000");
  assert.deepEqual(config.search, {
    url: "https://search.internal/searx",
    authorization: "Basic dXNlcjpwYXNz",
    timeoutMs: 5_000,
    maxConcurrentPerUser: 4,
    fallbackEngines: ["duckduckgo", "swisscows"],
    fallbackBelow: 5,
    cacheMs: 0,
    exa: false,
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
  assert.deepEqual(["on", "off", ""].map((value) => loadConfig({ ...secrets, EXA_SEARCH: value }).search.exa), [true, false, false], "Exa is asked only when the setting says so");
  assert.equal(loadConfig({ ...secrets, SEARCH_FALLBACK_ENGINES: "" }).search.fallbackEngines.length, 4, "empty: the four spare engines of searxng/settings.yml");
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

test("WORKSPACE_AGENTS selects the agents; the version variables set their default versions", () => {
  const config = loadConfig({ ...secrets, WORKSPACE_AGENTS: " DSH , qwen,dsh ", DSH_VERSION: "0.3.0", QWEN_CODE_VERSION: "0.28.1-beta.2" });
  assert.deepEqual(config.workspace.agents, ["dsh", "qwen"], "in the admin's order, without repeats");
  assert.deepEqual(config.workspace.defaultVersions, { dsh: "0.3.0", qwen: "0.28.1-beta.2", opencode: "2.4.1" });
  for (const kind of AGENT_KINDS) {
    const { versionKey } = driverFor(kind).release;
    assert.equal(loadConfig({ ...secrets, [versionKey]: "9.8.7" }).workspace.defaultVersions[kind], "9.8.7", `${kind}: the driver's versionKey is the env variable`);
  }
  assert.deepEqual(loadConfig({ ...secrets, WORKSPACE_AGENTS: "qwen" }).workspace.agents, ["qwen"]);
  // Of an agent that is not enabled nothing is built or started: its version is not read.
  assert.equal(loadConfig({ ...secrets, WORKSPACE_AGENTS: "opencode", QWEN_CODE_VERSION: "not a version" }).workspace.defaultVersions.qwen, driverFor("qwen").release.defaultVersion);

  assert.deepEqual(problems({ ...secrets, WORKSPACE_AGENTS: "qwen,claude" }), [
    'WORKSPACE_AGENTS must list one or more of qwen, dsh, opencode, comma-separated (got "qwen,claude")',
  ]);
  assert.deepEqual(problems({ ...secrets, WORKSPACE_AGENTS: " , " }), ['WORKSPACE_AGENTS must list one or more of qwen, dsh, opencode, comma-separated (got ",")']);
  // An image tag is built from it: nothing but a version.
  assert.deepEqual(problems({ ...secrets, DSH_VERSION: "latest; rm -rf" }), ['DSH_VERSION must be a version such as 0.27.0 (got "latest; rm -rf")']);
});

test("SEARXNG_AUTHORIZATION must be one header value", () => {
  assert.deepEqual(problems({ ...secrets, SEARXNG_AUTHORIZATION: "Basic abc\r\nX-Injected: 1" }), [
    "SEARXNG_AUTHORIZATION must be a single header value",
  ]);
});

test("the workspace ports and their previews must fit, and keep clear of the gateway's other ports", () => {
  // By default 20 ports for each of users 1-99, and their previews 10000 higher.
  const defaults = loadConfig(secrets);
  assert.deepEqual([defaults.agentPortBase, defaults.agentPortCount], [12_000, 100]);

  assert.deepEqual(problems({ ...secrets, AGENT_PORT_COUNT: "501" }), [
    "AGENT_PORT_COUNT must be at most 500: each user has 20 workspace ports, and their preview ports are 10000 higher (got 501)",
  ]);
  assert.equal(loadConfig({ ...secrets, AGENT_PORT_COUNT: "500" }).agentPortCount, 500, "the last workspace port is the one before the first preview port");
  assert.deepEqual(problems({ ...secrets, AGENT_PORT_BASE: "53537" }), [
    "the preview ports would end at 65536, past 65535: lower AGENT_PORT_BASE (53537) or AGENT_PORT_COUNT (100); each user has 20 workspace ports, and their preview ports are 10000 higher",
  ]);
  assert.equal(loadConfig({ ...secrets, AGENT_PORT_BASE: "53536" }).agentPortBase, 53_536, "the last preview port is 65535");

  const inside = (name: string, port: number): string =>
    `${name} (${port}) must lie outside the workspace ports (12020-13999) and their preview ports (22020-23999): move it, or AGENT_PORT_BASE`;
  for (const [name, port] of [["WEB_PORT", 12_020], ["CONTROL_PORT", 13_999], ["SERVICE_PORT", 22_020], ["WEB_PORT", 23_999]] as const) {
    assert.deepEqual(problems({ ...secrets, [name]: String(port) }), [inside(name, port)]);
  }
  // A port no workspace has yet is the next agent's.
  assert.deepEqual(problems({ ...secrets, CONTROL_PORT: "12039" }), [inside("CONTROL_PORT", 12_039)]);
  assert.deepEqual(problems({ ...secrets, WEB_PORT: "13000", SERVICE_PORT: "23000" }), [inside("WEB_PORT", 13_000), inside("SERVICE_PORT", 23_000)]);
  // The base itself and the first ports after it are nobody's (there is no user 0), nor is what follows each range.
  const edges = loadConfig({ ...secrets, WEB_PORT: "12000", CONTROL_PORT: "12019", SERVICE_PORT: "14000" });
  assert.deepEqual([edges.webPort, edges.controlPort, edges.servicePort], [12_000, 12_019, 14_000]);
});

test("a workspace is never served on a port that browsers refuse to open", () => {
  assert.deepEqual(problems({ ...secrets, AGENT_PORT_BASE: "5900", AGENT_PORT_COUNT: "10" }), [
    "browsers refuse to open port 6000, which AGENT_PORT_BASE (5900) puts among the workspace ports (5920-6099) or their preview ports (15920-16099): choose another base, such as 12000",
  ]);
  // A preview port counts as much: 10080 is one of them.
  assert.deepEqual(problems({ ...secrets, AGENT_PORT_BASE: "50", AGENT_PORT_COUNT: "2", WEB_PORT: "3000" }), [
    "browsers refuse to open port 10080, which AGENT_PORT_BASE (50) puts among the workspace ports (70-89) or their preview ports (10070-10089): choose another base, such as 12000",
  ]);
  // What an install from before every workspace had its own port has in its .env: its own ports are in the way too.
  assert.deepEqual(problems({ ...secrets, AGENT_PORT_BASE: "3100", AGENT_PORT_COUNT: "200" }), [
    "CONTROL_PORT (4002) must lie outside the workspace ports (3120-7099) and their preview ports (13120-17099): move it, or AGENT_PORT_BASE",
    "SERVICE_PORT (4001) must lie outside the workspace ports (3120-7099) and their preview ports (13120-17099): move it, or AGENT_PORT_BASE",
    "browsers refuse to open port 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, which AGENT_PORT_BASE (3100) puts among the workspace ports (3120-7099) or their preview ports (13120-17099): choose another base, such as 12000",
  ]);
  for (const count of ["2", "100", "500"]) assert.doesNotThrow(() => loadConfig({ ...secrets, AGENT_PORT_COUNT: count }), `the default base suits AGENT_PORT_COUNT=${count}`);
});

test("the gateway, Qwen Code's and DeepSeek Harness's web previews and the deploy scripts agree on where the preview ports are", () => {
  const source = (file: string): string => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  assert.match(source("harnesses/qwen/image/trim-web-shell.mjs"), new RegExp(`^const PREVIEW_PORT_OFFSET = ${PREVIEW_PORT_OFFSET};$`, "m"));
  assert.match(source("harnesses/dsh/image/web-preview.mjs"), new RegExp(`^const PREVIEW_PORT_OFFSET = ${PREVIEW_PORT_OFFSET};$`, "m"));
  assert.match(source("deploy/lib.sh"), new RegExp(`^PREVIEW_PORT_OFFSET=${PREVIEW_PORT_OFFSET}$`, "m"));
});

test("the deploy scripts number a workspace as the gateway does", () => {
  const lib = fileURLToPath(new URL("../../deploy/lib.sh", import.meta.url));
  const bash = (script: string): string => execFileSync("bash", ["-c", `source "$1"; ${script}`, "bash", lib], { encoding: "utf8" }).trim();
  assert.equal(bash('echo "$WORKSPACE_BLOCK"'), String(WORKSPACE_BLOCK));
  assert.deepEqual(bash('echo "${AGENTS[@]}"').split(" "), [...AGENT_KINDS], "the agents, in the order that numbers their workspaces");
  assert.deepEqual(bash('echo "${WORKSPACE_KINDS[@]}"').split(" "), [...WORKSPACE_KINDS]);
  for (const userId of [1, 7, 99]) {
    const numbers = bash(WORKSPACE_REFS.map((ref) => `workspace_number ${userId} ${ref.agent} ${ref.kind}; echo`).join("; ")).split("\n").map(Number);
    assert.deepEqual(numbers, WORKSPACE_REFS.map((ref) => workspaceNumber(userId, ref)), `user ${userId}`);
  }
  // .env.example's settings: every port a workspace or its preview has, and the two ranges they lie in.
  const env = fileURLToPath(new URL("../../.env.example", import.meta.url));
  const config = loadConfig(secrets);
  const served: number[] = [];
  for (const offset of [0, PREVIEW_PORT_OFFSET]) {
    for (let userId = 1; userId < config.agentPortCount; userId++) {
      for (const ref of WORKSPACE_REFS) served.push(agentPortFor(config.agentPortBase, config.agentPortCount, userId, ref)! + offset);
    }
  }
  assert.deepEqual(bash(`ENV_FILE=${JSON.stringify(env)}; workspace_ports "\${AGENTS[@]}"`).split("\n").map(Number), served);
  // Of those, the gateway serves the enabled agents'.
  for (const enabled of ["opencode", "dsh,qwen"]) {
    const listening = workspacePorts(loadConfig({ ...secrets, WORKSPACE_AGENTS: enabled }));
    const mapped = bash(`ENV_FILE=${JSON.stringify(env)}; workspace_ports ${enabled.replace(",", " ")}`).split("\n").map(Number);
    assert.deepEqual([...mapped].sort((a, b) => a - b), [...listening, ...listening.map((port) => port + PREVIEW_PORT_OFFSET)].sort((a, b) => a - b), enabled);
  }
  assert.deepEqual(workspacePorts(config), served.slice(0, served.length / 2), "every agent enabled: every workspace's port");
  const { first, last } = agentPortRange(config.agentPortBase, config.agentPortCount);
  assert.equal(bash(`ENV_FILE=${JSON.stringify(env)}; port_ranges`), `${first}-${last} ${first + PREVIEW_PORT_OFFSET}-${last + PREVIEW_PORT_OFFSET}`);
});

test("each kind has a network, bridge and subnet of its own", () => {
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

test("the Online workspaces' resolvers must be public; the workspaces' UIDs stay below systemd's foreign range", () => {
  for (const address of ["192.168.1.1", "10.0.0.53", "100.100.100.100", "127.0.0.53", "172.29.0.1", "169.254.169.253", "0.0.0.0"]) {
    assert.deepEqual(
      problems({ ...secrets, ONLINE_DNS_2: address }),
      [`ONLINE_DNS_2 (${address}) must be a public resolver, such as 1.1.1.1 or 9.9.9.9: the Online workspaces may reach no private address`],
      address,
    );
  }
  assert.deepEqual(loadConfig({ ...secrets, ONLINE_DNS_1: "8.8.8.8", ONLINE_DNS_2: "208.67.222.222" }).workspace.kinds.online.dns, ["8.8.8.8", "208.67.222.222"]);
  // 2147352576 = 0x7FFE0000, where systemd's foreign UID range begins. Each of the 100 users has 20 UIDs.
  assert.deepEqual(problems({ ...secrets, WORKSPACE_UID_BASE: "2147350577" }), [
    "the workspaces' UIDs would end at 2147352576, past 2147352575: lower WORKSPACE_UID_BASE (2147350577) or AGENT_PORT_COUNT (100)",
  ]);
  assert.equal(loadConfig({ ...secrets, WORKSPACE_UID_BASE: "2147350576" }).workspace.uidBase, 2_147_350_576, "the last UID is 2147352575");
  assert.equal(loadConfig(secrets).workspace.uidBase, 200_000);
});

test("NOT_PUBLIC is the firewall's not_public set; isPublicIpv4 is its complement", () => {
  const firewall = fileURLToPath(new URL("../../container/security/firewall.sh", import.meta.url));
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
  assert.deepEqual(problems({ ...secrets, ONLINE_WORKSPACES: "off", ONLINE_NETWORK: "workspace-portal-ws" }).length, 1, "so turning it on later can't break isolation");
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
