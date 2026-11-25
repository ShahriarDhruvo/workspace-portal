# syntax=docker/dockerfile:1
# The web app: the Next.js standalone server. Build context: the repository root.
ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4

FROM ${NODE_IMAGE} AS build
# Compilers, for a platform a native module has no prebuilt binary for.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
# npm checks the lockfile against every workspace's manifest.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY harnesses/package.json harnesses/
COPY container/package.json container/
COPY gateway/package.json gateway/
COPY web/package.json web/
RUN npm ci --workspace @portal/web --no-audit --no-fund \
 && node -e "new (require('better-sqlite3'))(':memory:').close(); require('@node-rs/argon2').hashSync('ok')"
COPY packages/core packages/core
COPY web web
RUN npm run build --workspace @portal/web

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# The standalone tree is the repository's: /app/node_modules and /app/web/server.js. Next.js leaves the static
# files, public/ and the admin scripts to be copied beside it.
COPY --from=build /repo/web/.next/standalone ./
COPY --from=build /repo/web/.next/static ./web/.next/static
COPY --from=build /repo/web/public ./web/public
COPY --from=build /repo/web/scripts ./web/scripts
# Owns nothing here: the app is root's, so the process can't rewrite its own code.
USER 10001:10001
WORKDIR /app/web
EXPOSE 3000
CMD ["node", "server.js"]
