#!/usr/bin/env bash
# Checks that a workspace can reach the gateway's service port (model + web search) and nothing
# else, and that it runs with the restrictions the gateway applies. Starts a throwaway container
# exactly like a workspace (same image, network, user range, read-only root, no capabilities),
# runs the probes inside it, and removes it. Safe to run any time; touches no user data.
#
#   sudo bash deploy/verify-isolation.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_get() { # key default
  local line
  line=$(grep -E "^$1=" "$ROOT/.env" 2>/dev/null | tail -n 1 || true)
  line=${line#*=}
  line=${line%\"}; line=${line#\"}
  printf '%s' "${line:-$2}"
}
IMAGE=$(env_get WORKSPACE_IMAGE workspace-portal/workspace:qwen-0.27.0)
NETWORK=$(env_get WORKSPACE_NETWORK workspace-portal-ws)
GW=$(env_get WORKSPACE_GATEWAY_IP 172.29.0.1)
SERVICE_PORT=$(env_get SERVICE_PORT 4001)
WEB_PORT=$(env_get WEB_PORT 3000)
CONTROL_PORT=$(env_get CONTROL_PORT 4002)
UID_PROBE=$(( $(env_get WORKSPACE_UID_BASE 200000) + 99999 ))
HOST_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
DOCKER0=$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
docker network inspect "$NETWORK" >/dev/null 2>&1 || { echo "network $NETWORK does not exist yet: start the stack first" >&2; exit 1; }
echo "network $NETWORK: internal=$(docker network inspect -f '{{.Internal}}' "$NETWORK") icc=$(docker network inspect -f '{{index .Options "com.docker.network.bridge.enable_icc"}}' "$NETWORK")"

# Other workspaces (must be unreachable from this one).
PEERS=$(docker ps -q --filter label=workspace-portal.workspace=1 | xargs -r docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" | tr '\n' ' ')

PROBE=$(cat <<'SH'
pass=0; fail=0
ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1"; fail=$((fail+1)); }
reach() { timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }
expect_open()   { if reach "$1" "$2"; then ok "reaches $3 ($1:$2)"; else bad "cannot reach $3 ($1:$2)"; fi; }
expect_closed() { if reach "$1" "$2"; then bad "REACHES $3 ($1:$2)"; else ok "blocked: $3 ($1:$2)"; fi; }

expect_open   "$GW" "$SERVICE_PORT" "the gateway service port (model + search)"
expect_closed "$GW" 22 "host SSH via the bridge"
expect_closed "$GW" "$WEB_PORT" "the portal via the bridge"
expect_closed "$GW" "$CONTROL_PORT" "the gateway control API via the bridge"
expect_closed "$GW" 8080 "the LLM server directly"
expect_closed "$GW" 8888 "SearXNG directly"
[ -n "$HOST_IP" ] && expect_closed "$HOST_IP" 22 "the host's LAN address"
[ -n "$HOST_IP" ] && expect_closed "$HOST_IP" "$WEB_PORT" "the portal on the LAN address"
[ -n "$DOCKER0" ] && expect_closed "$DOCKER0" 22 "the default docker bridge"
expect_closed 1.1.1.1 443 "the internet (1.1.1.1:443)"
expect_closed 8.8.8.8 53 "public DNS over TCP (8.8.8.8:53)"
expect_closed 192.168.1.1 80 "a typical LAN router"
for peer in $PEERS; do expect_closed "$peer" 4170 "another workspace"; done
if getent hosts example.com >/dev/null 2>&1; then bad "DNS resolves example.com"; else ok "no DNS for internet names"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$GW:$SERVICE_PORT/llm/v1/models" || true)
if [ "$code" = 403 ]; then ok "the service API refuses callers that are not workspaces (HTTP 403)"; else bad "service API answered HTTP $code to a non-workspace caller"; fi

[ "$(id -u)" != 0 ] && ok "runs as uid $(id -u), not root" || bad "runs as root"
caps=$(awk '/^CapEff/ {print $2}' /proc/self/status)
[ "$caps" = 0000000000000000 ] && ok "no capabilities" || bad "capabilities: $caps"
grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status && ok "no-new-privileges" || bad "new privileges allowed"
if touch /usr/probe 2>/dev/null; then bad "root filesystem is writable"; else ok "read-only root filesystem"; fi
if touch /tmp/probe 2>/dev/null; then ok "/tmp is writable (in memory)"; else bad "/tmp is not writable"; fi
if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then bad "the Docker socket is inside"; else ok "no Docker socket inside"; fi
if [ -n "$(ls -A /srv 2>/dev/null)" ] || [ -d /srv/workspace-portal ]; then bad "host data visible in /srv"; else ok "no host data inside"; fi
echo "passed $pass, failed $fail"
[ "$fail" = 0 ]
SH
)

NAME="wp-isolation-probe-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --rm --name "$NAME" --network "$NETWORK" --user "$UID_PROBE:$UID_PROBE" \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 128 --memory 256m --entrypoint /bin/bash \
  -e GW="$GW" -e SERVICE_PORT="$SERVICE_PORT" -e WEB_PORT="$WEB_PORT" -e CONTROL_PORT="$CONTROL_PORT" \
  -e HOST_IP="$HOST_IP" -e DOCKER0="$DOCKER0" -e PEERS="$PEERS" \
  "$IMAGE" -c "$PROBE"
