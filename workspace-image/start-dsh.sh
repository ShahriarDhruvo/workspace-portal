#!/bin/sh
# The dsh image's entrypoint: the DeepSeek Harness web UI on the container's own address, port 3080.
# The gateway signs the dsh-auth-* cookie of its requests with DSH_COOKIE_SECRET: 32 random bytes as base64url, new
# at every start. This script stores it as dsh's browser-session record in /tmp/dsh-credentials.yaml (where the
# lockdown points the credentials plugin) and unsets it before it execs tini and dsh, so neither they nor what dsh
# starts hold it.
set -eu

if [ "$(id -u)" = "0" ]; then
  echo "start-dsh: refusing to run as root; the gateway runs workspaces as the user's UID" >&2
  exit 1
fi
: "${DSH_HOME:?DSH_HOME is not set}"
: "${DSH_AGENTS_HOME:?DSH_AGENTS_HOME is not set}"
LOCKDOWN=/usr/local/share/workspace-portal/dsh/lockdown.patch.yml
PORTAL=/etc/workspace-portal/dsh/portal.patch.yml
CREDENTIALS=/tmp/dsh-credentials.yaml
for file in "$LOCKDOWN" "$PORTAL"; do
  [ -r "$file" ] || { echo "start-dsh: $file is missing" >&2; exit 1; }
done

secret=${DSH_COOKIE_SECRET:-}
unset DSH_COOKIE_SECRET
case "$secret" in
  "" | *[!A-Za-z0-9_-]*) echo "start-dsh: DSH_COOKIE_SECRET must be base64url" >&2; exit 1 ;;
esac
[ "${#secret}" -eq 43 ] || { echo "start-dsh: DSH_COOKIE_SECRET must be 32 bytes (43 base64url characters)" >&2; exit 1; }

umask 077
mkdir -p "$HOME" "$DSH_HOME" "$DSH_AGENTS_HOME"
# /tmp is a fresh tmpfs per start; noclobber refuses to write through anything already there.
# printf is a shell builtin, so the secret never appears in a process's argv.
set -C
printf 'version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: %s\n' \
  "$secret" > "$CREDENTIALS"
set +C
unset secret

# The container's own address (dsh rejects 0.0.0.0, :: and host names).
IP=$(hostname -i | awk '{print $1}')

# Auto review switched on once in the person's own profile (theirs to switch off under Plugins). Not a reason to
# keep the workspace from starting.
node /usr/local/lib/workspace-portal/dsh-default-profile.mjs /usr/local/lib/node_modules/@deepseek-ai/dsh ||
  echo "start-dsh: Auto review was not switched on in the profile; dsh starts without it" >&2

# dsh loads <cwd>/.env at start: launch from an empty, root-owned directory.
cd /usr/local/lib/workspace-portal/dsh-cwd
exec /usr/bin/tini -- dsh --profile web --patch "$LOCKDOWN" --patch "$PORTAL" \
  --no-open --host "$IP" --port 3080
