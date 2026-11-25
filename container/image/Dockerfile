# The workspace image of one harness: the base every workspace has, then the harness, which its own folder installs
# (harnesses/<name>/image/). deploy/lib.sh builds it, and the gateway for Admin > Updates, with
# --build-arg HARNESS=<name> --build-arg HARNESS_VERSION=<version>. Build context: the repository root, of which
# Dockerfile.dockerignore lets in this folder and the harnesses' image folders. An image holds no account: a workspace
# runs as a UID of its own on a read-only root, with its own /home/user and /workspace mounted (../security/spec.ts).
FROM docker.io/library/node:24-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4 AS base
ARG PLAYWRIGHT_MCP_VERSION=0.0.86
ARG PNPM_VERSION=12.23.0
# While building only: npm's cache and logs go to /tmp, a tmpfs in every step that runs npm.
ARG NPM_CONFIG_CACHE=/tmp/npm
# build-essential and gdb: C and C++. libicu72: what PowerShell needs of the system.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl file git jq less openssh-client procps ripgrep tini unzip xz-utils zip \
      build-essential gdb \
      python3 python3-venv \
      libicu72 \
      chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && userdel --remove node \
 && mkdir /home/user /workspace /usr/local/lib/workspace-portal
COPY --chmod=0644 container/image/fetch.sh /usr/local/lib/workspace-portal/fetch.sh
# Go, Rust, uv, ruff, PowerShell, shellcheck and shfmt.
RUN --mount=type=bind,source=container/image/toolchains.sh,target=/mnt/toolchains.sh sh /mnt/toolchains.sh
RUN --mount=type=tmpfs,target=/tmp npm install -g --no-fund --no-audit "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" "pnpm@${PNPM_VERSION}"
COPY --chmod=0644 container/image/entry.sh /usr/local/lib/workspace-portal/entry.sh
# UV_LINK_MODE: a project and uv's cache are on two mounts (/workspace, /home/user), which no hard link crosses.
ENV HOME=/home/user \
    DO_NOT_TRACK=1 \
    NO_UPDATE_NOTIFIER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_LINK_MODE=copy \
    POWERSHELL_TELEMETRY_OPTOUT=1 \
    POWERSHELL_UPDATECHECK=Off \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium
# After the image's own programs, where a person's installs put theirs (uv tool and pip --user, cargo, go).
ENV PATH="${PATH}:/home/user/.local/bin:/home/user/.cargo/bin:/home/user/go/bin"
RUN --network=none --mount=type=tmpfs,target=/tmp --mount=type=bind,source=container/image/check-toolchains.sh,target=/mnt/check-toolchains.sh \
    HOME=/tmp sh /mnt/check-toolchains.sh
WORKDIR /workspace

# The harness's image folder, for the steps below to mount: only what they install from it stays in the image.
FROM scratch AS harness
ARG HARNESS
COPY harnesses/${HARNESS}/image/ /

FROM base
ARG HARNESS
ARG HARNESS_VERSION
ARG NPM_CONFIG_CACHE=/tmp/npm
# What a harness's folder holds for this:
#   install.sh <version>  installs the harness and what it needs beside it, and fails when an edit it makes no
#                         longer fits that version;
#   env.sh                the harness's environment, in its checks and at every start (entry.sh);
#   start.sh              the entrypoint: it sources entry.sh, then starts the harness under tini.
# The find: no setuid or setgid program stays in a workspace image.
RUN --mount=type=tmpfs,target=/tmp --mount=type=bind,from=harness,target=/mnt/harness \
    sh /mnt/harness/install.sh "${HARNESS_VERSION:?}" \
 && install -m 0644 /mnt/harness/env.sh /usr/local/lib/workspace-portal/harness-env.sh \
 && install -m 0755 /mnt/harness/start.sh /usr/local/bin/start-harness \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
#   check.sh              fails the build when the installed harness no longer does what the portal relies on. It
#                         has no network, as a Private workspace has no route out; nothing it writes stays.
RUN --network=none --mount=type=tmpfs,target=/tmp --mount=type=bind,from=harness,target=/mnt/harness \
    . /usr/local/lib/workspace-portal/harness-env.sh && sh /mnt/harness/check.sh
# By this the gateway finds builds that lost their tag (gateway/src/docker/docker-image-builder.ts).
LABEL workspace-portal.agent="${HARNESS}"
# The gateway names the user; without one it is nobody, and entry.sh refuses root.
USER 65534:65534
# The steps above ran as root: a user without privileges has to get through the entry too (its home is /tmp here).
RUN --network=none --mount=type=tmpfs,target=/tmp set -eu && export HOME=/tmp && . /usr/local/lib/workspace-portal/entry.sh
ENTRYPOINT ["/usr/local/bin/start-harness"]
