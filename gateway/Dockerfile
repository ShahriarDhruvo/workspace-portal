# syntax=docker/dockerfile:1
# The gateway. Build context: the repository root, of which gateway/Dockerfile.dockerignore lets in what is copied here.
ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4

FROM ${NODE_IMAGE} AS build
# Compilers, for a platform better-sqlite3 has no prebuilt binary for.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++
WORKDIR /src
# npm checks the lockfile against every workspace's manifest; it installs the gateway's dependencies only.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY gateway/package.json gateway/
COPY web/package.json web/
RUN npm ci --workspace @portal/gateway --include-workspace-root=false --no-audit --no-fund
RUN node -e "require('better-sqlite3')(':memory:')" \
 || npm --prefix node_modules/better-sqlite3 run build-release
COPY packages/core/ packages/core/
COPY gateway/ gateway/
# Bundles dist/main.js and copies the modules it leaves out, with their dependencies, to /out/node_modules.
RUN node gateway/build.mjs --runtime-deps /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app/gateway
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/gateway/dist ./dist
# The build fails unless the native module and every module left out of the bundle load in this image.
RUN node -e "const db = require('better-sqlite3')(':memory:'); if (db.prepare('select 1 as x').get().x !== 1) process.exit(1)" \
 && node --input-type=module -e "await import('better-sqlite3'); await import('dockerode'); await import('ws')"
# No USER: it runs as root with three capabilities (docker-compose.yml), to hand each user's files to their UID.
CMD ["node", "dist/main.js"]
