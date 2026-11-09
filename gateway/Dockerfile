# syntax=docker/dockerfile:1
# Workspace Portal gateway. The build context is the repository root:
#   docker build -f gateway/Dockerfile -t workspace-portal/gateway:latest .
# docker-compose.yml runs it with network_mode host, as root with only CHOWN, DAC_OVERRIDE and FOWNER
# (it hands each user's files to that workspace's own UID), with the Docker socket mounted.
ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
# Compilers only for platforms where better-sqlite3 ships no prebuilt binary (see below).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src

# Manifests first so the dependency layer is cached. web/package.json is only read so the
# workspace lockfile stays consistent; none of the web app's dependencies are installed.
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY gateway/package.json gateway/
COPY web/package.json web/
RUN npm ci --workspace @portal/gateway --include-workspace-root=false --no-audit --no-fund

# better-sqlite3 loads a bundled N-API prebuild (no install script involved); compile it from
# source only if that binary does not load on this platform.
RUN node -e "require('better-sqlite3')(':memory:')" \
 || npm --prefix node_modules/better-sqlite3 run build-release

COPY packages/db/ packages/db/
COPY gateway/ gateway/
# Bundles dist/main.js and copies the externals with their dependencies to /out/node_modules.
RUN node gateway/build.mjs --runtime-deps /out

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app/gateway
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/gateway/dist ./dist
# Fail the build unless the native module and every external load in this image.
RUN node -e "const db = require('better-sqlite3')(':memory:'); if (db.prepare('select 1 as x').get().x !== 1) process.exit(1)" \
 && node --input-type=module -e "await import('better-sqlite3'); await import('dockerode'); await import('ws')"
# No USER: docker-compose.yml runs it as root with only CHOWN, DAC_OVERRIDE and FOWNER, because it
# creates each user's directories owned by that workspace's own UID.
CMD ["node", "dist/main.js"]
