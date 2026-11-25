#!/bin/sh
# Starts OpenCode's web UI and API (`opencode serve`) on the container's own address, port 4096. The gateway reaches
# it there and authenticates every request with OPENCODE_PASSWORD (HTTP Basic, user "opencode"; a fresh random
# password per start); browsers never see it. Without one OpenCode would make up a password the gateway does not
# know, so the script refuses to start without one.
set -eu
. /usr/local/lib/workspace-portal/entry.sh
: "${OPENCODE_PASSWORD:?OPENCODE_PASSWORD is not set}"
SETTINGS=/etc/opencode/opencode.json
[ -r "$SETTINGS" ] || { echo "start-harness: $SETTINGS is missing" >&2; exit 1; }

# OpenCode unpacks its native libraries into its temporary folder and loads them from there; /tmp is noexec, and
# without them it watches no folder for changes. The folder is emptied first, so it holds this version's only.
export BUN_TMPDIR="$HOME/.cache/opencode/native"
rm -rf "$BUN_TMPDIR"
mkdir -p "$BUN_TMPDIR"

cd /workspace
exec /usr/bin/tini -- opencode serve --hostname "$IP" --port 4096
