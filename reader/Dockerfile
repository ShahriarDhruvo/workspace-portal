# syntax=docker/dockerfile:1
# Workspace Portal page reader: fetches one public page for an agent and returns its text
# (reader.py). The build context is this directory:
#   docker build -t workspace-portal/reader:latest reader
# docker-compose.yml runs it without capabilities, as an unprivileged user, with a read-only root,
# on a network of its own.
#
# Two runtimes, each for one job: Python fetches (the address checks live in reader.py) and reads
# PDFs; Node runs Defuddle, the HTML to markdown converter (extract.mjs), in a process per page.
ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4

# ---------------------------------------------------------------- JavaScript dependencies
FROM ${NODE_IMAGE} AS node-deps
WORKDIR /opt/reader
COPY package.json package-lock.json ./
# Exact versions with integrity hashes from the lockfile; no package's install script runs.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------------------------------------------------------------- Python dependencies
FROM ${NODE_IMAGE} AS python-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
# One wheel, checked against the hash in requirements.txt, unpacked beside the system Python.
RUN pip3 install --no-cache-dir --break-system-packages --require-hashes --only-binary=:all: --no-compile \
      --target /opt/python -r /tmp/requirements.txt

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # Nothing in this image needs to change user.
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && install -d -o 10002 -g 10002 /opt/reader/.compile-cache
WORKDIR /opt/reader
COPY --from=node-deps /opt/reader/node_modules ./node_modules
COPY --from=python-deps /opt/python /opt/python
COPY package.json reader.py extract.py extract.mjs test_reader.py test_extract.py ./
COPY testdata ./testdata

ENV NODE_ENV=production \
    # Node keeps compiled code here; the build fills it, so each conversion starts faster.
    NODE_COMPILE_CACHE=/opt/reader/.compile-cache \
    PYTHONPATH=/opt/python \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER 10002:10002
# The tests are part of the build: an image whose address checks, converter or PDF reader do not
# work is not produced. They run as the service's user, which is also who the compile cache is for.
RUN READER_TESTS_REQUIRE_ALL=1 python3 -m unittest test_reader test_extract 2>/tmp/tests.log \
 || { cat /tmp/tests.log; exit 1; }

EXPOSE 8080
CMD ["python3", "reader.py"]
