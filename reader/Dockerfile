# syntax=docker/dockerfile:1
# The page reader (reader.py). Python fetches a page and reads PDFs; Node runs Defuddle, the HTML to markdown
# converter (extract.mjs), in a process per page. Build context: this directory.
ARG NODE_IMAGE=docker.io/library/node:26-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5

FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # Nothing in this image needs to change user.
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && install -d -o 10002 -g 10002 /opt/reader/.compile-cache
WORKDIR /opt/reader
ENV NODE_ENV=production \
    # Node keeps compiled code here; the tests fill it, so each conversion starts faster.
    NODE_COMPILE_CACHE=/opt/reader/.compile-cache \
    PYTHONPATH=/opt/python \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip
COPY package.json package-lock.json requirements.txt ./
# Exact versions, checked against the hashes in the lockfile and requirements.txt; no install script runs.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && pip3 install --no-cache-dir --break-system-packages --require-hashes --only-binary=:all: --no-compile \
      --target /opt/python -r requirements.txt

FROM base AS app
COPY --from=deps /opt/reader/node_modules ./node_modules
COPY --from=deps /opt/python /opt/python
COPY package.json reader.py extract.py extract.mjs ./
USER 10002:10002

# An image whose address checks, converter or PDF reader fail is not built. As the service's user, whose compile
# cache the tests fill.
FROM app AS test
COPY test_reader.py test_extract.py ./
COPY testdata ./testdata
RUN READER_TESTS_REQUIRE_ALL=1 python3 -m unittest test_reader test_extract 2>/tmp/tests.log \
 || { cat /tmp/tests.log; exit 1; }

FROM app
COPY --from=test /opt/reader/.compile-cache ./.compile-cache
EXPOSE 8080
CMD ["python3", "reader.py"]
