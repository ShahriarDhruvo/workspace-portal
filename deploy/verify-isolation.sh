#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034  # check() evaluates its single-quoted conditions
# Checks on the running portal that a Private workspace reaches its gateway service port and nothing else, an Online
# workspace that and the public internet over TCP, and the page reader and SearXNG the public web only. It reads the
# host's setup, every running workspace and the workspace folders, and probes from throwaway containers of each
# agent's image and from inside the reader and SearXNG. It touches no user data.
#   sudo bash deploy/verify-isolation.sh
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"
require_root
load_enabled_agents

NETWORK=$(env_get WORKSPACE_NETWORK) BRIDGE=$(env_get WORKSPACE_BRIDGE) SUBNET=$(env_get WORKSPACE_SUBNET)
GW=$(env_get WORKSPACE_GATEWAY_IP) UID_BASE=$(env_get WORKSPACE_UID_BASE)
ONLINE_NETWORK=$(env_get ONLINE_NETWORK) ONLINE_BRIDGE=$(env_get ONLINE_BRIDGE) ONLINE_SUBNET=$(env_get ONLINE_SUBNET)
ONLINE_GW=$(env_get ONLINE_GATEWAY_IP) ONLINE_RANGE=$(env_get ONLINE_IP_RANGE) ONLINE_UID_BASE=$(env_get ONLINE_UID_BASE)
ONLINE_DNS_1=$(env_get ONLINE_DNS_1) ONLINE_DNS_2=$(env_get ONLINE_DNS_2)
ONLINE_ON=false
if online_enabled; then ONLINE_ON=true; fi
declare -A KIND_NETWORK=([private]="$NETWORK" [online]="$ONLINE_NETWORK") KIND_UID_BASE=([private]="$UID_BASE" [online]="$ONLINE_UID_BASE")
declare -A KIND_PREFIX=([private]=wp-ws- [online]=wp-wo-)
# The port each agent listens on in a workspace, as its driver in gateway/src/agents/.
declare -A AGENT_PORT=([qwen]=4170 [dsh]=3080 [opencode]=4096)
SERVICE_PORT=$(env_get SERVICE_PORT) CONTROL_PORT=$(env_get CONTROL_PORT) WEB_PORT=$(env_get WEB_PORT)
# The portal's port on this host's addresses: behind deploy/tailscale-https.sh, 443 on Tailscale's.
PORTAL_PORT=$WEB_PORT
! env_is PORTAL_HTTPS true || PORTAL_PORT=443
read -r AGENT_PORTS ONLINE_AGENT_PORTS PREVIEW_PORTS ONLINE_PREVIEW_PORTS < <(port_ranges)
DATA_DIR=$(env_get PORTAL_DATA_DIR)
ROUTER=$(routers | head -n 1)
HOST_ADDRESSES=$(ip -4 -o addr show | awk '$4 !~ /^127\./ {sub("/.*", "", $4); print $4}')

inspect() { docker inspect -f "$2" "$1"; }     # container template
net() { docker network inspect -f "$2" "$1"; } # network template
option() { net "$1" "{{index .Options \"com.docker.network.bridge.$2\"}}"; } # network bridge-option
container() { docker compose ps -q "$1" 2>/dev/null || true; } # service
address() { [[ -z $1 ]] || inspect "$1" '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'; } # container
bridge_address() { ip -4 -o addr show dev "$1" 2>/dev/null | awk '{sub("/.*", "", $4); print $4}' || true; }
READER_PORT=$(env_get READER_PORT) READER_BRIDGE=$(env_get READER_BRIDGE) READER_SUBNET=$(env_get READER_SUBNET)
READER_ON=true READER_ID=""
if env_is READER_URL off; then READER_ON=false; else READER_ID=$(container reader); fi
READER_IP=$(address "$READER_ID") READER_GW=$(bridge_address "$READER_BRIDGE")
SEARXNG_PORT=$(env_get SEARXNG_PORT) SEARXNG_BRIDGE=$(env_get SEARXNG_BRIDGE) SEARXNG_SUBNET=$(env_get SEARXNG_SUBNET)
SEARXNG_ID=$(container searxng) GATEWAY_ID=$(container gateway)
SEARXNG_IP=$(address "$SEARXNG_ID") SEARXNG_GW=$(bridge_address "$SEARXNG_BRIDGE")

pass=0 fail=0
ok() { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; } # description condition

echo "== host"
check "Docker engine $(docker version --format '{{.Server.Version}}' 2>/dev/null) has the internal-network DNS fix (>= 25.0.5)" docker_version_ok
docker network inspect "$NETWORK" >/dev/null 2>&1 || die "network $NETWORK does not exist yet: start the stack first"
check "network $NETWORK is internal (no route off the host)" '[[ $(net "$NETWORK" "{{.Internal}}") == true ]]'
check "network $NETWORK has inter-container traffic disabled" '[[ $(option "$NETWORK" enable_icc) == false ]]'
check "network $NETWORK uses bridge $BRIDGE (the firewall matches on it)" '[[ $(option "$NETWORK" name) == "$BRIDGE" ]]'
check "network $NETWORK is $SUBNET with gateway $GW" '[[ $(net "$NETWORK" "{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}") == "$SUBNET $GW" ]]'
check "network $NETWORK has no IPv6" '[[ $(net "$NETWORK" "{{.EnableIPv6}}") == false ]]'
check "firewall unit workspace-portal-firewall is active" 'systemctl is-active --quiet workspace-portal-firewall'
check "Docker requires the firewall unit (a failed firewall keeps Docker and every container down)" \
  '[[ " $(systemctl show -p Requires --value docker.service) " == *" workspace-portal-firewall.service "* ]]'
rules=$(nft list table inet workspace_portal 2>/dev/null || true)
check "firewall table allows only $GW tcp/$SERVICE_PORT from the workspace network" \
  '[[ $rules == *"iifname \"$BRIDGE\" jump from_workspace"* && $rules == *"ip daddr $GW tcp dport $SERVICE_PORT ct state new accept"* ]]'
# What the gateway asks before it runs an Online workspace (gateway/src/workspaces/fence.ts).
fence=$(python3 -I -c '
import errno, socket, sys
s = socket.socket(); s.settimeout(2)
try: s.connect(("127.0.0.1", int(sys.argv[1]))); print("connected")
except OSError as error: print(errno.errorcode.get(error.errno, "timeout"))' "$SERVICE_PORT")
check "the fence marker answers on 127.0.0.1:$SERVICE_PORT (EHOSTUNREACH, got $fence): the gateway runs Online workspaces only then" '[[ $fence == EHOSTUNREACH ]]'
# The loaded never set must cover what the installer would put in it now: the servers may have moved since. (What
# not_public covers anyway doesn't count: a Docker network created since is no reason to run the installer.)
never_now=$(never_reach 2>/dev/null || true)
never_missing=$(nft -j list set inet workspace_portal never 2>/dev/null | python3 -I -c '
import ipaddress, json, sys
loaded = [ipaddress.ip_network(n) for n in sys.argv[2].split()]
try:
    items = next(entry["set"] for entry in json.load(sys.stdin)["nftables"] if "set" in entry).get("elem", [])
except (ValueError, StopIteration, KeyError):
    items = []
for item in items:
    item = item.get("elem", {}).get("val", item) if isinstance(item, dict) and "elem" in item else item
    if isinstance(item, str):
        loaded.append(ipaddress.ip_network(item))
    elif "prefix" in item:
        loaded.append(ipaddress.ip_network("%s/%s" % (item["prefix"]["addr"], item["prefix"]["len"])))
    elif "range" in item:
        loaded.extend(ipaddress.summarize_address_range(*map(ipaddress.ip_address, item["range"])))
wanted = [ipaddress.ip_network(n) for n in sys.argv[1].split(",") if n]
print(" ".join(str(n) for n in wanted if not any(n.subnet_of(l) for l in loaded)))' "$never_now" "$(not_public_ranges)" 2>/dev/null || echo "(the set could not be read)")
check "firewall set never covers this host's networks and the servers the portal talks to ($never_now)${never_missing:+; missing: $never_missing: run sudo bash deploy/install.sh}" '[[ -n $never_now && -z $never_missing ]]'
resolvers=$(bad_resolvers "$never_now")
check "the resolvers of the Online workspaces, the reader and SearXNG are public, outside the never set${resolvers:+ (not:$resolvers)}" '[[ -z $resolvers ]]'
for key in WORKSPACE_UID_BASE ONLINE_UID_BASE; do
  overlaps=$(subid_overlaps "$key")
  check "no /etc/subuid or /etc/subgid range overlaps the workspace UIDs of $key${overlaps:+ (overlapping:$overlaps)}" '[[ -z $overlaps ]]'
done

# The Online network is a NAT bridge. Its firewall chains are loaded whether or not Online is on.
if ! $ONLINE_ON; then
  echo "(Online workspaces are off: ONLINE_WORKSPACES=off)"
elif docker network inspect "$ONLINE_NETWORK" >/dev/null 2>&1; then
  check "network $ONLINE_NETWORK is not internal, with masquerade (Online workspaces reach the internet through NAT)" \
    '[[ $(net "$ONLINE_NETWORK" "{{.Internal}}") == false && $(option "$ONLINE_NETWORK" enable_ip_masquerade) == true ]]'
  check "network $ONLINE_NETWORK has inter-container traffic disabled" '[[ $(option "$ONLINE_NETWORK" enable_icc) == false ]]'
  check "network $ONLINE_NETWORK uses bridge $ONLINE_BRIDGE (the firewall matches on it)" '[[ $(option "$ONLINE_NETWORK" name) == "$ONLINE_BRIDGE" ]]'
  check "network $ONLINE_NETWORK is $ONLINE_SUBNET with gateway $ONLINE_GW, addresses from $ONLINE_RANGE" \
    '[[ $(net "$ONLINE_NETWORK" "{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}} {{.IPRange}}{{end}}") == "$ONLINE_SUBNET $ONLINE_GW $ONLINE_RANGE" ]]'
  check "network $ONLINE_NETWORK has no IPv6" '[[ $(net "$ONLINE_NETWORK" "{{.EnableIPv6}}") == false ]]'
else
  bad "network $ONLINE_NETWORK exists (the gateway creates it at start while ONLINE_WORKSPACES is on)"
fi
online_out=$(nft list chain inet workspace_portal online_out 2>/dev/null || true)
online_in=$(nft list chain inet workspace_portal online_in 2>/dev/null || true)
online_dns=$(grep 'th dport 53 accept' <<<"$online_out" || true)
check "firewall table allows only $ONLINE_GW tcp/$SERVICE_PORT on the host from the Online network" \
  '[[ $rules == *"iifname \"$ONLINE_BRIDGE\" jump online_to_host"* && $rules == *"ip daddr $ONLINE_GW tcp dport $SERVICE_PORT ct state new accept"* ]]'
check "firewall table lets the Online network out only to DNS at $ONLINE_DNS_1 and $ONLINE_DNS_2 and over TCP to public addresses outside never, IPv4 only" \
  '[[ $rules == *"iifname \"$ONLINE_BRIDGE\" jump online_out"* && $online_out == *"meta nfproto != ipv4 drop"*"ip daddr @never drop"*"ip daddr @not_public drop"*"th dport 53 accept"*"meta l4proto tcp ct state new accept"*"drop"* && $online_dns == *"$ONLINE_DNS_1"* && $online_dns == *"$ONLINE_DNS_2"* ]]'
check "firewall table forwards nothing to the Online network but replies" \
  '[[ $rules == *"oifname \"$ONLINE_BRIDGE\" jump online_in"* && $online_in == *"ct state established,related accept"*"drop"* && $online_in != *"new"* ]]'

echo "== running workspaces"
running=$(docker ps -q --filter label=workspace-portal.workspace=1)
[[ -n $running ]] || echo "(none running; start one and run this again to inspect it)"
seen_users=" "
for id in $running; do
  label() { inspect "$id" "{{index .Config.Labels \"workspace-portal.$1\"}}"; }
  name=$(inspect "$id" '{{.Name}}') user_id=$(label user-id) agent=$(label agent) kind=$(label kind)
  name=${name#/}
  if [[ -z ${KIND_PREFIX[${kind:-?}]-} || ! $user_id =~ ^[1-9][0-9]*$ ]]; then
    bad "$name is a user's Private or Online workspace (labels workspace-portal.kind=$kind, user-id=$user_id)"
    continue
  fi
  own_network=${KIND_NETWORK[$kind]} own_uid=$((KIND_UID_BASE[$kind] + user_id))
  check "$name is user $user_id's only running workspace (one kind at a time)" '[[ $seen_users != *" $user_id "* ]]'
  seen_users+="$user_id "
  check "$name is the $kind workspace of user $user_id (${KIND_PREFIX[$kind]}$user_id)" '[[ $name == "${KIND_PREFIX[$kind]}$user_id" ]]'
  check "$name runs a known agent ($agent)" '[[ -n ${AGENT_NAME[${agent:-?}]-} ]]'
  check "$name runs as its own $kind UID ($own_uid)" '[[ $(inspect "$id" "{{.Config.User}}") == "$own_uid:$own_uid" ]]'
  check "$name: read-only root, all capabilities dropped, no-new-privileges, not privileged" \
    '[[ $(inspect "$id" "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.Privileged}}") == "true [ALL] [no-new-privileges:true] false" ]]'
  check "$name: only on $own_network, no published ports" \
    '[[ $(inspect "$id" "{{.HostConfig.NetworkMode}} {{len .HostConfig.PortBindings}} {{len .NetworkSettings.Networks}}") == "$own_network 0 1" ]]'
  foreign=$(inspect "$id" '{{range .Mounts}}{{println .Source}}{{end}}' | grep -v -e '^$' -e "^$DATA_DIR/users/$user_id/$kind/" || true)
  check "$name mounts only its own user's $kind folders" '[[ -z $foreign ]]'
  if [[ $kind == online ]]; then
    check "$name resolves names only through $ONLINE_DNS_1 and $ONLINE_DNS_2" '[[ $(inspect "$id" "{{.HostConfig.Dns}}") == "[$ONLINE_DNS_1 $ONLINE_DNS_2]" ]]'
    check "$name runs while Online workspaces are on (ONLINE_WORKSPACES)" '$ONLINE_ON'
  fi
done

echo "== workspace folders"
# Ownership is the access model: root's folders hold each kind's, which only that kind's UID may enter.
owner_mode() { stat -c '%u:%g %a' "$1" 2>/dev/null || echo missing; }
check "users/ is root's, mode 0711" '[[ $(owner_mode "$DATA_DIR/users") == "0:0 711" ]]'
for dir in "$DATA_DIR"/users/*; do
  [[ -e $dir ]] || continue
  user_id=${dir##*/}
  if [[ ! -d $dir || ! $user_id =~ ^[1-9][0-9]*$ ]]; then
    bad "users/$user_id is not a user's folder (users/<id>)"
    continue
  fi
  check "users/$user_id is root's, mode 0711" '[[ $(owner_mode "$dir") == "0:0 711" ]]'
  others=$(find "$dir" -mindepth 1 -maxdepth 1 ! -name private ! -name online -printf ' %f')
  check "users/$user_id holds nothing but private/ and online/${others:+ (also:$others)}" '[[ -z $others ]]'
  for kind in private online; do
    [[ -e $dir/$kind ]] || continue
    uid=$((KIND_UID_BASE[$kind] + user_id))
    check "users/$user_id/$kind is root's, mode 0711" '[[ $(owner_mode "$dir/$kind") == "0:0 711" ]]'
    for sub in home workspace; do
      [[ ! -e $dir/$kind/$sub ]] || check "users/$user_id/$kind/$sub belongs to the $kind UID $uid alone, mode 0700" '[[ $(owner_mode "$dir/$kind/$sub") == "$uid:$uid 700" ]]'
    done
    [[ ! -e $dir/$kind/system ]] || check "users/$user_id/$kind/system is root's, mode 0755" '[[ $(owner_mode "$dir/$kind/system") == "0:0 755" ]]'
  done
done

# "address port label" of TCP targets no workspace of either kind may reach.
closed=("$GW 22 host SSH via the bridge" "$GW $WEB_PORT the portal via the bridge" "$GW $CONTROL_PORT the gateway control API"
  "$GW ${AGENT_PORTS%-*} a workspace port via the bridge" "$GW ${PREVIEW_PORTS%-*} a preview port via the bridge"
  "1.1.1.1 443 the internet" "8.8.8.8 53 public DNS over TCP" "$GW $READER_PORT the page reader via the bridge")
for address in $HOST_ADDRESSES; do
  [[ $address == "$GW" ]] || closed+=("$address 22 SSH on host address $address" "$address $PORTAL_PORT the portal on host address $address")
done
# The servers that are the gateway's to talk to, at every address their names have now. One on this host is tried
# through the bridge; host_local keeps its port for the Online bridge.
host_local=()
upstream() { # url label
  local host port address
  host=$(url_host "$1") port=$(url_port "$1")
  case $host in
    localhost | 127.* | "$(host_ip)")
      closed+=("$GW $port $2 directly")
      host_local+=("$port $2")
      ;;
    *) for address in $(url_ipv4s "$1"); do closed+=("$address $port $2 directly"); done ;;
  esac
}
upstream "$(env_get LLM_UPSTREAM_URL)" "the LLM server"
upstream "$(searxng_url)" SearXNG
for hostd in PORTAL LLM; do
  url=$(env_get "HOSTD_${hostd}_URL")
  if [[ -n $(env_get "HOSTD_${hostd}_TOKEN") && -n $url && ${url,,} != off ]]; then upstream "$url" "the $hostd portal-hostd"; fi
done
[[ -z $ROUTER ]] || closed+=("$ROUTER 80 the router")
[[ -z $READER_GW ]] || closed+=("$READER_GW $READER_PORT the page reader on its own bridge")
[[ -z $READER_IP ]] || closed+=("$READER_IP 8080 the page reader container")
searxng_is_builtin || closed+=("$GW $SEARXNG_PORT the built-in SearXNG via the bridge")
[[ -z $SEARXNG_GW ]] || closed+=("$SEARXNG_GW $SEARXNG_PORT the built-in SearXNG on its own bridge")
[[ -z $SEARXNG_IP ]] || closed+=("$SEARXNG_IP 8080 the built-in SearXNG container")
# "address port" of every running workspace on a network; every agent's port for an agent this script doesn't know.
workspace_peers() { # network
  local id ip agent port
  for id in $(docker ps -q --filter label=workspace-portal.workspace=1); do
    ip=$(inspect "$id" "{{with index .NetworkSettings.Networks \"$1\"}}{{.IPAddress}}{{end}}")
    agent=$(inspect "$id" '{{index .Config.Labels "workspace-portal.agent"}}')
    [[ -z $ip ]] || for port in ${AGENT_PORT[${agent:-?}]:-${AGENT_PORT[*]}}; do echo "$ip $port"; done
  done
}
mapfile -t private_peers < <(workspace_peers "$NETWORK")
mapfile -t online_peers < <(workspace_peers "$ONLINE_NETWORK")
closed+=("${private_peers[@]/%/ another workspace}")
private_closed=("$ONLINE_GW $SERVICE_PORT the Online service listener" "$GW ${ONLINE_AGENT_PORTS%-*} an Online workspace port via the bridge"
  "$GW ${ONLINE_PREVIEW_PORTS%-*} an Online preview port via the bridge" "${online_peers[@]/%/ an Online workspace}")

# Runs in a throwaway workspace container (KIND private or online) and inside the reader and SearXNG (KIND inside):
# what KIND must and must not reach, and what the container runs with.
PROBE=$(cat <<'PY'
import errno, http.client, os, re, socket, struct, subprocess
kind, gw, router, other_dns = (os.environ.get(key, "") for key in ("KIND", "GW", "ROUTER", "OTHER_DNS"))
def check(ok, what): print(("PASS  " if ok else "FAIL  ") + what)
def expect(wanted, got, what):
    print({(False, False): "PASS  blocked: ", (False, True): "FAIL  REACHES ", (True, True): "PASS  reaches ", (True, False): "FAIL  cannot reach "}[wanted, got] + what)
def tcp(host, port, family=socket.AF_INET):
    try:
        with socket.socket(family) as s:
            s.settimeout(3); s.connect((host, int(port))); return True
    except OSError: return False
# UDP and ICMP have no handshake: a real request, and a wait for the answer. (No ICMP socket at all is no answer.)
def answers(host, port, request, protocol=0):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM, protocol) as s:
            s.settimeout(2); s.sendto(request, (host, port)); s.recvfrom(512); return True
    except OSError: return False
DNS = struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + b"\x07example\x03com\x00" + struct.pack(">HH", 1, 1)
def targets(name):
    for line in os.environ.get(name, "").splitlines():
        host, port, label = line.split(None, 2)
        yield host, port, f"{label} ({host}:{port})"

for host, port, what in targets("OPEN"): expect(True, tcp(host, port), what)
for host, port, what in targets("CLOSED"): expect(False, tcp(host, port), what)
for server in filter(None, [other_dns, gw, router] + ["1.1.1.1", "8.8.8.8"] * (kind == "private")):
    expect(False, answers(server, 53, DNS), f"DNS over UDP at {server}:53")
for host in filter(None, [gw, router, "1.1.1.1"]):
    expect(False, answers(host, 0, struct.pack(">BBHHH", 8, 0, 0, 0, 1) + b"probe", socket.IPPROTO_ICMP), f"ICMP echo to {host}")
try: socket.getaddrinfo("example.com", 443, socket.AF_UNSPEC if kind == "private" else socket.AF_INET); resolves = True
except OSError: resolves = False
check(resolves == (kind != "private"), "no DNS for internet names" if kind == "private" else "resolves public names (example.com)")
if kind == "online":
    expect(True, answers(os.environ["DNS_1"], 53, DNS), f"DNS over UDP at its own resolver {os.environ['DNS_1']}:53")
    expect(False, answers("162.159.200.1", 123, b"\x1b" + 47 * b"\0"), "UDP other than DNS (NTP at 162.159.200.1:123)")
    expect(False, tcp("2606:4700:4700::1111", 443, socket.AF_INET6), "the internet over IPv6 ([2606:4700:4700::1111]:443)")
status = open("/proc/self/status").read()
if kind != "inside":
    ipv6 = [line.split()[-1] for line in open("/proc/net/if_inet6") if line.split()[-1] != "lo"]
    check(not ipv6, "no IPv6 address on any interface" + (": " + " ".join(ipv6) if ipv6 else ""))
    try:
        connection = http.client.HTTPConnection(gw, int(os.environ["SERVICE_PORT"]), timeout=5)
        connection.request("GET", "/llm/v1/models")
        code = connection.getresponse().status
    except (OSError, http.client.HTTPException): code = "no answer"
    check(code == 403, f"the service API refuses callers that are not workspaces (HTTP 403, got {code})")
    check(re.search(r"^NoNewPrivs:\s*1", status, re.M), "no-new-privileges")
    setuid = subprocess.run(["find", "/", "-xdev", "-perm", "/6000", "-type", "f"], capture_output=True, text=True).stdout.split()
    check(not setuid, "no setuid or setgid binaries" + (": " + " ".join(setuid) if setuid else ""))
    check(not any(os.path.exists(path) for path in ("/var/run/docker.sock", "/run/docker.sock")), "no Docker socket inside")
    check(not (os.path.isdir("/srv") and os.listdir("/srv")), "no host data in /srv")
check(os.getuid() != 0, f"runs as uid {os.getuid()}, not root")
check(int(re.search(r"^CapEff:\s*(\w+)", status, re.M)[1], 16) == 0, "no capabilities")
# EROFS and nothing else: a writable root refuses this user too, with "permission denied".
try: open("/usr/probe", "w").close(); error = 0
except OSError as refusal: error = refusal.errno
check(error == errno.EROFS, "read-only root filesystem")
print("probe: done")
PY
)

# Prints a probe's output and counts its PASS and FAIL lines.
tally() { # where output
  grep -vx 'probe: done' <<<"$2" || true
  pass=$((pass + $(grep -c '^PASS' <<<"$2" || true)))
  fail=$((fail + $(grep -c '^FAIL' <<<"$2" || true)))
  grep -qx 'probe: done' <<<"$2" || bad "the probe in $1 ran to the end (see above)"
}
# A public resolver that is not one of the two of ONLINE_DNS, READER_DNS or SEARXNG_DNS.
other_resolver() { # settings-prefix
  local candidate
  for candidate in 8.8.8.8 208.67.222.222 9.9.9.10; do
    [[ $candidate == "$(env_get "$1_1")" || $candidate == "$(env_get "$1_2")" ]] || { echo "$candidate"; return; }
  done
}
NAME="wp-isolation-probe-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
# The probe as a workspace of a kind runs, from every enabled agent's image: that kind's network, a UID in its range
# that no user has, the same restrictions.
workspace_probe() { # kind network uid-base [docker run options...]
  local kind=$1 network=$2 uid=$(($3 + 99999)) agent image
  shift 3
  for agent in "${ENABLED_AGENTS[@]}"; do
    image=$(workspace_image "$agent")
    echo "-- from the ${AGENT_NAME[$agent]} image ($image), as ${kind^} workspaces run"
    tally "$image" "$(docker run --rm --pull never --name "$NAME" --network "$network" --user "$uid:$uid" \
      --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m --cap-drop ALL --security-opt no-new-privileges \
      --pids-limit 128 --memory 256m -e KIND="$kind" -e SERVICE_PORT="$SERVICE_PORT" -e ROUTER="$ROUTER" "$@" \
      --entrypoint python3 "$image" -I -c "$PROBE" 2>&1 || true)"
  done
}

echo "== reachability from a Private workspace"
workspace_probe private "$NETWORK" "$UID_BASE" -e GW="$GW" -e OPEN="$GW $SERVICE_PORT the gateway service port (model and search)" \
  -e CLOSED="$(printf '%s\n' "${closed[@]}" "${private_closed[@]}")"

echo "== reachability from an Online workspace"
if ! $ONLINE_ON; then
  echo "(off: ONLINE_WORKSPACES=off)"
elif ! docker network inspect "$ONLINE_NETWORK" >/dev/null 2>&1; then
  bad "network $ONLINE_NETWORK exists, to probe from"
else
  # What Private may not reach, but for the public internet (the firewall's never set stays closed at public addresses
  # too), and the host's ports on the Online bridge, the Private listener and the other Online workspaces.
  online_closed=("$GW $SERVICE_PORT the Private service listener" "$ONLINE_GW 22 host SSH via the Online bridge"
    "$ONLINE_GW $WEB_PORT the portal via the Online bridge" "$ONLINE_GW $CONTROL_PORT the gateway control API via the Online bridge"
    "$ONLINE_GW ${AGENT_PORTS%-*} a Private workspace port via the Online bridge"
    "$ONLINE_GW ${ONLINE_AGENT_PORTS%-*} an Online workspace port via the Online bridge"
    "$ONLINE_GW ${PREVIEW_PORTS%-*} a Private preview port via the Online bridge"
    "$ONLINE_GW ${ONLINE_PREVIEW_PORTS%-*} an Online preview port via the Online bridge"
    "$ONLINE_GW $READER_PORT the page reader via the Online bridge" "$ONLINE_GW $SEARXNG_PORT SearXNG via the Online bridge"
    "${online_peers[@]/%/ another Online workspace}")
  for target in "${closed[@]}"; do
    [[ $target == *"the internet" || $target == *"public DNS over TCP" ]] || online_closed+=("$target")
  done
  for target in "${host_local[@]}"; do online_closed+=("$ONLINE_GW $target via the Online bridge"); done
  workspace_probe online "$ONLINE_NETWORK" "$ONLINE_UID_BASE" --dns "$ONLINE_DNS_1" --dns "$ONLINE_DNS_2" --dns-search . \
    -e GW="$ONLINE_GW" -e DNS_1="$ONLINE_DNS_1" -e OTHER_DNS="$(other_resolver ONLINE_DNS)" -e CLOSED="$(printf '%s\n' "${online_closed[@]}")" \
    -e OPEN="$(printf '%s\n' "$ONLINE_GW $SERVICE_PORT its gateway service port (model and search)" "1.1.1.1 443 the public internet" \
      "1.1.1.1 853 a public port other than 80 and 443" "github.com 22 a public host by name, on another port")"
fi

# What the firewall must keep the reader and SearXNG from, asked from inside each as if its own checks had failed.
inside=("$GW $SERVICE_PORT the gateway service port" "$GW 22 host SSH via the workspace bridge"
  "$ONLINE_GW $SERVICE_PORT the Online service listener" "1.1.1.1 22 a public address on another port")
for address in $HOST_ADDRESSES; do
  inside+=("$address 22 SSH on host address $address" "$address $PORTAL_PORT the portal on host address $address" "$address $CONTROL_PORT the gateway control API on $address")
done
[[ -z $ROUTER ]] || inside+=("$ROUTER 80 the router" "$ROUTER 53 DNS on the router")
for target in "${closed[@]}" "${private_closed[@]}"; do
  case $target in *" directly" | *" another workspace" | *" an Online workspace") inside+=("$target") ;; esac
done
inside_probe() { # who container dns-settings-prefix label-of-more-closed-targets
  local other more
  other=$(other_resolver "$3")
  mapfile -t more < <(printf '%s\n' "${closed[@]}" | grep -F "$4" || true)
  tally "the $1 container" "$(docker exec -e KIND=inside -e OTHER_DNS="$other" -e OPEN="1.1.1.1 443 the public internet" \
    -e CLOSED="$(printf '%s\n' "${inside[@]}" "${more[@]}" "$other 53 a DNS server other than its own")" "$2" python3 -I -c "$PROBE" 2>&1 || true)"
}
# The restrictions both run under, and their firewall chains: the jumps from the bridge, and the drops of the never
# set and of everything not public before ports 80 and 443 are let through.
locked_down() { # who container user network bridge subnet port chain-prefix
  local who=$1 id=$2 user=$3 network=$4 bridge=$5 subnet=$6 port=$7 chain=$8 out
  check "$who: read-only root, all capabilities dropped, no-new-privileges, not privileged" \
    '[[ $(inspect "$id" "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.Privileged}}") == "true [ALL] [no-new-privileges:true] false" ]]'
  check "$who runs as an unprivileged user ($(inspect "$id" '{{.Config.User}}'))" '[[ $(inspect "$id" "{{.Config.User}}") == "$user" ]]'
  check "$who has no volumes and no Docker socket" '[[ $(inspect "$id" "{{len .Mounts}}") == 0 ]]'
  check "$who is published on the loopback interface only (127.0.0.1:$port)" '[[ $(docker port "$id" 8080/tcp) == "127.0.0.1:$port" ]]'
  check "$who is on its own network only ($network)" '[[ $(inspect "$id" "{{range \$name, \$_ := .NetworkSettings.Networks}}{{\$name}} {{end}}") == "$network " ]]'
  check "$who network is bridge $bridge, $subnet, without IPv6" \
    '[[ "$(option "$network" name) $(net "$network" "{{range .IPAM.Config}}{{.Subnet}}{{end}} {{.EnableIPv6}}")" == "$bridge $subnet false" ]]'
  out=$(nft list chain inet workspace_portal "${chain}_out" 2>/dev/null || true)
  check "firewall table keeps $who off the host, the never set and private networks" \
    '[[ $rules == *"iifname \"$bridge\" jump ${chain}_to_host"* && $rules == *"iifname \"$bridge\" jump ${chain}_out"* && $rules == *"oifname \"$bridge\" jump ${chain}_in"* && $out == *"ip daddr @never drop"*"ip daddr @not_public drop"*"tcp dport { 80, 443 } accept"*"drop"* ]]'
}

echo "== page reader"
if ! $READER_ON; then
  echo "(off: READER_URL=off)"
elif [[ -z $READER_ID ]]; then
  bad "the reader container is running (start it: sudo bash deploy/install.sh)"
else
  locked_down "the reader" "$READER_ID" 10002:10002 workspace-portal-reader "$READER_BRIDGE" "$READER_SUBNET" "$READER_PORT" reader
  reader_env=$(inspect "$READER_ID" '{{range .Config.Env}}{{println .}}{{end}}')
  check "the reader holds no secret (no key, password or token in its environment)" '! grep -qiE "secret|password|api_key|authorization|token" <<<"$reader_env"'
  # What the reader itself refuses: each must come back as a refusal, never as a page.
  refused=("http://127.0.0.1/" "http://localhost/" "http://127.1/" "http://2130706433/" "http://0x7f.0.0.1/" "http://[::1]/"
    "http://[::ffff:127.0.0.1]/" "http://169.254.169.254/latest/meta-data/" "http://$GW:$SERVICE_PORT/llm/v1/models"
    "http://100.100.100.100/" "http://example.com:22/" "http://user:pw@example.com/" "file:///etc/passwd" "gopher://example.com/"
    "http://portal.local/" "http://router/" "$(env_get LLM_UPSTREAM_URL)/v1/models" "$(searxng_builtin_url)/search?q=x&format=json")
  searxng_is_builtin || refused+=("$(searxng_url)/search?q=x&format=json")
  HOST_IP=$(host_ip || true)
  [[ -z $HOST_IP ]] || refused+=("http://$HOST_IP:$WEB_PORT/" "http://$HOST_IP/")
  [[ -z $ROUTER ]] || refused+=("http://$ROUTER/")
  [[ -z $READER_GW ]] || refused+=("http://$READER_GW/")
  [[ -z $SEARXNG_IP ]] || refused+=("http://$SEARXNG_IP:8080/")
  ask_reader() { # url -> the reader's JSON answer
    python3 -I -c 'import json, sys; print(json.dumps({"url": sys.argv[1]}))' "$1" |
      curl -s --max-time 40 -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$READER_PORT/read" || true
  }
  for url in "${refused[@]}"; do
    answer=$(ask_reader "$url")
    check "the reader refuses $url" '[[ $answer =~ \"ok\":\ ?false && $answer =~ \"code\":\ ?\"(blocked|bad_url)\" ]]'
  done
  answer=$(ask_reader "https://example.com/")
  check "the reader reads a public page (https://example.com/)" '[[ $answer =~ \"ok\":\ ?true && $answer == *"Example Domain"* ]]'
  inside_probe reader "$READER_ID" READER_DNS "the built-in SearXNG"
fi

echo "== search engine (SearXNG)"
if [[ -z $SEARXNG_ID ]]; then
  bad "the searxng container is running (start it: sudo bash deploy/install.sh)"
else
  locked_down SearXNG "$SEARXNG_ID" 977:977 workspace-portal-searxng "$SEARXNG_BRIDGE" "$SEARXNG_SUBNET" "$SEARXNG_PORT" searxng
  searxng_env=$(inspect "$SEARXNG_ID" '{{range .Config.Env}}{{println .}}{{end}}')
  check "SearXNG holds no secret but its own key (nothing of the portal's, the LLM's or the admin's)" \
    '! grep -iE "secret|password|api_key|authorization|token" <<<"$searxng_env" | grep -qv "^SEARXNG_SECRET="'
  searxng_key=$(sed -n 's/^SEARXNG_SECRET=//p' <<<"$searxng_env")
  check "SearXNG has a key of its own (not empty, not the example key)" '[[ -n $searxng_key && $searxng_key != ultrasecretkey ]]'
  check "SearXNG answers on 127.0.0.1:$SEARXNG_PORT" 'curl -fsS --max-time 5 "http://127.0.0.1:$SEARXNG_PORT/healthz" >/dev/null'
  # An empty query asks no search engine: 400 when the JSON format is allowed, 403 when it is not.
  check "SearXNG allows the JSON format the gateway asks for" \
    '[[ $(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$SEARXNG_PORT/search?q=&format=json") == 400 ]]'
  # What the gateway container was started with, against what .env says now.
  gateway_env=""
  [[ -z $GATEWAY_ID ]] || gateway_env=$(inspect "$GATEWAY_ID" '{{range .Config.Env}}{{println .}}{{end}}')
  gateway_searxng=$(sed -n 's/^SEARXNG_URL=//p' <<<"$gateway_env")
  check "the gateway searches through $(searxng_url), as .env says" '[[ ${gateway_searxng%/} == "$(searxng_url)" ]]'
  # Exa first means that searches leave this server for a company: only when .env says so.
  exa=off gateway_exa=off
  ! exa_enabled || exa=on
  ! grep -qiE '^EXA_SEARCH=(true|on|yes|1)$' <<<"$gateway_env" || gateway_exa=on
  check "the gateway asks Exa before SearXNG: $exa, as .env says (EXA_SEARCH)" '[[ $gateway_exa == "$exa" ]]'
  if searxng_is_builtin; then
    config=$(curl -fsS --max-time 5 "http://127.0.0.1:$SEARXNG_PORT/config" || true)
    engines() { # all | enabled: the engines SearXNG has loaded, or those of them it asks on every search
      python3 -I -c 'import json, sys; print("\n".join(e["name"] for e in json.load(sys.stdin)["engines"] if sys.argv[1] == "all" or e["enabled"]))' "$1" <<<"$config" 2>/dev/null || true
    }
    loaded=$(engines all)
    always=$(engines enabled | paste -sd, | sed 's/,/, /g')
    check "SearXNG asks at least one engine on every search (${always:-none})" '[[ -n $always ]]'
    if ! env_is SEARCH_FALLBACK_ENGINES none; then
      IFS=, read -r -a fallback <<<"$(env_get SEARCH_FALLBACK_ENGINES)"
      for engine in "${fallback[@]}"; do
        read -r engine <<<"$engine"
        [[ -z $engine ]] || check "SearXNG has loaded the fallback engine $engine (SEARCH_FALLBACK_ENGINES)" 'grep -qxF "$engine" <<<"$loaded"'
      done
    fi
  else
    echo "(the gateway searches through $(searxng_url), not through this SearXNG)"
    check "the SearXNG at $(searxng_url) answers" 'searxng_answers "$(searxng_url)"'
  fi
  inside_probe SearXNG "$SEARXNG_ID" SEARXNG_DNS "the page reader"
fi

echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
