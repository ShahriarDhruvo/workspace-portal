# Per-user workspace images, one target per agent (deploy/lib.sh builds them):
#   --target qwen   Qwen Code's Web Shell (`qwen serve`) on port 4170
#   --target dsh    DeepSeek Harness's web UI (`dsh --profile web`) on port 3080
# Both carry the same everyday dev tools and headless Chromium for the Playwright MCP browser tool,
# and both run under the same container spec (gateway/src/container-spec.ts):
#   * as that user's own UID (WORKSPACE_UID_BASE + user id), with a per-user /etc/passwd and
#     /etc/group bind-mounted read-only, so the images contain no workspace accounts;
#   * read-only root filesystem; only /home/user, /workspace (the user's own storage) and an
#     in-memory, noexec /tmp are writable;
#   * no capabilities, no-new-privileges, memory/CPU/PID limits;
#   * on an internal network whose only reachable address is the gateway, which serves the model
#     and web search. Nothing in here can reach the internet, the LAN or another workspace.
# A user's workspace runs one agent at a time; both use the same /home/user and /workspace.

# ------------------------------------------------------------------ base: tools and headless Chromium
FROM docker.io/library/node:24-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4 AS base

ARG PLAYWRIGHT_MCP_VERSION=0.0.84

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less procps ripgrep tini unzip \
      python3 python3-venv \
      chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

# Mount points: the real content comes from the user's own directories at run time. The base
# image's "node" account goes: workspaces run as their own per-user UID. Without setuid/setgid
# programs nothing in a workspace can gain privileges (no-new-privileges at run time already
# neutralises them; the find removes them outright, and each agent stage repeats it).
RUN mkdir -p /home/user /workspace \
 && (userdel --remove node 2>/dev/null || true) \
 && ! id node 2>/dev/null \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +

ENV HOME=/home/user \
    DO_NOT_TRACK=1 \
    NO_UPDATE_NOTIFIER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /workspace
# The gateway always runs workspaces as the user's own UID; anything else defaults to "nobody", and
# both start scripts refuse to run as root.
USER 65534:65534

# ------------------------------------------------------------------ qwen: Qwen Code Web Shell
FROM base AS qwen
ARG QWEN_CODE_VERSION=0.27.0
USER root
# /etc/workspace-portal/qwen: mount point for the gateway-rendered settings.json and system-defaults.json.
RUN npm install -g --no-fund --no-audit "@qwen-code/qwen-code@${QWEN_CODE_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/* \
 && mkdir -p /etc/workspace-portal/qwen \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --chmod=0755 start-qwen.sh /usr/local/bin/start-qwen
ENV QWEN_CODE_SYSTEM_SETTINGS_PATH=/etc/workspace-portal/qwen/settings.json \
    QWEN_CODE_SYSTEM_DEFAULTS_PATH=/etc/workspace-portal/qwen/system-defaults.json \
    QWEN_TELEMETRY_ENABLED=false \
    QWEN_STREAM_MAX_LIFETIME_MS=3600000
EXPOSE 4170
USER 65534:65534
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-qwen"]

# ------------------------------------------------------------------ dsh: DeepSeek Harness web UI
FROM base AS dsh
ARG DSH_VERSION=0.2.2-rc.1
USER root
# /etc/workspace-portal/dsh: mount point for the gateway-rendered portal.patch.yml.
# /usr/local/share/workspace-portal/dsh/lockdown.patch.yml: the static, version-specific lockdown.
# /usr/local/lib/workspace-portal/dsh-cwd: dsh's launch directory. dsh loads <cwd>/.env at start, so
#   it is an empty, root-owned directory.
# /usr/local/lib/workspace-portal/dsh-documents: the lockdown's workspace-controller documentsDirectory.
#   dsh's first-use default workspace, <it>/deepseek-harness/default-workspace, is a root-owned
#   symlink to /workspace, so the only workspace dsh creates is /workspace itself.
RUN npm install -g --no-fund --no-audit "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/* \
 && mkdir -p /etc/workspace-portal/dsh /usr/local/share/workspace-portal/dsh \
             /usr/local/lib/workspace-portal/dsh-cwd \
             /usr/local/lib/workspace-portal/dsh-documents/deepseek-harness \
 && ln -s /workspace /usr/local/lib/workspace-portal/dsh-documents/deepseek-harness/default-workspace \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --chmod=0755 start-dsh.sh /usr/local/bin/start-dsh
COPY --chmod=0644 dsh/lockdown.patch.yml /usr/local/share/workspace-portal/dsh/lockdown.patch.yml
# DSH_HOME / DSH_AGENTS_HOME: dsh's state (settings, sessions) and skills, in the user's home.
# NARB_DISABLE_NATIVE_CACHE: dsh's native-addon loader otherwise copies its .node files to $TMPDIR
#   and loads them from there, which fails on the noexec /tmp ("failed to map segment"), and dsh
#   does not start.
ENV DSH_HOME=/home/user/.dsh \
    DSH_AGENTS_HOME=/home/user/.agents \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_TELEMETRY_MODE=DISABLED \
    NARB_DISABLE_NATIVE_CACHE=1
EXPOSE 3080
USER 65534:65534
# start-dsh is the entrypoint itself and execs tini once it has stored and dropped the cookie
# secret, so PID 1 (tini) never carries it in its environment.
ENTRYPOINT ["/usr/local/bin/start-dsh"]
