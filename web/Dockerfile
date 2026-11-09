# syntax=docker/dockerfile:1
# Workspace Portal web app: the Next.js standalone server. Build from the repo root:
#   docker build -f web/Dockerfile -t workspace-portal/web .
# Runs as the image's `node` user (uid 1000) and listens on $HOSTNAME:$PORT (default 0.0.0.0:3000).

ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4

FROM ${NODE_IMAGE} AS build
# Only for native modules that have no prebuilt binary for this platform (they fall back to node-gyp).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo

# Dependencies first, for layer caching. npm needs every workspace manifest to validate the lockfile.
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY gateway/package.json gateway/
COPY web/package.json web/
RUN npm ci --workspace @portal/web --no-audit --no-fund \
 && node -e "new (require('better-sqlite3'))(':memory:').close(); require('@node-rs/argon2').hashSync('ok')"

COPY packages/db packages/db
COPY web web
RUN npm run build --workspace @portal/web

FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# The standalone tree mirrors the monorepo: /app/node_modules (traced deps, native modules included)
# and /app/web/server.js. Static assets, public files and the admin scripts are copied next to it.
COPY --from=build --chown=node:node /repo/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/web/.next/static ./web/.next/static
COPY --from=build --chown=node:node /repo/web/public ./web/public
COPY --from=build --chown=node:node /repo/web/scripts ./web/scripts
USER node
WORKDIR /app/web
EXPOSE 3000
CMD ["node", "server.js"]
