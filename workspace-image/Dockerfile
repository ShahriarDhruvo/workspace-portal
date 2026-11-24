# The workspace images, one target per agent: qwen (Qwen Code's Web Shell, port 4170), dsh (DeepSeek Harness's web
# UI, port 3080) and opencode (OpenCode's web UI, port 4096). deploy/lib.sh builds them, and the gateway for Admin >
# Updates. All hold the same tools and a headless Chromium for the Playwright MCP, and no account: a workspace runs as
# its user's own UID on a read-only root, with that user's /home/user and /workspace mounted
# (gateway/src/docker/container-spec.ts).
FROM docker.io/library/node:24-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4 AS base
ARG PLAYWRIGHT_MCP_VERSION=0.0.84
# While building only: npm's cache and logs go to /tmp, a tmpfs in every step that runs npm.
ARG NPM_CONFIG_CACHE=/tmp/npm
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less procps ripgrep tini unzip \
      python3 python3-venv \
      chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && userdel --remove node \
 && mkdir /home/user /workspace
RUN --mount=type=tmpfs,target=/tmp npm install -g --no-fund --no-audit "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"
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
# The gateway names the user; without one it is nobody, and the start scripts refuse root.
USER 65534:65534

FROM base AS qwen
ARG QWEN_CODE_VERSION=0.27.0
USER root
# qwen/trim-web-shell.mjs trims the Web Shell in place, as it says: Qwen Code has no setting for it. When a change
# no longer fits a Qwen Code version, it names the change and fails the build, as the dsh stage's checks do.
# /etc/workspace-portal/qwen: where the gateway mounts settings.json and system-defaults.json.
# The find, here and in the other stages: no setuid or setgid program stays in a workspace image.
RUN --mount=type=tmpfs,target=/tmp --mount=type=bind,source=qwen/trim-web-shell.mjs,target=/mnt/trim-web-shell.mjs \
    npm install -g "@qwen-code/qwen-code@${QWEN_CODE_VERSION}" \
 && node /mnt/trim-web-shell.mjs "$(npm root -g)/@qwen-code/qwen-code" \
 && mkdir -p /etc/workspace-portal/qwen \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --chmod=0755 start-qwen.sh /usr/local/bin/start-qwen
ENV QWEN_CODE_SYSTEM_SETTINGS_PATH=/etc/workspace-portal/qwen/settings.json \
    QWEN_CODE_SYSTEM_DEFAULTS_PATH=/etc/workspace-portal/qwen/system-defaults.json \
    QWEN_TELEMETRY_ENABLED=false \
    QWEN_STREAM_MAX_LIFETIME_MS=3600000
EXPOSE 4170
# By this the gateway finds builds that lost their tag (gateway/src/docker/docker-image-builder.ts).
LABEL workspace-portal.agent="qwen"
USER 65534:65534
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-qwen"]

FROM base AS dsh
ARG DSH_VERSION=0.2.2-rc.1
# What dsh's plugin manager installs plugins with (its Plugins page, and its agent tools), into the profile in
# DSH_HOME. They come from the npm registry or GitHub, so only an Online workspace can install one; both can switch on
# the plugins dsh comes with.
ARG PNPM_VERSION=11.28.13
USER root
# The three edits of dsh's files, each failing the build when it no longer fits; neither script nor the YAML parser (in
# /tmp) stays in the image:
#   dsh/adapt-presets.mjs: its agent presets without the built-in web tools the lockdown turns off;
#   dsh/web-preview.mjs: its web preview (the sidebar Browser) shows the workspace's own web apps;
#   dsh/portal-theme.mjs: its dark theme in the blacks of Qwen Code's Web Shell and the portal.
# /etc/workspace-portal/dsh: where the gateway mounts portal.patch.yml.
# dsh-cwd: dsh's launch directory, empty and root's, because dsh loads <cwd>/.env.
RUN --mount=type=tmpfs,target=/tmp --mount=type=bind,source=dsh/adapt-presets.mjs,target=/mnt/adapt-presets.mjs \
    --mount=type=bind,source=dsh/web-preview.mjs,target=/mnt/web-preview.mjs \
    --mount=type=bind,source=dsh/portal-theme.mjs,target=/mnt/portal-theme.mjs \
    npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}" \
 && npm install --prefix /tmp/wp-tools yaml@2.9.1 \
 && cp /mnt/adapt-presets.mjs /tmp/wp-tools/ \
 && node /tmp/wp-tools/adapt-presets.mjs "$(npm root -g)/@deepseek-ai/dsh" \
 && node /mnt/web-preview.mjs "$(npm root -g)/@deepseek-ai/dsh" \
 && node /mnt/portal-theme.mjs "$(npm root -g)/@deepseek-ai/dsh" \
 && mkdir -p /etc/workspace-portal/dsh /usr/local/share/workspace-portal/dsh /usr/local/lib/workspace-portal/dsh-cwd \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --chmod=0755 start-dsh.sh /usr/local/bin/start-dsh
COPY --chmod=0644 dsh/lockdown.patch.yml /usr/local/share/workspace-portal/dsh/lockdown.patch.yml
# start-dsh runs it: Auto review switched on once in each person's profile.
COPY --chmod=0644 dsh/default-profile.mjs /usr/local/lib/workspace-portal/dsh-default-profile.mjs
# The build fails when a row of the lockdown doesn't apply to this dsh version (dsh would only warn), when a setting a
# row gives isn't one its plugin has (dsh would say nothing), or when default-profile.mjs no longer finds what it uses
# of dsh.
RUN --mount=type=bind,source=dsh/check-lockdown.sh,target=/mnt/check-lockdown.sh \
    --mount=type=bind,source=dsh/check-lockdown-config.mjs,target=/mnt/check-lockdown-config.mjs \
    sh /mnt/check-lockdown.sh /usr/local/share/workspace-portal/dsh/lockdown.patch.yml \
 && node /usr/local/lib/workspace-portal/dsh-default-profile.mjs /usr/local/lib/node_modules/@deepseek-ai/dsh --check
# DSH_PERMISSION_MODE: dsh's own default for new sessions, here Full access (its danger-full-access preset: the
#   agent's commands write anything the workspace's user can, without asking; the container is the boundary). A person
#   picks another mode per session, and another default under Settings.
# NARB_DISABLE_NATIVE_CACHE: dsh would copy its native addons to /tmp, which is noexec, and not start.
ENV DSH_HOME=/home/user/.dsh \
    DSH_AGENTS_HOME=/home/user/.agents \
    DSH_PERMISSION_MODE=danger-full-access \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_TELEMETRY_MODE=DISABLED \
    NARB_DISABLE_NATIVE_CACHE=1
EXPOSE 3080
LABEL workspace-portal.agent="dsh"
USER 65534:65534
# Not under tini: start-dsh execs it once the cookie secret is out of the environment, so PID 1 never holds it.
ENTRYPOINT ["/usr/local/bin/start-dsh"]

FROM base AS opencode
ARG OPENCODE_VERSION=2.4.1
USER root
# OpenCode is one program. npm installs each of its builds for this kind of machine (four for x64: for glibc and for
# musl, with and without AVX2), and its package links the one this system and CPU run as `opencode`: the image is for
# the host that builds it. The builds' own packages are then removed; the link keeps the chosen one.
# HOME: its package starts it once, and it opens its log in its home even to say its version.
# /etc/opencode: OpenCode's directory for managed settings, where the gateway mounts opencode.json.
RUN --mount=type=tmpfs,target=/tmp \
    HOME=/tmp npm install -g "@opencode/cli@${OPENCODE_VERSION}" \
 && rm -rf "$(npm root -g)/@opencode/cli/node_modules" \
 && HOME=/tmp opencode --version \
 && mkdir -p /etc/opencode \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
# OPENCODE_DISABLE_AUTOUPDATE: it looks for no newer version, as the gateway's settings say too (`update`).
# OPENCODE_DISABLE_MODELS_FETCH: its list of the world's models stays the one it ships with (a Private workspace
#   could not fetch another); the portal's provider is the only one offered either way.
ENV OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1
# No file of OpenCode is edited, so nothing here can stop fitting it; what can change is how it reads the gateway's
# settings and answers the gateway's requests. The build fails when it does, as check-serve.mjs says. The check has
# no network, as a Private workspace has no route out: OpenCode has to start, take a turn and open a terminal there.
RUN --network=none \
    --mount=type=tmpfs,target=/tmp \
    --mount=type=bind,source=opencode/check-serve.mjs,target=/mnt/check-serve.mjs \
    --mount=type=bind,source=opencode/check-settings.json,target=/mnt/check-settings.json \
    node /mnt/check-serve.mjs /mnt/check-settings.json
COPY --chmod=0755 start-opencode.sh /usr/local/bin/start-opencode
EXPOSE 4096
LABEL workspace-portal.agent="opencode"
USER 65534:65534
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-opencode"]
