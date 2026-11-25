#!/bin/sh
# Starts the Qwen Code Web Shell on the container's own address, port 4170. The gateway reaches it there and
# authenticates every request with QWEN_SERVER_TOKEN (a fresh random token per start); browsers never see the token.
set -eu
. /usr/local/lib/workspace-portal/entry.sh
: "${QWEN_SERVER_TOKEN:?QWEN_SERVER_TOKEN is not set}"
mkdir -p "$HOME"
cd /workspace
set -- --hostname "$IP" --port 4170 --workspace /workspace --no-token-qr
# Declines an approval or question nobody answers within this time (set by the gateway to the idle timeout).
if [ "${QWEN_PERMISSION_TIMEOUT_MS:-0}" -gt 0 ] 2>/dev/null; then
  set -- "$@" --permission-response-timeout-ms "$QWEN_PERMISSION_TIMEOUT_MS"
fi
exec /usr/bin/tini -- qwen serve "$@"
