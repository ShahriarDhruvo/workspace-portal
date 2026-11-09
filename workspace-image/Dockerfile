# Per-user Qwen Code workspace: `qwen serve` (the Qwen Code Web Shell), everyday dev tools, and
# headless Chromium for the Playwright MCP browser tool. One container per user.
#
# How the gateway runs it (see gateway/src/container-spec.ts):
#   * as that user's own UID (WORKSPACE_UID_BASE + user id), with a per-user /etc/passwd and
#     /etc/group bind-mounted read-only, so the image itself contains no workspace accounts;
#   * read-only root filesystem; only /home/user, /workspace (the user's own storage) and an
#     in-memory /tmp are writable;
#   * no capabilities, no-new-privileges, memory/CPU/PID limits;
#   * on an internal network whose only reachable address is the gateway, which serves the model
#     and web search. Nothing in here can reach the internet, the LAN or another workspace.
FROM docker.io/library/node:24-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4

ARG QWEN_CODE_VERSION=0.27.0
ARG PLAYWRIGHT_MCP_VERSION=0.0.84

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less procps ripgrep tini unzip \
      python3 python3-venv \
      chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit \
      "@qwen-code/qwen-code@${QWEN_CODE_VERSION}" \
      "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

# Mount points. The real content comes from the user's own directories at run time.
RUN mkdir -p /home/user /workspace /etc/workspace-portal/qwen \
 && userdel --remove node 2>/dev/null || true

COPY --chmod=0755 start-workspace.sh /usr/local/bin/start-workspace

ENV HOME=/home/user \
    QWEN_CODE_SYSTEM_SETTINGS_PATH=/etc/workspace-portal/qwen/settings.json \
    QWEN_CODE_SYSTEM_DEFAULTS_PATH=/etc/workspace-portal/qwen/system-defaults.json \
    QWEN_TELEMETRY_ENABLED=false \
    QWEN_STREAM_MAX_LIFETIME_MS=3600000 \
    DO_NOT_TRACK=1 \
    NO_UPDATE_NOTIFIER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /workspace
EXPOSE 4170
# No USER line: the gateway always sets the per-user UID; running this image as root is not supported.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-workspace"]
