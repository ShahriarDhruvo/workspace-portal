#!/bin/sh
# Starts the DeepSeek Harness web UI (dsh --profile web) on the container's own address, port 3080.
#
# The gateway reaches it there and authenticates every request with a dsh-auth-* cookie it mints itself
# (for Host localhost:3080) from DSH_COOKIE_SECRET: 32 random bytes, base64url without padding, new for
# every container start. This script stores the secret as dsh's browser-session signing record in a
# fresh /tmp/dsh-credentials.yaml (the lockdown patch points the credentials plugin there), removes it
# from the environment, and only then execs tini and dsh. So neither dsh nor anything it starts (agent
# bash, terminal, MCP servers) inherits it, and /proc/1/environ (tini) doesn't show it.
# This script is the image's ENTRYPOINT (not run under tini) for that reason.
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
# The home caches are the only part of $HOME the agent's sandboxed commands may write (the lockdown's
# sandbox-policy); Landlock needs them to exist.
mkdir -p "$HOME" "$DSH_HOME" "$DSH_AGENTS_HOME" "$HOME/.cache" "$HOME/.local" "$HOME/.npm"
# /tmp is a fresh tmpfs per start; noclobber refuses to write through anything already there.
# printf is a shell builtin, so the secret never appears in a process's argv.
set -C
printf 'version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: %s\n' \
  "$secret" > "$CREDENTIALS"
set +C
unset secret

# The container's own address (dsh rejects 0.0.0.0, :: and host names).
IP=$(hostname -i | awk '{print $1}')

# dsh loads <cwd>/.env at start: launch from an empty, root-owned directory.
cd /usr/local/lib/workspace-portal/dsh-cwd
exec /usr/bin/tini -- dsh --profile web --patch "$LOCKDOWN" --patch "$PORTAL" \
  --no-open --host "$IP" --port 3080
