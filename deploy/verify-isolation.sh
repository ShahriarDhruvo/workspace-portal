#!/usr/bin/env bash
# Proves that a workspace can reach the gateway's service port (model + web search) and nothing else.
#
#   1. Host: the Docker engine, the workspace network and the firewall table are what the gateway
#      and deploy/firewall.sh expect.
#   2. Running workspaces: every wp-ws-* container has the restrictions the gateway applies.
#   3. Reachability: a throwaway container on the workspace network (the workspace image, a
#      workspace UID, read-only root, no capabilities) probes TCP, UDP, ICMP and IPv6 targets: the
#      gateway's other ports, every host address, the LLM server and SearXNG directly, the router,
#      the internet and the other workspaces.
#
# Safe to run any time; touches no user data.
#   sudo bash deploy/verify-isolation.sh
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root

NETWORK=$(env_get WORKSPACE_NETWORK)
BRIDGE=$(env_get WORKSPACE_BRIDGE)
SUBNET=$(env_get WORKSPACE_SUBNET)
GW=$(env_get WORKSPACE_GATEWAY_IP)
SERVICE_PORT=$(env_get SERVICE_PORT)
CONTROL_PORT=$(env_get CONTROL_PORT)
WEB_PORT=$(web_port)
AGENT_PORTS=$(agent_port_range)
FIRST_AGENT_PORT=${AGENT_PORTS%-*}
UID_BASE=$(env_get WORKSPACE_UID_BASE)
DATA_DIR=$(env_get PORTAL_DATA_DIR)
IMAGE=$(workspace_image)

pass=0 fail=0
ok() { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; } # description condition

# ---------------------------------------------------------------- 1. host
echo "== host"
check "Docker engine $(docker version --format '{{.Server.Version}}' 2>/dev/null) has the internal-network DNS fix (>= 25.0.5)" docker_version_ok
docker network inspect "$NETWORK" >/dev/null 2>&1 || die "network $NETWORK does not exist yet: start the stack first"
net() { docker network inspect -f "$1" "$NETWORK"; }
check "network $NETWORK is internal (no route off the host)" '[[ $(net "{{.Internal}}") == true ]]'
check "network $NETWORK has inter-container traffic disabled" '[[ $(net "{{index .Options \"com.docker.network.bridge.enable_icc\"}}") == false ]]'
check "network $NETWORK uses bridge $BRIDGE (the firewall matches on it)" '[[ $(net "{{index .Options \"com.docker.network.bridge.name\"}}") == "$BRIDGE" ]]'
check "network $NETWORK is $SUBNET with gateway $GW" '[[ $(net "{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}") == "$SUBNET $GW" ]]'
check "network $NETWORK has no IPv6" '[[ $(net "{{.EnableIPv6}}") == false ]]'
check "firewall unit workspace-portal-firewall is active" 'systemctl is-active --quiet workspace-portal-firewall'
rules=$(nft list table inet workspace_portal 2>/dev/null || true)
check "firewall table allows only $GW tcp/$SERVICE_PORT from the workspace network" \
  '[[ $rules == *"iifname \"$BRIDGE\" jump from_workspace"* && $rules == *"ip daddr $GW tcp dport $SERVICE_PORT ct state new accept"* ]]'

# ---------------------------------------------------------------- 2. running workspaces
echo "== running workspaces"
running=$(docker ps -q --filter label=workspace-portal.workspace=1)
[[ -n $running ]] || echo "(none running; start one and re-run to inspect it)"
for id in $running; do
  name=$(docker inspect -f '{{.Name}}' "$id"); name=${name#/}
  user_id=$(docker inspect -f '{{index .Config.Labels "workspace-portal.user-id"}}' "$id")
  user=$(docker inspect -f '{{.Config.User}}' "$id")
  check "$name runs as its own UID ($user)" '[[ $user == "$((UID_BASE + user_id)):$((UID_BASE + user_id))" ]]'
  check "$name: read-only root, all capabilities dropped, no-new-privileges, not privileged" \
    '[[ $(docker inspect -f "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.Privileged}}" "$id") == "true [ALL] [no-new-privileges:true] false" ]]'
  check "$name: only on $NETWORK, no published ports" \
    '[[ $(docker inspect -f "{{.HostConfig.NetworkMode}} {{len .HostConfig.PortBindings}}" "$id") == "$NETWORK 0" ]]'
  foreign=$(docker inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$id" | grep -v "^$DATA_DIR/users/$user_id/" | grep -v '^$' || true)
  check "$name mounts only its own user's directory" '[[ -z $foreign ]]'
done

# ---------------------------------------------------------------- 3. reachability
echo "== reachability from a workspace"
# "ip port label" lines for TCP targets that must be unreachable.
closed=()
add_closed() { closed+=("$1 $2 $3"); }
add_closed "$GW" 22 "host-SSH-via-the-bridge"
add_closed "$GW" "$WEB_PORT" "the-portal-via-the-bridge"
add_closed "$GW" "$CONTROL_PORT" "the-gateway-control-API"
add_closed "$GW" "$FIRST_AGENT_PORT" "a-workspace-port-via-the-bridge"
for address in $(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -v -e '^127\.' -e "^$GW$"); do
  add_closed "$address" 22 "SSH-on-host-address-$address"
  add_closed "$address" "$WEB_PORT" "the-portal-on-host-address-$address"
done
# The model server and SearXNG must only be reachable through the gateway.
upstream() { # url label
  local rest=${1#*://} scheme=${1%%://*} host port address
  rest=${rest%%/*}
  host=${rest%:*}
  port=${rest##*:}
  [[ $rest == *:* ]] || port=$([[ $scheme == https ]] && echo 443 || echo 80)
  case $host in
    localhost | 127.* | "$(host_ip)") address=$GW ;; # a service on this host: try it via the bridge
    *) address=$(getent ahostsv4 "$host" | awk '{print $1; exit}') ;;
  esac
  if [[ -n $address ]]; then add_closed "$address" "$port" "$2-directly"; fi
}
upstream "$(env_get LLM_UPSTREAM_URL)" "the-LLM-server"
upstream "$(env_get SEARXNG_URL)" "SearXNG"
ROUTER=$(ip -4 route show default | awk '{print $3; exit}')
if [[ -n $ROUTER ]]; then add_closed "$ROUTER" 80 "the-router"; fi
add_closed 1.1.1.1 443 "the-internet"
add_closed 8.8.8.8 53 "public-DNS-over-TCP"
for peer in $(docker ps -q --filter label=workspace-portal.workspace=1 | xargs -r docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}"); do
  add_closed "$peer" 4170 "another-workspace"
done

PROBE=$(cat <<'SH'
pass=0; fail=0
ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1"; fail=$((fail+1)); }
reach() { timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

if reach "$GW" "$SERVICE_PORT"; then ok "reaches the gateway service port $GW:$SERVICE_PORT (model + search)"; else bad "cannot reach the gateway service port $GW:$SERVICE_PORT"; fi
while read -r ip port label; do
  [ -n "$ip" ] || continue
  if reach "$ip" "$port"; then bad "REACHES ${label//-/ } ($ip:$port)"; else ok "blocked: ${label//-/ } ($ip:$port)"; fi
done <<<"$CLOSED"

# UDP and ICMP have no handshake: send a real DNS query or echo request and wait for an answer.
python3 - "$GW" "$ROUTER" <<'PY'
import socket, struct, sys
gw, router = sys.argv[1], sys.argv[2]
def dns(server):
    query = struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + b"\x07example\x03com\x00" + struct.pack(">HH", 1, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
    try:
        s.sendto(query, (server, 53)); s.recvfrom(512); return True
    except OSError: return False
    finally: s.close()
def ping(host):
    try: s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP)
    except OSError: return False  # unprivileged ICMP not even allowed
    s.settimeout(2)
    try:
        s.sendto(struct.pack(">BBHHH", 8, 0, 0, 0, 1) + b"probe", (host, 0)); s.recvfrom(512); return True
    except OSError: return False
    finally: s.close()
for server in [gw, router, "1.1.1.1", "8.8.8.8"]:
    if server: print(("FAIL  answers" if dns(server) else "PASS  blocked:") + f" DNS over UDP to {server}:53")
for host in [gw, router, "1.1.1.1"]:
    if host: print(("FAIL  answers" if ping(host) else "PASS  blocked:") + f" ICMP echo to {host}")
PY
if python3 -c 'import sys; sys.exit(0 if all(l.split()[-1] == "lo" for l in open("/proc/net/if_inet6")) else 1)' 2>/dev/null; then
  ok "no IPv6 address on any interface"
else
  bad "has an IPv6 address: $(grep -v ' lo$' /proc/net/if_inet6 | awk '{print $6}' | tr '\n' ' ')"
fi
if getent hosts example.com >/dev/null 2>&1; then bad "DNS resolves example.com"; else ok "no DNS for internet names"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$GW:$SERVICE_PORT/llm/v1/models" || true)
if [ "$code" = 403 ]; then ok "the service API refuses callers that are not workspaces (HTTP 403)"; else bad "the service API answered HTTP $code to a caller that is not a workspace"; fi

[ "$(id -u)" != 0 ] && ok "runs as uid $(id -u), not root" || bad "runs as root"
caps=$(awk '/^CapEff/ {print $2}' /proc/self/status)
[ "$caps" = 0000000000000000 ] && ok "no capabilities" || bad "capabilities: $caps"
grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status && ok "no-new-privileges" || bad "new privileges allowed"
if touch /usr/probe 2>/dev/null; then bad "root filesystem is writable"; else ok "read-only root filesystem"; fi
if [ -n "$(find / -xdev -perm /6000 -type f 2>/dev/null | head -1)" ]; then bad "setuid/setgid binaries in the image"; else ok "no setuid/setgid binaries"; fi
if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then bad "the Docker socket is inside"; else ok "no Docker socket inside"; fi
if [ -n "$(ls -A /srv 2>/dev/null)" ]; then bad "host data visible in /srv"; else ok "no host data inside"; fi
echo "probe: passed $pass, failed $fail"
[ "$fail" = 0 ]
SH
)

NAME="wp-isolation-probe-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
# A UID in the workspace range that no real user has.
PROBE_UID=$((UID_BASE + 99999))
probe_output=$(docker run --rm --name "$NAME" --network "$NETWORK" --user "$PROBE_UID:$PROBE_UID" \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 128 --memory 256m --entrypoint /bin/bash \
  -e GW="$GW" -e SERVICE_PORT="$SERVICE_PORT" -e ROUTER="${ROUTER:-}" \
  -e CLOSED="$(printf '%s\n' "${closed[@]}")" \
  "$IMAGE" -c "$PROBE" 2>&1) || true
echo "$probe_output" | grep -v '^probe: '
pass=$((pass + $(grep -c '^PASS' <<<"$probe_output" || true)))
fail=$((fail + $(grep -c '^FAIL' <<<"$probe_output" || true)))
grep -q '^probe: ' <<<"$probe_output" || bad "the probe container did not run to the end (see output above)"

echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
