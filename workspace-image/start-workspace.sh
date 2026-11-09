#!/bin/sh
# Starts the Qwen Code Web Shell on the container's own address. The gateway reaches it there and
# authenticates every request with QWEN_SERVER_TOKEN (a fresh random token per start); browsers
# never see the token. Refuses to run as root.
set -eu
if [ "$(id -u)" = "0" ]; then
  echo "start-workspace: refusing to run as root; the gateway runs workspaces as the user's UID" >&2
  exit 1
fi
: "${QWEN_SERVER_TOKEN:?QWEN_SERVER_TOKEN is not set}"
IP=$(hostname -i | awk '{print $1}')
mkdir -p "$HOME"
cd /workspace
set -- --hostname "$IP" --port 4170 --workspace /workspace --no-token-qr
# Declines an approval or question nobody answers within this time (set by the gateway to the idle timeout).
if [ "${QWEN_PERMISSION_TIMEOUT_MS:-0}" -gt 0 ] 2>/dev/null; then
  set -- "$@" --permission-response-timeout-ms "$QWEN_PERMISSION_TIMEOUT_MS"
fi
exec qwen serve "$@"
